/**
 * Decide si hay camara sin dejar que la consulta tumbe nada.
 *
 * Vive aparte de `handlers.ts` porque ese modulo importa `expo-camera` y
 * `react-native`, que no cargan fuera de un telefono: nada de lo que hay ahi se
 * puede probar. Esta funcion es pura y si.
 *
 * El caso real que la justifica: `CameraView.isAvailableAsync()` **no existe en
 * Android** —expo-camera la expone en iOS y web— y lanza `UnavailabilityError`
 * en el acto. Esa excepcion hacia estallar `capacidades()` entera y, como
 * `atenderHola()` responde con error cuando capacidades falla, el portal nunca
 * recibia el `ready`. Resultado: el guardia no podia escanear **ni por NFC ni
 * por QR**, con el NFC del telefono encendido. Un dato accesorio derribaba todo.
 */
export async function resolverCamara(
  consultar: () => Promise<boolean>,
  /**
   * Que contestar cuando no se pudo saber. En Android es `true`: no se pudo
   * comprobar, pero todo telefono que corre esta app tiene camara, y si no la
   * tuviera el lector de QR falla con su propio mensaje. Contestar `false`
   * seria peor: le quitaria al guardia el respaldo por QR sin motivo (#227).
   */
  siNoSePudoSaber: boolean,
): Promise<boolean> {
  try {
    return await consultar();
  } catch {
    return siNoSePudoSaber;
  }
}
