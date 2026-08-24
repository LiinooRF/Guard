/**
 * La traza cuando el telefono esta en el bolsillo.
 *
 * El muestreo normal (`traza.ts`) vive en el WebView: con la pantalla apagada
 * Android lo congela y deja de medir. En terreno eso significa que el guardia
 * camina la ronda entera sin registrar nada y solo aparece una posicion cuando
 * saca el telefono para escanear — que fue exactamente lo que se vio en
 * Janssen: 38 posiciones en dos rondas completas, y la sensacion de que "el
 * GPS solo se usa al escanear".
 *
 * Aca el muestreo lo hace el SISTEMA, no la aplicacion: Android mantiene vivo
 * un servicio en primer plano —con su notificacion permanente, que no se puede
 * ocultar y que ademas le dice al guardia cuando se le esta registrando— y le
 * entrega posiciones a esta tarea aunque el WebView duerma.
 *
 * Las posiciones se suben DIRECTO desde aca, sin pasar por el portal, porque
 * el portal puede no existir en ese momento. La sesion viaja en las cookies,
 * que el WebView y el `fetch` nativo comparten en Android.
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

const TAREA = 'sentrycore-traza-en-segundo-plano';

/**
 * A donde subir. Se guarda en memoria del proceso: si Android mata el proceso
 * tambien detiene el servicio, asi que no hay estado que sobreviva sin destino.
 */
let destino: { patrolId: string; apiBaseUrl: string } | null = null;

if (!TaskManager.isTaskDefined(TAREA)) {
  TaskManager.defineTask(TAREA, async ({ data, error }) => {
    if (error || !destino) return;
    const posiciones = (data as { locations?: Location.LocationObject[] } | null)?.locations ?? [];
    if (posiciones.length === 0) return;

    const points = posiciones.map((posicion) => ({
      recordedAt: new Date(posicion.timestamp).toISOString(),
      latitude: posicion.coords.latitude,
      longitude: posicion.coords.longitude,
      ...(posicion.coords.accuracy === null || posicion.coords.accuracy === undefined
        ? {}
        : { accuracyM: posicion.coords.accuracy }),
    }));

    try {
      await fetch(`${destino.apiBaseUrl}/geo/patrols/${destino.patrolId}/track`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          /*
           * El servidor exige probar que la mutacion nacio en nuestra interfaz
           * (`csrf-origin.middleware`). Aca no hay pagina que ponga el Origin
           * sola, y la peticion SI lleva cookies, asi que tampoco entra por la
           * puerta de cliente nativo. Se declara el origen del portal, que es
           * de donde salen estas posiciones.
           */
          Origin: new URL(destino.apiBaseUrl).origin,
          'X-SentryCore-Request': 'web',
        },
        body: JSON.stringify({ points }),
      });
    } catch (fallo) {
      console.warn('[traza-fondo] fallo la subida:', String(fallo));
      /*
       * Una posicion perdida es un hueco en el mapa, no un error que valga
       * despertar a nadie: el proximo tick reintenta y el servidor deduplica
       * por `recordedAt`. Reintentar aca, dentro de una tarea del sistema con
       * tiempo contado, arriesga que Android mate el servicio entero.
       */
    }
  });
}

/** Arranca el muestreo del sistema. Sin destino no hace nada: no sabria adonde subir. */
export async function iniciarTrazaEnSegundoPlano(
  intervalSeconds: number,
  aDonde: { patrolId?: string; apiBaseUrl?: string },
): Promise<void> {
  if (!aDonde.patrolId || !aDonde.apiBaseUrl) {
    // Diagnostico util en terreno: si la traza de fondo no arranca, esto dice
    // por que sin tener que adivinar entre permiso, destino o servicio.
    console.warn('[traza-fondo] sin destino del portal: no se mide en segundo plano');
    return;
  }

  // El permiso de segundo plano se pide aparte del de primer plano. Si no
  // esta, no se insiste con un dialogo: se sigue con el muestreo de pantalla
  // encendida, que es lo que habia antes de esto.
  const permiso = await Location.getBackgroundPermissionsAsync();
  if (permiso.status !== 'granted') {
    console.warn('[traza-fondo] sin permiso de segundo plano:', permiso.status);
    return;
  }

  /*
   * Se acepta una base relativa ("/api") aunque el portal deberia mandarla
   * absoluta: un portal viejo manda lo que tiene, y aca no hay pagina contra
   * la cual resolverla. El origen sale del dominio con el que se compilo el
   * shell, que es el unico portal que este APK sabe abrir.
   */
  const portal = (process.env.EXPO_PUBLIC_WEB_URL ?? '').replace(/\/+$/, '');
  const base = aDonde.apiBaseUrl.startsWith('http')
    ? aDonde.apiBaseUrl
    : `${portal}${aDonde.apiBaseUrl}`;
  if (!base.startsWith('http')) {
    console.warn('[traza-fondo] no se pudo armar una direccion absoluta:', aDonde.apiBaseUrl);
    return;
  }

  destino = { patrolId: aDonde.patrolId, apiBaseUrl: base };
  await detenerTrazaEnSegundoPlano();
  await Location.startLocationUpdatesAsync(TAREA, {
    accuracy: Location.Accuracy.High,
    timeInterval: Math.max(intervalSeconds, 15) * 1000,
    // Por reloj y no por movimiento: un guardia parado en un acceso tiene que
    // seguir apareciendo en el mapa.
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'Ronda en curso',
      notificationBody: 'Se registra tu recorrido mientras dure la ronda.',
      notificationColor: '#2f4bff',
    },
  });
}

export async function detenerTrazaEnSegundoPlano(): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(TAREA)) {
      await Location.stopLocationUpdatesAsync(TAREA);
    }
  } catch {
    // Detener algo que no corria no es un fallo.
  }
}
