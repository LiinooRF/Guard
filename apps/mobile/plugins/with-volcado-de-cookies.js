const { withMainActivity } = require('expo/config-plugins');

/**
 * Vuelca a disco las cookies del WebView cuando la Activity se pausa.
 *
 * EL PROBLEMA, reproducido en un moto g35: el guardia inicia sesion, deja la
 * app en segundo plano, Android mata el proceso —lo hace de rutina cuando
 * necesita memoria, y los matadores de bateria de gama baja lo hacen mas— y al
 * volver le aparece la pantalla de login. Con `am kill` y con "forzar
 * detencion" pasa siempre.
 *
 * NO es que la sesion venza: el servidor manda el refresh con 30 dias de
 * vigencia, asi que la intencion del producto es que el guardia NO tenga que
 * volver a escribir sus credenciales. Lo que pasa es que el WebView de Android
 * mantiene las cookies en memoria y las escribe a disco cuando le parece; si el
 * proceso muere antes de ese volcado, se pierden.
 *
 * POR QUE EN `onPause` Y NO DESDE JAVASCRIPT: `CookieManager.flush()` es una
 * API nativa. La libreria de JS que la expone (`@react-native-cookies/cookies`)
 * todavia declara `jcenter()` en su `build.gradle`, repositorio que Gradle 9
 * elimino, y el build de Android falla al evaluarla. Antes que arrastrar una
 * dependencia sin mantener, se llama a la API directamente en el momento exacto
 * que importa: `onPause` es lo ultimo que corre con garantia antes de que el
 * sistema pueda matar el proceso, y cubre tanto el login como la renovacion del
 * token sin tener que enterarse de ninguno de los dos.
 *
 * POR QUE IMPORTA EN TERRENO: la ronda ocurre en subterraneos y perimetros sin
 * señal. Un guardia expulsado al login ahi no puede volver a entrar —el login
 * necesita servidor— y pierde el turno.
 */
const IMPORT = 'import android.webkit.CookieManager';

const ON_PAUSE = `
  override fun onPause() {
    super.onPause()
    // Ver plugins/with-volcado-de-cookies.js: sin esto, un proceso matado por
    // el sistema se lleva la sesion del guardia y lo devuelve al login.
    CookieManager.getInstance().flush()
  }
`;

module.exports = function withVolcadoDeCookies(config) {
  return withMainActivity(config, (configuracion) => {
    const archivo = configuracion.modResults;
    if (archivo.language !== 'kt') {
      throw new Error(
        `with-volcado-de-cookies espera MainActivity en Kotlin y encontro "${archivo.language}"`,
      );
    }
    if (archivo.contents.includes('CookieManager.getInstance().flush()')) {
      return configuracion;
    }

    let contenido = archivo.contents;
    if (!contenido.includes(IMPORT)) {
      // Detras del ultimo import, para no quedar antes de la declaracion de
      // paquete ni romper el orden que espera Kotlin.
      const imports = [...contenido.matchAll(/^import .*$/gm)];
      const ultimo = imports[imports.length - 1];
      if (!ultimo) throw new Error('with-volcado-de-cookies: MainActivity sin imports');
      const corte = (ultimo.index ?? 0) + ultimo[0].length;
      contenido = `${contenido.slice(0, corte)}\n${IMPORT}${contenido.slice(corte)}`;
    }

    // Se inserta dentro de la clase, justo despues de su llave de apertura.
    const clase = contenido.match(/class MainActivity[^{]*\{/);
    if (!clase) throw new Error('with-volcado-de-cookies: no encontre la clase MainActivity');
    const posicion = (clase.index ?? 0) + clase[0].length;
    archivo.contents = `${contenido.slice(0, posicion)}\n${ON_PAUSE}${contenido.slice(posicion)}`;
    return configuracion;
  });
};
