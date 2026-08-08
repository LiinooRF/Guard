/**
 * El aviso de que el antifraude geográfico está apagado en parte del recinto.
 *
 * `fuera_de_radio_gps` —la marca que caza el fraude de caseta, la razón de ser
 * del producto— solo puede dispararse en puntos CON coordenadas. Un punto sin
 * ubicar no es un error (un subterráneo puede no tener GPS útil), pero la
 * validación queda muda en él y NADIE se lo decía al admin: en el demo real,
 * dos escaneos hechos desde el mismo escritorio pasaron limpios porque ningún
 * punto tenía coordenadas. Un control apagado en silencio es la falsa
 * sensación de control contra la que advierte el propio CLAUDE.md.
 */
export function avisoSinCoordenadas(
  puntos: ReadonlyArray<{ latitude: number | null; longitude: number | null; isActive: boolean }>,
): string | null {
  const sinUbicar = puntos.filter(
    (p) => p.isActive && (p.latitude === null || p.longitude === null),
  ).length;
  if (sinUbicar === 0) return null;
  const activos = puntos.filter((p) => p.isActive).length;
  return sinUbicar === 1
    ? '1 punto activo no tiene coordenadas: la validación GPS del escaneo está apagada en él.'
    : `${sinUbicar} de ${activos} puntos activos no tienen coordenadas: la validación GPS del escaneo está apagada en ellos.`;
}
