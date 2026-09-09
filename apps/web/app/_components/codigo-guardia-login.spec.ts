/**
 * Ingreso del guardia con seis digitos (pedido de terreno, 09-09-2026).
 *
 * La empresa ya vive en el telefono, asi que al guardia le alcanza con su
 * codigo. Es comodo y por eso mismo hay que cuidarlo: el codigo identifica Y
 * autentica, o sea los codigos validos son tantos como guardias tenga la
 * empresa.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

const AQUI = __dirname;
const pantalla = readFileSync(join(AQUI, 'login-screen.tsx'), 'utf8');
const css = readFileSync(join(AQUI, '..', 'globals.css'), 'utf8');

describe('ingreso del guardia con su código', () => {
  it('usa el endpoint propio y no el login normal', () => {
    expect(pantalla).toContain('/auth/code-login');
  });

  /*
   * Sin empresa recordada, seis digitos no identifican a nadie: el atajo no se
   * ofrece hasta que el telefono sabe de que empresa se trata.
   */
  it('solo se ofrece cuando el teléfono ya recuerda la empresa', () => {
    expect(pantalla).toMatch(/codigoEmpresa && !editandoCodigoEmpresa \? \(\s*<button/);
  });

  it('acepta exactamente seis dígitos y descarta lo que no sea número', () => {
    expect(pantalla).toMatch(/replace\(\/\\D\/g, ''\)\.slice\(0, 6\)/);
    expect(pantalla).toMatch(/\/\^\\d\{6\}\$\/\.test\(codigoGuardia\)/);
  });

  /*
   * Un error que distinga "ese código no existe" de "ese código es de otra
   * empresa" le sirve a quien esta probando, no al guardia. Se responde igual
   * en los dos casos.
   */
  it('no dice por qué falló, salvo que sea el bloqueo', () => {
    expect(pantalla).toContain('Código incorrecto.');
    expect(pantalla).toContain('Demasiados intentos');
  });

  /*
   * El atributo `hidden` aplica `display: none` desde la hoja del NAVEGADOR, que
   * pierde contra cualquier regla propia: `.login-form > label` los deja en
   * `grid` y los campos se seguian viendo. Se descubrio en el telefono — el
   * ingreso por codigo mostraba ademas usuario y contraseña.
   */
  it('lo que se oculta en modo código se oculta de verdad', () => {
    expect(pantalla).toMatch(/<label hidden=\{usandoCodigo\}>/);
    expect(css).toMatch(/\.login-form[^{]*\[hidden\][^{]*\{[^}]*display: none/);
  });

  it('el campo es cómodo para escribir de pie', () => {
    const regla = css.match(/\.codigo-guardia-campo input \{[^}]*\}/);

    expect(regla).not.toBeNull();
    const alto = Number(regla![0].match(/min-height: ([\d.]+)rem/)![1]);
    expect(alto * 16).toBeGreaterThanOrEqual(44);
  });
});
