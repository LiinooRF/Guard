export interface GeoPoint { latitude: number | null; longitude: number | null }

export function routeDistanceMeters(points: readonly GeoPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (previous.latitude === null || previous.longitude === null ||
        current.latitude === null || current.longitude === null) continue;
    total += haversine(previous.latitude, previous.longitude, current.latitude, current.longitude);
  }
  return Math.round(total);
}

/** Caminata conservadora (75 m/min) + 45 segundos de control por punto. */
export function estimatedRouteMinutes(distanceMeters: number, checkpointCount: number): number {
  return Math.max(1, Math.ceil(distanceMeters / 75 + checkpointCount * 0.75));
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) *
    Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
