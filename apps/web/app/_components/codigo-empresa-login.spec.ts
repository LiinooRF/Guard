/**
 * Lo que el guardia ve y lo que la pantalla manda, fijado por texto.
 *
 * Igual que `visual-system.spec.ts`: se lee el archivo fuente en vez de
 * renderizar, porque este paquete corre sus pruebas en `node` a propósito y lo
 * que hay que impedir aquí son regresiones de contrato y de vocabulario, no de
 * pintado.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pantalla = readFileSync(join(__dirname, 'login-screen.tsx'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'globals.css'), 'utf8');

describe('código de empresa en la pantalla de ingreso', () => {
  /*
   * El pedido fue explícito: en el carril del guardia la palabra "slug" no
   * aparece. Es jerga de base de datos y en una garita no significa nada.
   */
  it('al guardia se le habla de "código de empresa", nunca de slug', () => {
    const textoVisible = pantalla.match(/>[^<>{}]*[a-záéíóúñ]{4,}[^<>{}]*</gi) ?? [];
    const conJerga = textoVisible.filter((fragmento) => /slug/i.test(fragmento));
    expect(conJerga).toEqual([]);
    expect(pantalla).toContain('Código de empresa');
  });

  it('explica de dónde sale el código y que no hay que repetirlo', () => {
    expect(pantalla).toMatch(/Te lo da tu supervisor[^<]*Se guarda en este teléfono/);
  });

  it('los dos ingresos —tarjeta y contraseña— mandan el código fijado', () => {
    const envios = pantalla.match(/tenantSlug: codigoEmpresa/g) ?? [];
    expect(envios).toHaveLength(2);
  });

  /*
   * Si el servidor ya dijo cuál empresa es (el UUID de la lista), ese dato
   * manda sobre el código guardado: es una elección explícita y recién hecha.
   */
  it('el código guardado no pisa a la empresa recién elegida', () => {
    expect(pantalla).toContain('!tenantId && codigoEmpresa');
    expect(pantalla).toContain('!credenciales.tenantId && codigoEmpresa');
  });

  /*
   * Un código ajeno tiene que dejar salida. Si solo dijera "credenciales
   * inválidas" el guardia se queda golpeando la tarjeta contra un teléfono que
   * nunca le va a abrir.
   */
  it('un código que no corresponde reabre el campo para corregirlo', () => {
    const reaperturas = pantalla.match(/TENANT_CODE_MISMATCH'\) abrirEdicionDeCodigo\(\)/g) ?? [];
    expect(reaperturas).toHaveLength(2);
    expect(pantalla).toContain("result.code === 'TENANT_CODE_MISMATCH'");
  });

  it('elegir empresa en la lista lo deja fijado, sin un paso extra', () => {
    expect(pantalla).toMatch(/const elegida = tenantChoices\.find\(/);
    expect(pantalla).toContain('fijarCodigoEmpresa(elegida.tenantSlug)');
  });

  it('el campo no pelea con el teclado del teléfono', () => {
    expect(pantalla).toContain('autoCapitalize="none"');
    expect(pantalla).toContain('autoCorrect="off"');
    expect(pantalla).toContain('spellCheck={false}');
  });

  it('la empresa fijada y el botón de cambiarla tienen estilo propio', () => {
    expect(css).toMatch(/\.codigo-empresa-fijado \{/);
    expect(css).toMatch(/\.codigo-empresa-campo small \{/);
  });
});
