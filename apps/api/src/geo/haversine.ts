/**
 * Distancia en metros entre dos coordenadas (formula de haversine).
 *
 * GuardService tiene su propia copia privada para el radio del escaneo; esa no
 * se toca en este issue. Cuando se unifiquen, esta es la que queda: es la unica
 * exportada.
 */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const rad = (v: number) => (v * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
