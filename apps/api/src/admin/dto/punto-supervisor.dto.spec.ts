import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  CrearPuntoSupervisorDto,
  EditarPuntoSupervisorDto,
  VincularEtiquetaSupervisorDto,
} from './punto-supervisor.dto';

/**
 * La forma de estos DTO es una defensa, no una comodidad.
 *
 * El SUPERVISOR gano en #309 la capacidad de crear puntos y vincular etiquetas.
 * Lo que lo separa de poder falsear una ronda entera es exactamente lo que estos
 * DTO NO aceptan, y eso no lo vigilaba ninguna prueba: un verificador les volvio
 * a agregar los campos recortados y las 2122 pruebas de la API siguieron verdes,
 * aunque los campos llegan derechito al INSERT y al UPDATE.
 *
 * Las tres cerraduras que fija este archivo:
 *
 * 1. `tech` NO se acepta al vincular una etiqueta. El QR de respaldo lleva un UID
 *    de 16 bytes ALEATORIOS justamente para que nadie pueda imprimir el codigo de
 *    un punto sin ir al recinto. Si el llamador eligiera el UID de un QR, el
 *    supervisor se emite el codigo, lo pega en la garita, y sus guardias marcan la
 *    ronda sin caminar.
 * 2. `requiresPhoto` NO se acepta al crear un punto: apagar la evidencia
 *    fotografica de un acceso critico es decision del ADMIN.
 * 3. `kind` NO se acepta al editar: degradar un acceso critico a punto normal
 *    seria la misma jugada por otra puerta.
 *
 * Se valida con las MISMAS opciones que el ValidationPipe global (main.ts), donde
 * `forbidNonWhitelisted` convierte un campo de contrabando en 400 y no en un
 * silencio.
 */
function validar<T extends object>(clase: new () => T, payload: Record<string, unknown>) {
  const dto = plainToInstance(clase, payload);
  const errores = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errores, campos: errores.map((e) => e.property) };
}

describe('VincularEtiquetaSupervisorDto: el supervisor vincula NFC, nunca QR (#309)', () => {
  it('acepta un UID a secas', () => {
    const { errores, dto } = validar(VincularEtiquetaSupervisorDto, { uid: '040D15525D6481' });
    expect(errores).toHaveLength(0);
    expect(dto.uid).toBe('040D15525D6481');
  });

  it('RECHAZA que el llamador elija la tecnologia', () => {
    const { campos } = validar(VincularEtiquetaSupervisorDto, {
      uid: '040D15525D6481',
      tech: 'qr',
    });
    expect(campos).toContain('tech');
  });

  it('tampoco deja colar tech: "nfc", aunque sea el valor que igual se usa', () => {
    // La tecnologia la fija el servidor. Aceptarla "porque coincide" volveria a
    // abrir la puerta el dia que alguien cambie el default.
    const { campos } = validar(VincularEtiquetaSupervisorDto, {
      uid: '040D15525D6481',
      tech: 'nfc',
    });
    expect(campos).toContain('tech');
  });

  it('recorta el UID antes de validar, como el CHECK de la tabla', () => {
    const { dto, errores } = validar(VincularEtiquetaSupervisorDto, { uid: '  040D1552  ' });
    expect(errores).toHaveLength(0);
    expect(dto.uid).toBe('040D1552');
  });

  it('un UID de 3 caracteres no pasa', () => {
    const { campos } = validar(VincularEtiquetaSupervisorDto, { uid: 'abc' });
    expect(campos).toContain('uid');
  });
});

describe('CrearPuntoSupervisorDto: no se apaga la foto obligatoria (#309)', () => {
  it('RECHAZA requiresPhoto', () => {
    const { campos } = validar(CrearPuntoSupervisorDto, {
      name: 'Porton norte',
      requiresPhoto: false,
    });
    expect(campos).toContain('requiresPhoto');
  });

  it('deja crear un acceso critico normalmente', () => {
    const { errores } = validar(CrearPuntoSupervisorDto, {
      name: 'Porton norte',
      kind: 'acceso_critico',
    });
    expect(errores).toHaveLength(0);
  });
});

describe('EditarPuntoSupervisorDto: no se degrada un acceso critico (#309)', () => {
  it('RECHAZA kind', () => {
    const { campos } = validar(EditarPuntoSupervisorDto, { kind: 'normal' });
    expect(campos).toContain('kind');
  });

  it('RECHAZA requiresPhoto', () => {
    const { campos } = validar(EditarPuntoSupervisorDto, { requiresPhoto: false });
    expect(campos).toContain('requiresPhoto');
  });

  it('deja renombrar el punto, que es lo suyo', () => {
    const { errores } = validar(EditarPuntoSupervisorDto, { name: 'Porton norte (rejilla)' });
    expect(errores).toHaveLength(0);
  });
});
