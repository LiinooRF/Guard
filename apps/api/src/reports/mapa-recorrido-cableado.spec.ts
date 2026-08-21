import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El mapa del recorrido tiene que estar ENCHUFADO al informe (#79).
 *
 * Este modulo existia entero —modelo, renderer, servicio y sus specs, todo en
 * verde— y **no lo importaba nadie**: `MapaRecorridoModule` no figuraba en
 * ningun `imports`, y `MapaRecorridoService` no estaba inyectado en ninguna
 * parte. Un `git grep` solo lo encontraba en comentarios que hablaban de el.
 *
 * Es el mismo defecto que ya habia dejado muertos el proveedor de tiles (#271),
 * el reporte del permiso de ubicacion (#275) y el emisor de la traza (#280):
 * la pieza esta construida y probada, y falta el cable. Sus propios tests pasan
 * igual, porque prueban la pieza suelta.
 *
 * Por eso esta prueba no mira que el mapa se dibuje bien —de eso se ocupan
 * `mapa-recorrido.renderer.spec.ts` y compania— sino que ALGUIEN LO LLAME.
 */
const leer = (nombre: string) => readFileSync(join(__dirname, nombre), 'utf8');

describe('el mapa del recorrido esta cableado al informe (#79)', () => {
  it('ReportsModule importa MapaRecorridoModule, o la inyeccion no resuelve', () => {
    const modulo = leer('reports.module.ts');
    expect(modulo).toContain('MapaRecorridoModule');
    expect(modulo).toMatch(/imports:\s*\[[^\]]*MapaRecorridoModule/);
  });

  it('el servicio del informe lo inyecta y lo llama', () => {
    const servicio = leer('patrol-report.service.ts');
    expect(servicio).toContain('MapaRecorridoService');
    expect(servicio).toMatch(/this\.mapaRecorrido\.construir\(/);
  });

  it('el mapa se construye con los puntos YA resueltos, no con las filas crudas', () => {
    // El mapa ubica cada marca por su numero de punto: con `PuntoEsperadoRow`
    // no compila, y pasarle otra cosa lo dejaria dibujando marcas sin ubicar.
    const servicio = leer('patrol-report.service.ts');
    expect(servicio).toMatch(/construir\(\s*patrolId,\s*modelo\.puntos/);
  });

  it('el renderer lo dibuja de verdad', () => {
    const renderer = leer('patrol-report.renderer.ts');
    expect(renderer).toContain("from './mapa-recorrido.renderer'");
    expect(renderer).toMatch(/dibujarMapaRecorrido\(doc, modelo\.mapa(, modelo\.fondoMapa)?\)/);
  });

  it('el informe liviano del correo NO lleva mapa', () => {
    // Un PDF con mapa no es un adjunto. Es la misma razon por la que va sin
    // fotos, y si esto se afloja los correos se vuelven impagables.
    const servicio = leer('patrol-report.service.ts');
    expect(servicio).toMatch(/incluirAnexo\s*\n?\s*\?\s*await this\.mapaRecorrido\.construir/);
  });

  it('el modelo transporta el mapa y admite que no vaya', () => {
    const modelo = leer('patrol-report.model.ts');
    expect(modelo).toMatch(/readonly mapa: MapaRecorrido \| null;/);
  });
});
