import CookieManager from '@react-native-cookies/cookies';
import { Platform } from 'react-native';

/**
 * Vuelca a disco las cookies de sesion del WebView.
 *
 * EL PROBLEMA, reproducido en un moto g35: el guardia inicia sesion, deja la
 * app en segundo plano, Android mata el proceso —lo hace de rutina cuando
 * necesita memoria, y los matadores de bateria de gama baja lo hacen mas— y al
 * volver aparece la pantalla de login. Con `am kill` y con "forzar detencion"
 * pasa siempre; cerrando con Home y reabriendo, no.
 *
 * NO es que la sesion venza. El servidor manda el refresh con 30 dias de
 * vigencia (`session-cookies.ts`), asi que la intencion del producto es que el
 * guardia NO tenga que volver a escribir sus credenciales. Lo que pasa es que
 * el WebView de Android mantiene las cookies en memoria y las escribe a disco
 * cuando le parece; si el proceso muere antes de ese volcado, se pierden. Nadie
 * llamaba a `CookieManager.flush()`.
 *
 * POR QUE IMPORTA EN TERRENO: la ronda ocurre en subterraneos y perimetros sin
 * señal. Un guardia expulsado al login ahi no puede volver a entrar —el login
 * necesita servidor— y pierde el turno. El costo de esta llamada es un fsync;
 * el de no hacerla es una ronda sin registrar.
 *
 * CUANDO: despues de iniciar sesion y despues de renovar el token —los dos
 * momentos en que la cookie cambia— y al pasar a segundo plano, que es el
 * instante anterior a que el sistema pueda matar el proceso. NO en cada
 * request: seria un fsync por llamada a la API sin ganar nada, porque entre
 * request y request la cookie es la misma.
 */

/** iOS persiste solo; `flush` es especifico de Android. */
export function requierePersistenciaManual(): boolean {
  return Platform.OS === 'android';
}

/**
 * Nunca lanza: es una optimizacion de durabilidad, no parte del flujo. Si
 * fallara, lo peor que pasa es que volvemos al comportamiento anterior.
 */
export async function persistirCookies(): Promise<boolean> {
  if (!requierePersistenciaManual()) return false;
  try {
    await CookieManager.flush();
    return true;
  } catch {
    return false;
  }
}
