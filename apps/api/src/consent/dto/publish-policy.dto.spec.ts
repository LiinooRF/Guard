import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { PublishPolicyDto } from './publish-policy.dto';

/**
 * El 500 latente del aviso de GPS, hermano del de #242.
 *
 * `POST /api/consent/policies` valida el largo del cuerpo, el servicio guarda
 * `input.body.trim()` (consent.service.ts:232) y el CHECK de la tabla mide
 * `length(trim(body)) BETWEEN 100 AND 20000`
 * (1725472800000-CreateConsentPolicies.ts:46). Sin recortar antes de validar,
 * las tres cosas miden textos distintos y la unica que rechaza es PostgreSQL,
 * cuya forma de rechazar es un 500.
 *
 * Esta prueba NO necesita base: comprueba que lo que sale del DTO es lo mismo
 * que se va a guardar. Contra el DTO de `origin/staging` los tres casos del
 * recorte fallan.
 */
function validar(payload: Record<string, unknown>) {
  // Mismas opciones que el ValidationPipe global de main.ts:23.
  const dto = plainToInstance(PublishPolicyDto, payload);
  const errores = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errores, campos: errores.map((error) => error.property) };
}

/** Aviso valido de largo exacto, para poder sumarle espacios sin perder el foco. */
const AVISO_100 = 'a'.repeat(100);

const BASE = {
  version: '2026-v1',
  body: AVISO_100,
  privacyPolicyUrl: 'https://ejemplo.test/privacidad',
};

describe('PublishPolicyDto', () => {
  it('acepta un aviso valido y no lo altera', () => {
    const { errores, dto } = validar({ ...BASE });
    expect(errores).toEqual([]);
    expect(dto.body).toBe(AVISO_100);
    expect(dto.version).toBe('2026-v1');
    expect(dto.privacyPolicyUrl).toBe('https://ejemplo.test/privacidad');
  });

  it('recorta los tres campos antes de validar', () => {
    const { errores, dto } = validar({
      version: '  2026-v1  ',
      body: `  ${AVISO_100}  `,
      privacyPolicyUrl: '  https://ejemplo.test/privacidad  ',
    });
    expect(errores).toEqual([]);
    // Lo que sale del DTO es exactamente lo que el servicio guarda.
    expect(dto.version).toBe('2026-v1');
    expect(dto.body).toBe(AVISO_100);
    expect(dto.privacyPolicyUrl).toBe('https://ejemplo.test/privacidad');
  });

  /**
   * EL BUG. 100 caracteres contando los espacios de las puntas: pasaba el
   * @MinLength(100) y llegaba al CHECK con 96.
   */
  it('un aviso que llega a 100 solo por los espacios de las puntas es 400, no 500', () => {
    const cuerpo = `  ${'a'.repeat(96)}  `;
    expect(cuerpo).toHaveLength(100);

    const { campos, dto } = validar({ ...BASE, body: cuerpo });
    expect(campos).toContain('body');
    // Y lo que se rechaza es lo que se habria guardado, no el original.
    expect(dto.body).toHaveLength(96);
  });

  it('un aviso de puros espacios es 400 y no un 500 contra el CHECK de la tabla', () => {
    const { campos } = validar({ ...BASE, body: ' '.repeat(150) });
    expect(campos).toContain('body');
  });

  it('el recorte no puede pasarse del tope: 20000 con espacios sigue siendo valido', () => {
    // El recorte solo acorta, asi que el maximo nunca se rompe por este lado.
    // Se deja escrito para que quede claro que el arreglo no abre otro agujero.
    const { errores, dto } = validar({ ...BASE, body: `  ${'a'.repeat(20_000)}  ` });
    expect(errores).toEqual([]);
    expect(dto.body).toHaveLength(20_000);
  });

  it('un aviso de 20001 caracteres sigue siendo 400', () => {
    const { campos } = validar({ ...BASE, body: 'a'.repeat(20_001) });
    expect(campos).toContain('body');
  });

  it('un valor que no es texto no revienta el recorte', () => {
    // @Transform corre antes que @IsString: si asumiera un string, un numero
    // tiraria TypeError y el 400 se transformaria en otro 500.
    const { campos } = validar({ ...BASE, body: 12345 });
    expect(campos).toContain('body');
  });
});
