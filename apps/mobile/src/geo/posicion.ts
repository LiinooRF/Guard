import * as Location from 'expo-location';

import type { PosicionEscaneo } from '../nfc/nfc-reader';

/**
 * Posicion del telefono en el instante del escaneo, para los dos lectores
 * —etiqueta NFC (#57) y respaldo por QR (#226)—.
 *
 * Esta funcion existe compartida y no copiada en cada lector porque de ella
 * dependen dos anomalias del servidor: `sin_fix_gps` y `fuera_de_radio_gps`. Dos
 * copias que se separen con el tiempo darian rondas con criterios distintos
 * segun como se marco el punto, y eso es peor que no medir.
 *
 * Devuelve `undefined` cuando no hay permiso concedido. NO lo pide: el permiso
 * de ubicacion se negocia en su propio momento, con su aviso, y pedirlo en medio
 * de un escaneo interrumpe al guardia justo cuando esta apuntando al punto.
 */
export async function posicionDelEscaneo(): Promise<PosicionEscaneo | undefined> {
  const permiso = await Location.getForegroundPermissionsAsync();
  if (permiso.status !== 'granted') return undefined;
  const posicion = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
    mayShowUserSettingsDialog: true,
  });
  return {
    latitude: posicion.coords.latitude,
    longitude: posicion.coords.longitude,
    ...(posicion.coords.accuracy === null ? {} : { accuracyM: posicion.coords.accuracy }),
  };
}
