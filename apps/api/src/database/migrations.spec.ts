import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guardia sobre el conjunto de migraciones.
 *
 * TypeORM ordena por el sufijo numerico de la CLASE, no por el nombre del
 * archivo. Dos migraciones con el mismo sufijo se aplican en orden
 * indeterminado entre corridas: si una depende de la otra, funciona en un
 * ambiente y falla en el siguiente, y el sintoma aparece lejos de la causa.
 *
 * Ya paso tres veces en una semana —cada vez que varios carriles entregaron el
 * mismo dia— y las tres se cazaron a mano. Esto lo caza en CI.
 */
const CARPETA = join(__dirname, 'migrations');

interface Migracion {
  archivo: string;
  selloArchivo: string;
  clase: string;
  selloClase: string;
  campoName: string | null;
}

function leerMigraciones(): Migracion[] {
  return readdirSync(CARPETA)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((archivo) => {
      const texto = readFileSync(join(CARPETA, archivo), 'utf8');
      const clase = /export class (\w+?)(\d{10,})\s/.exec(texto);
      const campo = /name = '(\w+?)(\d{10,})'/.exec(texto);
      return {
        archivo,
        selloArchivo: archivo.split('-')[0] ?? '',
        clase: clase?.[1] ?? '',
        selloClase: clase?.[2] ?? '',
        campoName: campo ? campo[1]! + campo[2]! : null,
      };
    });
}

/**
 * Colisiones que YA se aplicaron en los ambientes y por eso NO se renombran.
 *
 * Renombrar una migracion ya ejecutada es peor que la colision: TypeORM guarda
 * el nombre de clase en su tabla de control, asi que con otro nombre la ve como
 * nueva y vuelve a correr su `up()` — que hace `CREATE TABLE` sobre una tabla
 * que ya existe y revienta el arranque.
 *
 * Estas dos son independientes entre si (reportes de caida y llaves de firma de
 * dispositivo), asi que el orden entre ellas no cambia el resultado. Quedan
 * anotadas para que la excepcion sea deliberada y no un olvido.
 */
const COLISIONES_HEREDADAS = new Set(['1725559200000']);

describe('migraciones', () => {
  const migraciones = leerMigraciones();

  it('hay migraciones y todas declaran clase con sello numerico', () => {
    expect(migraciones.length).toBeGreaterThan(10);
    const sinClase = migraciones.filter((m) => !m.selloClase);
    expect(sinClase.map((m) => m.archivo)).toEqual([]);
  });

  it('el sello del archivo coincide con el de la clase', () => {
    // Renombrar solo el archivo no cambia nada: TypeORM lee la clase. Un
    // desajuste entre los dos es una migracion que se cree renumerada y no lo
    // esta.
    const desajustadas = migraciones
      .filter((m) => m.selloArchivo !== m.selloClase)
      .map((m) => `${m.archivo} -> clase ${m.clase}${m.selloClase}`);
    expect(desajustadas).toEqual([]);
  });

  it('el campo name coincide con el nombre de la clase', () => {
    const desajustadas = migraciones
      .filter((m) => m.campoName !== null && m.campoName !== `${m.clase}${m.selloClase}`)
      .map((m) => `${m.archivo}: name='${m.campoName}' pero la clase es ${m.clase}${m.selloClase}`);
    expect(desajustadas).toEqual([]);
  });

  it('ninguna migracion NUEVA repite el sello de otra', () => {
    const porSello = new Map<string, string[]>();
    for (const m of migraciones) {
      porSello.set(m.selloClase, [...(porSello.get(m.selloClase) ?? []), m.archivo]);
    }
    const repetidos = [...porSello.entries()]
      .filter(([sello, archivos]) => archivos.length > 1 && !COLISIONES_HEREDADAS.has(sello))
      .map(([sello, archivos]) => `${sello}: ${archivos.join(' + ')}`);

    // Si esto falla: elige otro sello ANTES de mergear. Una vez aplicada en un
    // ambiente ya no se puede renombrar sin romper el arranque.
    expect(repetidos).toEqual([]);
  });

  /**
   * En PostgreSQL los limites `{m,n}` de una expresion regular solo admiten
   * valores de 0 a 255. Y el patron **no se compila al crear la tabla**: se
   * compila la primera vez que la restriccion se evalua, o sea en el primer
   * INSERT. Asi que un tope de mas se ve exactamente como no verse: la
   * migracion pasa, los SELECT responden, y el primer INSERT devuelve 500 con
   * `invalid regular expression: invalid repetition count(s)`.
   *
   * Paso con `consent_policies_url_check` (`{4,500}`) y dejo el producto sin
   * poder publicar el aviso de GPS — y por lo tanto sin poder iniciar rondas —
   * con los 1473 tests de la API en verde, porque mockean `manager.query`.
   *
   * El tope se pone en un `length()`, que no tiene ese limite.
   */
  it('ningun regex de PostgreSQL pide un limite mayor a 255', () => {
    const LIMITE = 255;
    // Las dos apariciones que quedan del patron roto, y por que se quedan:
    // la migracion original porque ya se aplico y el archivo es el registro de
    // lo que de verdad corrio, y el `down()` del arreglo porque revertir tiene
    // que devolver el esquema a como estaba, no a como deberia haber estado.
    const HEREDADAS = new Set([
      '1725472800000-CreateConsentPolicies.ts: {4,500}',
      '1725732000000-FixConsentPolicyUrlCheck.ts: {4,500}',
    ]);

    const excedidos: string[] = [];
    for (const migracion of migraciones) {
      const sql = readFileSync(join(CARPETA, migracion.archivo), 'utf8');
      for (const encontrado of sql.matchAll(/\{(\d+)(?:,(\d+))?\}/g)) {
        const topes = [encontrado[1], encontrado[2]].filter(Boolean).map(Number);
        const senal = `${migracion.archivo}: ${encontrado[0]}`;
        if (topes.some((tope) => tope > LIMITE) && !HEREDADAS.has(senal)) {
          excedidos.push(senal);
        }
      }
    }
    expect(excedidos).toEqual([]);
  });
});
