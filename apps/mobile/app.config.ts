import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ExpoConfig } from 'expo/config';

/**
 * Configuracion del shell Android de VoxIA Control.
 *
 * Android es la unica plataforma: iOS esta fuera de alcance (CLAUDE.md,
 * "Decisiones ya tomadas"). Por eso no hay bloque `ios` ni assets de iOS.
 */

/**
 * `EAS_BUILD_PROFILE` lo setea EAS durante el build. `NODE_ENV` lo setea la CI
 * en el paso "Validar configuracion Android de produccion". Se miran los dos
 * porque cada uno cubre un hueco del otro:
 *
 * - Solo con NODE_ENV: un `eas build --profile production` real NO garantiza
 *   NODE_ENV=production al evaluar la config, y saldria un AAB con trafico en
 *   claro habilitado. Eso permite degradar el portal a HTTP con un MITM en la
 *   wifi del recinto — justo la red menos confiable del escenario.
 * - Solo con EAS_BUILD_PROFILE: la CI no valida nada porque nunca corre dentro
 *   de EAS.
 */
const perfilEas = process.env.EAS_BUILD_PROFILE ?? '';
const perfilDeTienda = perfilEas === 'production' || perfilEas === 'preview';
const paraTienda = perfilDeTienda || process.env.NODE_ENV === 'production';

const assets = join(__dirname, 'assets');

/**
 * Los PNG se exportan desde los SVG maestros (ver `assets/README.md`) y se
 * commitean; este repositorio no los genera en build.
 *
 * Si falta un asset, Expo NO falla: sustituye en silencio por el icono por
 * defecto de Expo. Un AAB con el logo de Expo subido a Play Store se descubre
 * cuando la ficha ya esta publicada, asi que los perfiles que se reparten
 * (`preview` y `production`) se caen con ruido. Todo lo demas —typecheck,
 * `expo config` de la CI, arranque local, build de `development`— solo avisa,
 * para no bloquear a quien no toco los assets.
 */
function asset(nombre: string): string | undefined {
  const ruta = join(assets, nombre);
  if (existsSync(ruta)) {
    return `./assets/${nombre}`;
  }
  const mensaje =
    `[voxia] falta ./assets/${nombre}. Exportalo desde el SVG maestro: ` +
    `ver apps/mobile/assets/README.md`;
  if (perfilDeTienda) {
    throw new Error(mensaje);
  }
  console.warn(mensaje);
  return undefined;
}

/** Identidad visual de la plataforma (#114). Espeja `apps/mobile/src/theme.ts`. */
const MARCA = '#1f3b73';
const SPLASH_FONDO = '#1f3b73';
const ADAPTATIVO_FONDO = '#1f3b73';

const config: ExpoConfig = {
  name: 'VoxIA Control',
  slug: 'voxia-control',
  /**
   * versionName visible en Play Store. Se sube a mano y con criterio semantico.
   * El versionCode NO se declara aca: lo administra EAS (`appVersionSource:
   * "remote"` en eas.json). Ponerlo a mano vuelve a reintroducir el conflicto
   * "versionCode ya usado" al subir a Play.
   */
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  scheme: 'voxia',
  primaryColor: MARCA,
  icon: asset('icon.png'),
  assetBundlePatterns: ['assets/**/*'],
  plugins: [
    'expo-dev-client',

    [
      'expo-splash-screen',
      {
        // Desde SDK 54 el splash se configura por plugin; la clave `splash` de
        // nivel superior ya no se lee.
        image: asset('splash-icon.png'),
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: SPLASH_FONDO,
      },
    ],

    [
      'expo-build-properties',
      {
        android: {
          // Trafico en claro SOLO fuera de builds de tienda: en desarrollo el
          // portal corre en http://10.0.2.2:13000.
          usesCleartextTraffic: !paraTienda,
        },
      },
    ],

    [
      'expo-camera',
      {
        cameraPermission:
          'VoxIA Control usa la camara para fotografiar el estado de los accesos criticos durante la ronda.',
        // Sin audio: la evidencia es una foto fija. Dejarlo en true agrega
        // RECORD_AUDIO al manifiesto y convierte la revision de Play en una
        // conversacion sobre grabacion de audio en el trabajo que no queremos
        // tener y que ademas seria falsa.
        recordAudioAndroid: false,
      },
    ],

    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'VoxIA Control registra tu ubicacion durante el turno para acreditar que la ronda se recorrio en terreno.',
        locationWhenInUsePermission:
          'VoxIA Control registra tu ubicacion al escanear cada punto de control.',
        // Android 14 exige declarar el tipo de servicio en primer plano y el
        // permiso FOREGROUND_SERVICE_LOCATION. El plugin agrega ambos.
        isAndroidForegroundServiceEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
      },
    ],

    // Plugin local: uses-feature. Ver plugins/with-android-manifest-extras.js.
    './plugins/with-android-manifest-extras',
  ],

  android: {
    /**
     * OJO — el `applicationId` es IRREVERSIBLE una vez publicada la ficha en
     * Play Store: cambiarlo significa ficha nueva, instalaciones desde cero y
     * migrar a los guardias a mano. Decidirlo ANTES de la primera subida.
     *
     * El andamiaje traia `cl.voxia.control`; esto lo cambia a la convencion de
     * la empresa. Cambiarlo hoy es gratis (nada publicado); manana no.
     */
    package: 'com.voxtilabs.voxiacontrol',

    adaptiveIcon: {
      foregroundImage: asset('adaptive-icon-foreground.png'),
      // Icono tematico de Android 13+: el launcher lo recolorea con el fondo
      // del sistema. Sin monochrome, el icono queda como un cuadrado plano
      // entre los demas ya adaptados.
      monochromeImage: asset('adaptive-icon-monochrome.png'),
      backgroundColor: ADAPTATIVO_FONDO,
    },

    /**
     * PERMISOS — uno por uno, con la razon de producto que lo justifica.
     *
     * Regla de la que no nos movemos: cada permiso extra es una pregunta mas en
     * la revision de Play y un motivo mas de rechazo. Si no hay una funcion del
     * producto que lo exija hoy, no se declara "por si acaso".
     */
    permissions: [
      // INTERNET — todo el producto vive en el portal web dentro del WebView.
      // Expo lo agrega solo; se declara explicito para que la lista se lea
      // completa sin abrir el manifiesto generado.
      'android.permission.INTERNET',

      // ACCESS_NETWORK_STATE — el puente informa al portal si hay conexion
      // (mensaje `connectivity.state`). Las rondas ocurren en subterraneos sin
      // señal: el portal necesita saber cuando esta encolando offline en vez de
      // fingir que guardo. Es permiso normal, no pide dialogo.
      'android.permission.ACCESS_NETWORK_STATE',

      // NFC — el nucleo del producto. Cada punto de control tiene una etiqueta
      // NFC pegada y tocarla es lo que acredita la presencia fisica del
      // guardia. La Web NFC API (NDEFReader) NO esta expuesta dentro del
      // WebView de Android, asi que el escaneo es nativo si o si.
      'android.permission.NFC',

      // CAMERA — foto del estado de la puerta en los accesos criticos, y
      // lectura del QR de respaldo cuando la etiqueta NFC esta dañada.
      // La camara se abre SIEMPRE en captura en vivo: no se declara ningun
      // permiso de galeria (ver blockedPermissions) porque poder elegir un
      // archivo permite reusar la misma foto todo el mes y la evidencia deja de
      // valer.
      'android.permission.CAMERA',

      // ACCESS_FINE_LOCATION — el GPS del escaneo. Sin coordenada no se puede
      // distinguir "toco la etiqueta en el punto" de "se llevo las etiquetas a
      // la caseta", que es el fraude conocido del rubro. La precision fina es
      // necesaria porque los puntos de un mismo recinto estan a decenas de
      // metros: `gpsValidationRadiusM` parte en 50 m y la ubicacion aproximada
      // (~1-3 km) no discrimina nada a esa escala.
      'android.permission.ACCESS_FINE_LOCATION',

      // ACCESS_COARSE_LOCATION — obligatorio declararlo junto con FINE. Desde
      // Android 12 el usuario puede conceder solo ubicacion aproximada, y si el
      // manifiesto no la declara el sistema ignora la solicitud de precision.
      'android.permission.ACCESS_COARSE_LOCATION',

      /**
       * ACCESS_BACKGROUND_LOCATION — EL DELICADO. Es la causa mas frecuente de
       * rechazo en Play Store y hay que tratarlo como un tramite, no como una
       * linea de configuracion.
       *
       * POR QUE SE NECESITA: la traza del recorrido (`patrol_tracks`) se
       * muestrea cada `gpsTrackIntervalSeconds` (60 s por defecto) mientras la
       * ronda esta EN CURSO. Un guardia recorre 8 horas con el telefono en el
       * bolsillo y la pantalla apagada: en cuanto la pantalla se apaga el
       * WebView deja de ejecutar y la traza se corta. Sin traza continua el
       * informe solo prueba puntos sueltos, no un recorrido, y el producto
       * entero —acreditar que la ronda se hizo— deja de sostenerse.
       *
       * POR QUE NO ALCANZA EL PRIMER PLANO: exigir pantalla encendida durante
       * toda la ronda es irreal (bateria, guantes, oscuridad) y ademas
       * incentiva justo lo contrario de lo que se quiere medir.
       *
       * LO QUE GOOGLE EXIGE ADEMAS DE ESTA LINEA (ver docs/play-store.md):
       *   1. Divulgacion destacada DENTRO de la app, con el texto exacto,
       *      ANTES del dialogo del sistema. No sirve la politica de privacidad.
       *   2. Formulario de declaracion de permisos + video demostrativo.
       *   3. El permiso se pide POR SEPARADO y DESPUES de que el usuario ya
       *      concedio la ubicacion en primer plano; desde Android 11 el dialogo
       *      del sistema ni siquiera aparece: se abre Ajustes y la persona debe
       *      elegir "Permitir siempre" a mano.
       *
       * LO QUE EXIGE LA LEY CHILENA (docs/geolocalizacion-y-consentimiento.md):
       *   aviso previo, proporcionalidad y consentimiento registrado. La app no
       *   muestrea sin `POST /api/geo/consent` vigente, y el servidor rechaza la
       *   traza con 403 si no lo hay. No se rastrea fuera del turno: el endpoint
       *   solo acepta puntos de una ronda `en_curso`.
       */
      'android.permission.ACCESS_BACKGROUND_LOCATION',

      // FOREGROUND_SERVICE + FOREGROUND_SERVICE_LOCATION — el muestreo en
      // segundo plano corre como servicio en primer plano con notificacion
      // persistente. Android 14 exige el permiso tipado. La notificacion no es
      // un costo: es la forma visible de que el trabajador sepa, en todo
      // momento, que el turno esta activo y se esta registrando.
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_LOCATION',

      // POST_NOTIFICATIONS — Android 13+. Sin este permiso la notificacion del
      // servicio queda oculta: el servicio igual corre, pero se pierde
      // justamente la parte que hace demostrable "se esta registrando ahora".
      // Un rastreo silencioso es el escenario que la ley chilena prohibe.
      'android.permission.POST_NOTIFICATIONS',
    ],

    /**
     * Permisos que alguna dependencia agrega sola y que aca se sacan del
     * manifiesto a proposito:
     *
     * - RECORD_AUDIO: lo arrastra expo-camera si se habilita video. No grabamos
     *   audio y no queremos que la revision de Play crea que si.
     * - READ/WRITE_EXTERNAL_STORAGE, READ_MEDIA_IMAGES: acceso a galeria. Es
     *   una regla de producto, no una preferencia — si el guardia puede elegir
     *   un archivo, fotografia la puerta cerrada una vez y reusa esa imagen
     *   todo el mes.
     * - RECEIVE_BOOT_COMPLETED: no arrancamos nada al encender el telefono. Un
     *   servicio de ubicacion que revive solo al bootear es exactamente el
     *   patron que Play marca como rastreo fuera de turno.
     */
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.RECEIVE_BOOT_COMPLETED',
    ],

    // El gesto de retroceso predictivo saca al guardia del WebView sin avisar y
    // se pierde el formulario a medio llenar.
    predictiveBackGestureEnabled: false,

    // Sin respaldo automatico: la app no guarda datos propios que valga la pena
    // restaurar, y una copia en Google Drive de cachés con posiciones de un
    // trabajador es un dato personal viajando a un lugar que no controlamos.
    allowBackup: false,
  },
};

export default config;
