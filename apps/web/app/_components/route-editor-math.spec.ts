import { estimatedRouteMinutes, routeDistanceMeters } from './route-editor-math';

describe('cálculos del editor de rutas', () => {
  it('suma los tramos en el orden visible', () => {
    const distance = routeDistanceMeters([
      { latitude: -33.45, longitude: -70.66 },
      { latitude: -33.45, longitude: -70.659 },
      { latitude: -33.449, longitude: -70.659 },
    ]);
    expect(distance).toBeGreaterThan(190);
    expect(distance).toBeLessThan(220);
  });

  it('omite tramos sin coordenadas sin producir NaN', () => {
    expect(routeDistanceMeters([
      { latitude: -33.45, longitude: -70.66 },
      { latitude: null, longitude: null },
    ])).toBe(0);
  });

  it('estima caminata más tiempo de inspección por punto', () => {
    expect(estimatedRouteMinutes(750, 4)).toBe(13);
  });
});
