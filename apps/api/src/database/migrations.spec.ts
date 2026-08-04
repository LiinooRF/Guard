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
});
