const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Declara `<uses-feature>` explicitos en el manifiesto Android.
 *
 * POR QUE EXISTE ESTE PLUGIN
 *
 * Google Play filtra que telefonos ven la ficha usando `uses-feature`. Cuando
 * una app declara `android.permission.NFC` o `android.permission.CAMERA` y NO
 * declara el `uses-feature` correspondiente, el sistema de build lo INFIERE con
 * `required="true"`. El efecto practico:
 *
 * - Sin esta declaracion, la ficha desaparece de Play Store para todo telefono
 *   sin NFC. Eso deja fuera al SUPERVISOR, que usa la app para monitorear en
 *   terreno y no escanea nada, y a cualquier equipo de repuesto de gama baja.
 * - Con `required="false"`, la app se instala en todos y es la app la que
 *   decide: el flujo del GUARDIA se bloquea con un mensaje claro si el equipo
 *   no tiene NFC (el puente lo informa en `ready.device.hasNfc`), y el resto
 *   del producto sigue funcionando.
 *
 * Esa es la decision: filtrar en tiempo de ejecucion con un mensaje entendible,
 * no en la vitrina de la tienda con una ficha que simplemente no aparece — un
 * "no me sale la app" es el reporte de soporte mas caro de diagnosticar.
 *
 * OJO: un telefono sin NFC NO puede hacer rondas. El respaldo es la etiqueta QR
 * (decision de CLAUDE.md), no "que escanee igual".
 */

/** @param {any} manifiesto @param {string} nombre @param {boolean} requerido */
function agregarUsesFeature(manifiesto, nombre, requerido) {
  const lista = manifiesto['uses-feature'] ?? [];
  const yaEsta = lista.some((f) => f?.$?.['android:name'] === nombre);
  if (!yaEsta) {
    lista.push({ $: { 'android:name': nombre, 'android:required': String(requerido) } });
  }
  manifiesto['uses-feature'] = lista;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withAndroidManifestExtras = (config) =>
  withAndroidManifest(config, (resultado) => {
    const manifiesto = resultado.modResults.manifest;

    // Se necesita para el trabajo del guardia, pero no para instalar la app.
    agregarUsesFeature(manifiesto, 'android.hardware.nfc', false);
    // Idem: el ADMIN o el SUPERVISOR pueden usar un equipo sin camara trasera.
    agregarUsesFeature(manifiesto, 'android.hardware.camera', false);
    agregarUsesFeature(manifiesto, 'android.hardware.camera.any', false);
    agregarUsesFeature(manifiesto, 'android.hardware.camera.autofocus', false);
    // GPS: sin el no hay evidencia de posicion, pero tampoco filtra la
    // instalacion — el servidor marca la anomalia y no rechaza el escaneo.
    agregarUsesFeature(manifiesto, 'android.hardware.location.gps', false);

    return resultado;
  });

module.exports = withAndroidManifestExtras;
