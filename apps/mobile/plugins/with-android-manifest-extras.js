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

/**
 * Redeclara el receptor de expo-task-manager sin lo que lo despierta solo.
 *
 * La libreria lo declara escuchando BOOT_COMPLETED y MY_PACKAGE_REPLACED, para
 * reanudar tareas al encender el telefono o al actualizar la app. Para la traza
 * de una ronda eso seria rastrear fuera del turno: justo lo que el aviso legal
 * promete que no pasa, y el patron que Google Play marca.
 *
 * Se declara aca con `tools:node="replace"` para que el merge se quede con esta
 * version, que conserva SOLO la accion propia de expo — la que entrega las
 * posiciones mientras la ronda esta en curso.
 *
 * Va de la mano con RECEIVE_BOOT_COMPLETED en `android.permissions`: ese
 * permiso lo exige el job persistente con el que expo registra la tarea, y sin
 * el la app se cae al iniciar la ronda. Permiso y arranque automatico son cosas
 * distintas y aca se separan a proposito.
 *
 * @param {any} manifiesto
 */
function callarElArranqueAutomaticoDeTareas(manifiesto) {
  const aplicacion = manifiesto.application?.[0];
  if (!aplicacion) return;
  const receptores = aplicacion.receiver ?? [];
  const NOMBRE = 'expo.modules.taskManager.TaskBroadcastReceiver';
  const sinElNuestro = receptores.filter((r) => r?.$?.['android:name'] !== NOMBRE);
  sinElNuestro.push({
    $: {
      'android:name': NOMBRE,
      'android:exported': 'false',
      'tools:node': 'replace',
    },
    'intent-filter': [
      {
        action: [
          {
            $: {
              'android:name':
                'expo.modules.taskManager.TaskBroadcastReceiver.INTENT_ACTION',
            },
          },
        ],
      },
    ],
  });
  aplicacion.receiver = sinElNuestro;
  // El atributo `tools:` necesita su namespace declarado en <manifest>.
  manifiesto.$ = manifiesto.$ ?? {};
  manifiesto.$['xmlns:tools'] = 'http://schemas.android.com/tools';
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

    callarElArranqueAutomaticoDeTareas(manifiesto);

    return resultado;
  });

module.exports = withAndroidManifestExtras;
