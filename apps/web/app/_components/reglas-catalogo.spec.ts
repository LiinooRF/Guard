/**
 * El formulario de reglas se GENERA desde el catalogo (#83). Lo que se prueba
 * aca es justamente eso: que ninguna decision dependa de conocer los nombres de
 * las reglas, que heredado y propio no se confundan, y que el PUT mande el set
 * completo del nivel (omitir un campo = volver a heredarlo).
 *
 * Las fichas de prueba son inventadas a proposito: si el catalogo real cambia,
 * estas pruebas siguen valiendo.
 */
import type { AnyRuleParameter } from '@voxia/shared';

import {
  agruparParaFormulario,
  construirEstado,
  contarPropios,
  cuerpoDelPut,
  deOrigen,
  formatearValor,
  frasesDelCambio,
  resumirCambios,
  validarFormulario,
  type CatalogoReglas,
  type EstadoReglas,
  type VistaReglas,
} from './reglas-catalogo';

const NIVELES = ['platform', 'tenant', 'site', 'checkpoint'] as const;

function ficha(parcial: Record<string, unknown>): AnyRuleParameter {
  return parcial as unknown as AnyRuleParameter;
}

const UMBRAL = ficha({
  key: 'umbral',
  label: 'Umbral de cumplimiento',
  description: 'Bajo este porcentaje el informe llega directo al administrador.',
  type: 'integer',
  unit: 'percent',
  min: 0,
  max: 100,
  default: 70,
  scopes: ['platform', 'tenant', 'site'],
  group: 'cumplimiento',
});

const FOTO = ficha({
  key: 'fotoFueraDeHorario',
  label: 'Foto fuera de horario',
  description: 'Fuera del horario del recinto, el guardia fotografía cada punto.',
  type: 'boolean',
  unit: null,
  default: true,
  scopes: NIVELES,
  group: 'evidencia',
});

const DESTINATARIOS = ficha({
  key: 'destinatarios',
  label: 'Destinatarios del informe',
  description: 'Correos que reciben el informe además de los administradores.',
  type: 'email-list',
  unit: null,
  maxItems: 2,
  default: [],
  scopes: ['tenant', 'site'],
  group: 'avisos',
});

const CRITICIDADES = ficha({
  key: 'criticidades',
  label: 'Criticidades que escalan',
  description: 'Qué nivel de novedad despierta la cadena de avisos.',
  type: 'multi-select',
  unit: null,
  options: ['media', 'alta', 'panico'],
  default: ['alta', 'panico'],
  scopes: ['tenant', 'site'],
  group: 'avisos',
});

const REGLA_NUEVA = ficha({
  key: 'reglaNueva',
  label: 'Regla recién agregada',
  description: 'Vino del backend con un grupo que la web todavía no conoce.',
  type: 'boolean',
  unit: null,
  default: false,
  scopes: ['tenant'],
  group: 'grupo-que-no-existe',
});

const CATALOGO: CatalogoReglas = {
  parameters: [UMBRAL, FOTO, DESTINATARIOS, CRITICIDADES],
  scopes: NIVELES,
  valueTypes: ['boolean', 'integer', 'email-list', 'multi-select'],
  groups: ['cumplimiento', 'evidencia', 'avisos'] as never,
  groupLabels: {
    cumplimiento: 'Cumplimiento de rondas',
    evidencia: 'Evidencia fotográfica',
    avisos: 'Avisos y escalamiento',
  },
  unitLabels: { percent: '%', days: 'dias' },
};

/** Vista del nivel recinto: la plataforma y la empresa ya opinaron. */
function vistaRecinto(overrides: Record<string, unknown> = {}): VistaReglas {
  return {
    scope: 'site',
    targetId: 'recinto-1',
    effective: { ...({ umbral: 80, fotoFueraDeHorario: true } as never), ...overrides } as never,
    overrides: overrides as never,
    sources: {
      ...({ umbral: 'umbral' in overrides ? 'site' : 'tenant', fotoFueraDeHorario: 'platform' } as never),
    },
    layers: {
      platform: { fotoFueraDeHorario: false } as never,
      tenant: { umbral: 80 } as never,
      site: overrides as never,
    },
    editable: [UMBRAL, FOTO, DESTINATARIOS, CRITICIDADES],
  };
}

describe('generación del formulario desde el catálogo', () => {
  it('agrupa en el orden del catálogo y solo con lo editable en el nivel', () => {
    const grupos = agruparParaFormulario([UMBRAL, DESTINATARIOS], CATALOGO);

    expect(grupos.map((grupo) => grupo.etiqueta)).toEqual([
      'Cumplimiento de rondas',
      'Avisos y escalamiento',
    ]);
    expect(grupos[0]?.parametros).toEqual([UMBRAL]);
  });

  it('no esconde una regla nueva cuyo grupo la web todavía no conoce', () => {
    const grupos = agruparParaFormulario([UMBRAL, REGLA_NUEVA], CATALOGO);
    const otros = grupos.find((grupo) => grupo.grupo === 'otros');

    expect(otros?.parametros).toEqual([REGLA_NUEVA]);
  });
});

describe('heredado vs. propio', () => {
  it('marca como heredado lo que este nivel no escribe, con su origen real', () => {
    const estado = construirEstado(vistaRecinto(), CATALOGO.scopes);

    // La empresa fijó el umbral: el recinto lo hereda de ahí.
    expect(estado.umbral).toMatchObject({ propio: false, valor: 80, origenHeredado: 'tenant' });
    // La plataforma apagó la foto fuera de horario.
    expect(estado.fotoFueraDeHorario).toMatchObject({
      propio: false,
      valor: false,
      origenHeredado: 'platform',
    });
    // Nadie opinó: queda el valor de fábrica del catálogo.
    expect(estado.criticidades).toMatchObject({
      propio: false,
      valor: ['alta', 'panico'],
      origenHeredado: 'default',
    });
  });

  it('marca como propio lo que sí está escrito en este nivel', () => {
    const estado = construirEstado(vistaRecinto({ umbral: 95 }), CATALOGO.scopes);

    expect(estado.umbral).toMatchObject({ propio: true, valor: 95, heredado: 80 });
    expect(contarPropios(estado, vistaRecinto().editable)).toBe(1);
  });

  it('avisa cuando el nivel tiene guardado un valor que el servidor descartó', () => {
    const vista = vistaRecinto({ umbral: 4000 });
    // El servidor resolvió el efectivo desde la empresa: lo guardado no se aplicó.
    vista.sources = { umbral: 'tenant' } as never;

    expect(construirEstado(vista, CATALOGO.scopes).umbral?.descartado).toBe(true);
  });
});

describe('cuerpo del PUT', () => {
  it('manda solo lo propio del nivel: omitir un campo es volver a heredarlo', () => {
    const vista = vistaRecinto({ umbral: 95, destinatarios: ['jefatura@empresa.cl'] });
    const estado = construirEstado(vista, CATALOGO.scopes);
    const sinUmbral: EstadoReglas = {
      ...estado,
      umbral: { ...estado.umbral!, propio: false, valor: estado.umbral!.heredado },
    };

    expect(cuerpoDelPut(estado, vista.editable)).toEqual({
      umbral: 95,
      destinatarios: ['jefatura@empresa.cl'],
    });
    expect(cuerpoDelPut(sinUmbral, vista.editable)).toEqual({
      destinatarios: ['jefatura@empresa.cl'],
    });
  });

  it('nunca manda un parámetro que este nivel no admite (sería un 400)', () => {
    const vista = vistaRecinto({ umbral: 95 });
    const estado = construirEstado(vista, CATALOGO.scopes);

    // El punto de control no configura el umbral: no está en editable.
    expect(cuerpoDelPut(estado, [FOTO])).toEqual({});
  });

  it('normaliza lo que escribió la persona al tipo que declara el catálogo', () => {
    const vista = vistaRecinto({ umbral: 95, destinatarios: [] });
    const estado = construirEstado(vista, CATALOGO.scopes);
    const editado: EstadoReglas = {
      ...estado,
      umbral: { ...estado.umbral!, valor: '88' },
      destinatarios: {
        ...estado.destinatarios!,
        propio: true,
        valor: 'jefatura@empresa.cl\n\noperaciones@empresa.cl',
      },
      criticidades: { ...estado.criticidades!, propio: true, valor: ['panico', 'media'] },
    };

    expect(cuerpoDelPut(editado, vista.editable)).toEqual({
      umbral: 88,
      destinatarios: ['jefatura@empresa.cl', 'operaciones@empresa.cl'],
      // Se guarda en el orden del catálogo, no en el que se marcó.
      criticidades: ['media', 'panico'],
    });
  });
});

describe('resumen de cambios', () => {
  it('distingue definir, ajustar y volver a heredar', () => {
    const vista = vistaRecinto({ umbral: 95 });
    const base = construirEstado(vista, CATALOGO.scopes);
    const actual: EstadoReglas = {
      ...base,
      umbral: { ...base.umbral!, valor: 90 },
      fotoFueraDeHorario: { ...base.fotoFueraDeHorario!, propio: true, valor: true },
    };
    const conHerencia: EstadoReglas = {
      ...base,
      umbral: { ...base.umbral!, propio: false, valor: base.umbral!.heredado },
    };

    expect(resumirCambios(base, actual, vista.editable)).toEqual([
      expect.objectContaining({ clave: 'umbral', tipo: 'ajustado', antes: 95, despues: 90 }),
      expect.objectContaining({ clave: 'fotoFueraDeHorario', tipo: 'definido', antes: false, despues: true }),
    ]);
    expect(resumirCambios(base, conHerencia, vista.editable)).toEqual([
      expect.objectContaining({ tipo: 'heredado', antes: 95, despues: 80, origenDestino: 'tenant' }),
    ]);
  });

  it('no reporta cambios cuando nadie tocó nada', () => {
    const vista = vistaRecinto({ umbral: 95 });
    const estado = construirEstado(vista, CATALOGO.scopes);

    expect(resumirCambios(estado, construirEstado(vista, CATALOGO.scopes), vista.editable)).toEqual([]);
  });
});

describe('validación con los límites del catálogo', () => {
  it('rechaza fuera de rango y correos mal escritos, solo en lo propio', () => {
    const vista = vistaRecinto({ umbral: 95 });
    const base = construirEstado(vista, CATALOGO.scopes);
    const estado: EstadoReglas = {
      ...base,
      umbral: { ...base.umbral!, valor: 140 },
      destinatarios: { ...base.destinatarios!, propio: true, valor: ['no-es-correo'] },
    };

    expect(validarFormulario(estado, vista.editable)).toEqual({
      umbral: 'El máximo permitido es 100.',
      destinatarios: '"no-es-correo" no parece un correo válido.',
    });
    // Heredado no se valida: no viaja en el PUT.
    expect(validarFormulario(base, vista.editable)).toEqual({});
  });

  it('respeta el tope de correos que declara el catálogo', () => {
    const vista = vistaRecinto();
    const base = construirEstado(vista, CATALOGO.scopes);
    const estado: EstadoReglas = {
      ...base,
      destinatarios: {
        ...base.destinatarios!,
        propio: true,
        valor: ['a@b.cl', 'c@d.cl', 'e@f.cl'],
      },
    };

    expect(validarFormulario(estado, vista.editable).destinatarios).toBe(
      'Como máximo 2 correos. Hay 3.',
    );
  });
});

describe('valores en lenguaje del cliente', () => {
  it('usa la unidad del catálogo y no una tabla escrita en la web', () => {
    expect(formatearValor(UMBRAL, 70, CATALOGO.unitLabels)).toBe('70 %');
    expect(formatearValor(FOTO, true, CATALOGO.unitLabels)).toBe('Sí');
    expect(formatearValor(DESTINATARIOS, [], CATALOGO.unitLabels)).toBe('sin destinatarios extra');
    expect(formatearValor(CRITICIDADES, ['alta'], CATALOGO.unitLabels)).toBe('alta');
  });

  it('nombra el nivel del que se hereda sin escribir "de el"', () => {
    const vista = vistaRecinto({ umbral: 95 });
    const base = construirEstado(vista, CATALOGO.scopes);
    const [aLaEmpresa] = resumirCambios(
      base,
      { ...base, umbral: { ...base.umbral!, propio: false, valor: base.umbral!.heredado } },
      vista.editable,
    );

    expect(frasesDelCambio(aLaEmpresa!, CATALOGO.unitLabels)).toBe(
      'vuelve a heredarse de la empresa: queda en 80 % (acá decía 95 %)',
    );
    expect(deOrigen('default')).toBe('del valor de fábrica');
    expect(deOrigen('checkpoint')).toBe('del punto de control');
  });
});
