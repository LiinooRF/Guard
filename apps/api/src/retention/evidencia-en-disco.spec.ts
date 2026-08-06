import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { borrarEvidenciaDeDisco, rutaDeEvidencia } from './evidencia-en-disco';

/**
 * El lado de disco de la purga, contra el sistema de archivos DE VERDAD.
 *
 * Aca no se mockea `fs` a proposito. Lo que este archivo tiene que probar es que
 * un archivo deja de existir y que una fila NO se marca borrable cuando su
 * archivo sigue ahi; con `fs` mockeado eso seria confirmar lo que uno ya cree,
 * que es exactamente como llegaron los dos bugs conocidos a produccion.
 */
describe('evidencia en disco', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'voxia-purga-'));
  });

  async function crearFoto(rutaRelativa: string): Promise<void> {
    const absoluta = join(base, rutaRelativa);
    await mkdir(join(absoluta, '..'), { recursive: true });
    await writeFile(absoluta, 'bytes-de-la-foto');
  }

  describe('rutaDeEvidencia', () => {
    it('resuelve la ruta relativa dentro del volumen', () => {
      expect(rutaDeEvidencia(base, join('empresa', 'ronda', 'abc.jpg'))).toBe(
        join(base, 'empresa', 'ronda', 'abc.jpg'),
      );
    });

    it('rechaza una ruta que se escapa del volumen', () => {
      // Una fila con .. adentro convertiria la purga en un borrado arbitrario de
      // archivos del servidor con los permisos del proceso.
      expect(rutaDeEvidencia(base, join('..', '..', 'etc', 'passwd'))).toBeNull();
    });
  });

  it('borra el archivo y devuelve la foto como borrable', async () => {
    await crearFoto(join('empresa', 'ronda', 'uno.jpg'));

    const resultado = await borrarEvidenciaDeDisco(base, [
      { fotoId: 'foto-1', rutaRelativa: join('empresa', 'ronda', 'uno.jpg') },
    ]);

    expect(resultado.borrables).toEqual(['foto-1']);
    expect(resultado.conservadas).toEqual([]);
    expect(existsSync(join(base, 'empresa', 'ronda', 'uno.jpg'))).toBe(false);
  });

  it('trata el archivo que ya no estaba como borrable', async () => {
    // Purga anterior cortada a la mitad, o restore incompleto. El objetivo es
    // que el archivo no exista, no haberlo borrado uno mismo: la fila tiene que
    // poder irse igual, o queda apuntando a la nada para siempre.
    const resultado = await borrarEvidenciaDeDisco(base, [
      { fotoId: 'foto-fantasma', rutaRelativa: join('empresa', 'ronda', 'no-existe.jpg') },
    ]);

    expect(resultado.borrables).toEqual(['foto-fantasma']);
    expect(resultado.conservadas).toEqual([]);
  });

  it('CONSERVA la fila cuando el archivo no se pudo borrar, y dice cual', async () => {
    // Un directorio donde deberia haber un archivo hace fallar el unlink en
    // cualquier plataforma (EISDIR en Linux, EPERM en Windows). Es el sustituto
    // portable de un fallo de permisos del volumen.
    await mkdir(join(base, 'empresa', 'ronda', 'trabada.jpg'), { recursive: true });

    const resultado = await borrarEvidenciaDeDisco(base, [
      { fotoId: 'foto-trabada', rutaRelativa: join('empresa', 'ronda', 'trabada.jpg') },
    ]);

    // Lo que importa: el archivo sigue ahi, asi que la fila NO se puede borrar.
    expect(resultado.borrables).toEqual([]);
    // Y devuelve el ID, no un conteo: es lo que le permite a quien llama pedirle
    // al lote siguiente que la saltee en vez de tropezarse con ella de nuevo.
    expect(resultado.conservadas).toEqual(['foto-trabada']);
    expect(resultado.motivos).toHaveLength(1);
    expect(existsSync(join(base, 'empresa', 'ronda', 'trabada.jpg'))).toBe(true);
  });

  it('conserva la fila de una ruta que apunta fuera del volumen', async () => {
    const resultado = await borrarEvidenciaDeDisco(base, [
      { fotoId: 'foto-rara', rutaRelativa: join('..', 'fuera.jpg') },
    ]);

    expect(resultado.borrables).toEqual([]);
    expect(resultado.conservadas).toEqual(['foto-rara']);
    expect(resultado.motivos).toEqual(['ruta_fuera_del_volumen']);
  });

  it('un archivo que falla no corta el lote', async () => {
    await crearFoto(join('empresa', 'ronda', 'buena.jpg'));
    await mkdir(join(base, 'empresa', 'ronda', 'mala.jpg'), { recursive: true });
    await crearFoto(join('empresa', 'otra-ronda', 'tercera.jpg'));

    const resultado = await borrarEvidenciaDeDisco(base, [
      { fotoId: 'a', rutaRelativa: join('empresa', 'ronda', 'mala.jpg') },
      { fotoId: 'b', rutaRelativa: join('empresa', 'ronda', 'buena.jpg') },
      { fotoId: 'c', rutaRelativa: join('empresa', 'otra-ronda', 'tercera.jpg') },
    ]);

    expect(resultado.borrables).toEqual(['b', 'c']);
    expect(resultado.conservadas).toEqual(['a']);
  });

  it('no repite un id en conservadas aunque el lote traiga la foto dos veces', async () => {
    // No deberia pasar —la consulta no repite filas— pero si pasara, quien llama
    // usa la longitud de esta lista como "cuantos archivos estan trabados". Que
    // sea la fuente de un numero inflado otra vez es justo lo que se arreglo.
    await mkdir(join(base, 'empresa', 'ronda', 'trabada.jpg'), { recursive: true });
    const foto = { fotoId: 'repetida', rutaRelativa: join('empresa', 'ronda', 'trabada.jpg') };

    const resultado = await borrarEvidenciaDeDisco(base, [foto, foto]);

    expect(new Set(resultado.conservadas).size).toBe(1);
  });

  it('saca la carpeta que quedo vacia y respeta la que no', async () => {
    await crearFoto(join('empresa', 'vacia', 'unica.jpg'));
    await crearFoto(join('empresa', 'con-resto', 'una.jpg'));
    await crearFoto(join('empresa', 'con-resto', 'otra.jpg'));

    await borrarEvidenciaDeDisco(base, [
      { fotoId: 'a', rutaRelativa: join('empresa', 'vacia', 'unica.jpg') },
      { fotoId: 'b', rutaRelativa: join('empresa', 'con-resto', 'una.jpg') },
    ]);

    expect(existsSync(join(base, 'empresa', 'vacia'))).toBe(false);
    expect(await readdir(join(base, 'empresa', 'con-resto'))).toEqual(['otra.jpg']);
  });

  it('nunca borra la raiz del volumen', async () => {
    await crearFoto('suelta.jpg');

    await borrarEvidenciaDeDisco(base, [{ fotoId: 'a', rutaRelativa: 'suelta.jpg' }]);

    expect(existsSync(base)).toBe(true);
  });
});
