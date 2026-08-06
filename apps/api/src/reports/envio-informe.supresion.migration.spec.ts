import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El motivo nuevo de la marca de despacho, revisado sobre el TEXTO (#86).
 *
 * Mismo criterio que envio-informe.backlog.migration.spec.ts: hay cosas que
 * ningun mock puede ver, porque el mock cree lo que el autor ya creia.
 *
 *   - Parentesis y comillas balanceados. Un parentesis de mas lo rechaza
 *     Postgres SIEMPRE y no aparece en ninguna corrida de tests.
 *   - El CHECK de la tabla y la union `MotivoAtendido` del servicio son UN SOLO
 *     contrato repartido en dos archivos. Agregar un motivo en el codigo sin la
 *     migracion no rompe ningun test con mock: revienta el INSERT en
 *     produccion, en el camino de "no habia nada que mandar", que es el que
 *     nadie mira hasta que el barrido queda en loop.
 *
 * OJO CON EL TEST HERMANO. `envio-informe.backlog.migration.spec.ts` afirma que
 * el CHECK original admite exactamente dos motivos, y sigue siendo cierto de ESE
 * archivo: esta migracion lo amplia despues. Lo que vale en la base es la union
 * de las dos, y es lo que se verifica aca.
 */
const RUTA_ORIGEN = join(
  __dirname,
  '../database/migrations/1725472900000-CreateReportDispatchBacklog.ts',
);
const ARCHIVO_AMPLIACION = '1725822000000-AllowSuppressedDispatchReason.ts';
const RUTA_AMPLIACION = join(__dirname, '../database/migrations', ARCHIVO_AMPLIACION);

/** El sello sale del NOMBRE del archivo, para que renumerarla rompa aca y no en produccion. */
const SELLO = Number(ARCHIVO_AMPLIACION.split('-')[0]);

const SQL_ORIGEN = readFileSync(RUTA_ORIGEN, 'utf8');
const SQL = readFileSync(RUTA_AMPLIACION, 'utf8');
const SERVICIO = readFileSync(join(__dirname, 'envio-informe.service.ts'), 'utf8');

/** Los literales de plantilla del archivo, que es donde vive el SQL. */
const LITERALES = (SQL.match(/`[^`]*`/g) ?? []).map((literal) => literal.slice(1, -1));

/** Los motivos que el servicio declara poder escribir. */
const MOTIVOS_DEL_SERVICIO = (() => {
  const bloque = SERVICIO.match(/type MotivoAtendido = Extract<[\s\S]*?>;/)?.[0] ?? '';
  return [...bloque.matchAll(/'([a-z_]+)'/g)].map((coincidencia) => coincidencia[1]);
})();

describe('migracion del motivo de supresion por dominio', () => {
  it('cada SQL tiene los parentesis y las comillas balanceados', () => {
    const rotos = LITERALES.filter((cuerpo) => {
      if (!/SELECT|CREATE|ALTER|GRANT|REVOKE|DROP|INSERT|UPDATE/.test(cuerpo)) return false;
      let abiertos = 0;
      let minimo = 0;
      for (const caracter of cuerpo) {
        if (caracter === '(') abiertos += 1;
        if (caracter === ')') abiertos -= 1;
        minimo = Math.min(minimo, abiertos);
      }
      const comillas = (cuerpo.match(/'/g) ?? []).length;
      return abiertos !== 0 || minimo < 0 || comillas % 2 !== 0;
    });

    expect(rotos).toEqual([]);
  });

  it('corre despues de la tabla que amplia y despues del corte', () => {
    // Dos cosas distintas, las dos por el mismo motivo: TypeORM ordena por el
    // sufijo numerico de la CLASE, no por el nombre del archivo.
    //
    //   - Posterior a 1725472900000, que es donde nace el CHECK que se amplia.
    //     Al reves, el ALTER correria sobre una tabla que todavia no existe.
    //   - Posterior al corte 1725645600000 que fija CLAUDE.md, para no caer en
    //     el rango de sellos ya aplicados en los ambientes.
    //
    // Que el sello del archivo, el de la clase y el campo `name` coincidan, y
    // que ninguno choque con otra migracion, lo cubre database/migrations.spec.ts
    // sobre la carpeta completa: aca solo se fija el sello de ESTA.
    // NO se fija el sello exacto. Lo que importa de un sello es el ORDEN, y
    // fijar el numero convierte en rojo un renumerado que es justo lo correcto:
    // este archivo nacio con 1725818400000 y ese sello se lo llevo antes otra
    // migracion, asi que hubo que moverlo. Un test que obliga a elegir el numero
    // "correcto" de antemano pelea con la unica salida que hay cuando dos
    // carriles entregan el mismo dia.
    expect(SQL).toContain(`AllowSuppressedDispatchReason${SELLO}`);
    expect(SQL).toContain(`name = 'AllowSuppressedDispatchReason${SELLO}'`);
    expect(SELLO).toBeGreaterThan(1725472900000);
    expect(SELLO).toBeGreaterThan(1725645600000);
  });

  it('reemplaza el CHECK viejo por uno que admite el motivo nuevo', () => {
    expect(SQL).toContain('DROP CONSTRAINT IF EXISTS report_dispatch_attempts_reason_check');
    expect(SQL).toContain(
      "CHECK (reason IN ('envio_desactivado', 'sin_destinatarios', 'dominio_no_despachable'))",
    );
  });

  it('no crea tablas, asi que no le falta RLS', () => {
    // La regla dice ENABLE + FORCE + politica que falla cerrada en toda tabla
    // NUEVA. Esta migracion no crea ninguna: `report_dispatch_attempts` ya trae
    // las tres cosas de 1725472900000, y ampliar un CHECK no las toca.
    expect(SQL).not.toContain('CREATE TABLE');
    expect(SQL_ORIGEN).toContain(
      'ALTER TABLE report_dispatch_attempts FORCE ROW LEVEL SECURITY',
    );
  });

  it('se puede revertir sin dejar filas que violen el CHECK viejo', () => {
    // ADD CONSTRAINT valida las filas existentes: si quedara una con el motivo
    // nuevo, el `down` fallaria a la mitad y la tabla se quedaria SIN CHECK.
    expect(SQL).toContain("SET reason = 'sin_destinatarios'");
    expect(SQL).toContain("WHERE reason = 'dominio_no_despachable'");
    expect(SQL).toContain("CHECK (reason IN ('envio_desactivado', 'sin_destinatarios'))");
  });

  describe('el CHECK y el codigo dicen lo mismo', () => {
    it('el servicio declara los tres motivos', () => {
      expect(MOTIVOS_DEL_SERVICIO).toEqual([
        'envio_desactivado',
        'sin_destinatarios',
        'dominio_no_despachable',
      ]);
    });

    it('todo motivo que el servicio escribe lo admite la base', () => {
      const permitidos = new Set(
        [...`${SQL_ORIGEN}\n${SQL}`.matchAll(/CHECK \(reason IN \(([^)]*)\)\)/g)].flatMap(
          (coincidencia) =>
            [...(coincidencia[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((valor) => valor[1]),
        ),
      );

      for (const motivo of MOTIVOS_DEL_SERVICIO) {
        expect([...permitidos]).toContain(motivo);
      }
    });
  });
});
