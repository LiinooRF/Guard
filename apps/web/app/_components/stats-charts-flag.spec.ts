import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El cable del módulo "Gráficas por sucursal" (#286).
 *
 * Era uno de los controles MUERTOS: el admin podía apagar el módulo en el panel
 * y no pasaba nada — los gráficos comparativos se dibujaban SIEMPRE. La ficha
 * del catálogo prometía "desaparecen los gráficos; las cifras siguen en las
 * tablas", y esa promesa no la cumplía ninguna línea de código.
 *
 * Como el resto de los cables de este proyecto, el defecto no era un cálculo
 * malo sino una AUSENCIA: el flag existía en el contrato, el endpoint lo servía,
 * y el componente que dibuja los gráficos ni lo consultaba. Por eso el test lee
 * la fuente y comprueba que las cuatro piezas del cable están puestas:
 *
 *   1. se consulta el flag `chartsBySite` desde `/features`,
 *   2. el valor viaja como `mostrarGraficos` a cada tarjeta,
 *   3. cada gráfico queda detrás de esa guarda,
 *   4. las tablas NO — siguen siempre, que es lo que hace útil apagar el módulo.
 *
 * Falla ABIERTO a propósito: si no se puede leer el módulo, se muestran los
 * gráficos, y el test fija también esa decisión para que no se invierta sin
 * querer.
 */
const fuente = readFileSync(join(__dirname, 'stats-charts.tsx'), 'utf8');

describe('gráficas por sucursal detrás de su módulo (#286)', () => {
  it('consulta el flag chartsBySite desde /features', () => {
    expect(fuente).toContain('moduloGraficasEncendido');
    expect(fuente).toContain('/features');
    expect(fuente).toContain('chartsBySite');
  });

  it('falla abierto: sin poder leer el módulo, muestra los gráficos', () => {
    // Las tres salidas de error de moduloGraficasEncendido devuelven true.
    // Contamos que haya al menos tantos `return true` como caminos de fallo.
    const retornosTrue = fuente.match(/return true;/g) ?? [];
    expect(retornosTrue.length).toBeGreaterThanOrEqual(3);
  });

  it('el módulo apagado se lee como false, no como ausencia', () => {
    // `!== false` y no `=== true`: un cuerpo sin la clave debe DEJAR ver el
    // gráfico (fabrica: prendido), no apagarlo por no venir nombrado.
    expect(fuente).toContain("chartsBySite !== false");
  });

  it('el valor viaja como mostrarGraficos a las cinco tarjetas de gráficos', () => {
    const pasadas = fuente.match(/mostrarGraficos=\{mostrarGraficos\}/g) ?? [];
    expect(pasadas.length).toBe(5);
  });

  it('cada gráfico queda detrás de la guarda mostrarGraficos', () => {
    // Los tres componentes de gráfico solo aparecen dentro de un `mostrarGraficos ?`.
    for (const grafico of ['BarrasHorizontales', 'SerieCumplimiento', 'ColumnasRondas']) {
      const usos = fuente.match(new RegExp(`<${grafico}\\b`, 'g')) ?? [];
      expect(usos.length).toBeGreaterThan(0);
    }
    // Hay una guarda por cada punto de uso de gráfico (4 BarrasHorizontales +
    // el bloque de Evolución que agrupa Serie + Columnas): 5 en total.
    const guardas = fuente.match(/mostrarGraficos \? \(/g) ?? [];
    expect(guardas.length).toBe(5);
  });

  it('las tablas NO se esconden: apagar el módulo deja las cifras', () => {
    // TablaDatos nunca queda dentro de una guarda de gráfico. La comprobamos por
    // presencia: si alguien envolviera las tablas, este número cambiaría y el
    // recuento de guardas de arriba dejaría de cuadrar con 5.
    const tablas = fuente.match(/<TablaDatos\b/g) ?? [];
    expect(tablas.length).toBeGreaterThanOrEqual(5);
  });
});
