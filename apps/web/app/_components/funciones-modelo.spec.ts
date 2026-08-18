/**
 * Pruebas de la pantalla de funciones del sistema (#102).
 *
 * Se prueban las cosas que romperian de verdad y que ningun render detecta:
 *
 *  1. Que guardar el tablero de si/no NO borre los parametros con valor. El PUT
 *     reemplaza el set completo del nivel: si el cuerpo solo llevara los
 *     interruptores, el umbral y la retencion de la empresa se irian al valor
 *     heredado sin que nadie lo pidiera.
 *  2. Que tampoco los borre mandando el set completo desde una foto vieja. Los
 *     dos paneles de la pantalla editan el mismo recurso con reemplazo total;
 *     antes de guardar hay que confirmar que la foto sigue siendo la del
 *     servidor.
 *  3. Que el techo de la licencia mande sobre la preferencia del admin, que una
 *     preferencia que quedo fuera del plan se avise antes de borrarla, y que el
 *     valor de fabrica no se congele como decision del admin.
 *  4. Que no se invente el texto de consecuencia de una regla de si/no. Decirle
 *     a un trabajador que no se registra su ubicacion mientras el servidor si
 *     la registra ya paso una vez.
 *  5. Que la pantalla no afirme de mas: lo comprobado es el nivel empresa, y las
 *     reglas que admiten excepcion mas abajo se marcan.
 *
 * Las fichas son inventadas a proposito: si el catalogo real cambia, estas
 * pruebas siguen valiendo.
 */
import type { AnyRuleParameter } from '@sentrycore/shared';

import {
  accionesDeConfiguracion,
  admiteExcepcionMasEspecifica,
  ajustesConValor,
  comprobarEnTerreno,
  consecuenciaDeclarada,
  cuerpoDelPutModulos,
  descartadosFueraDelTablero,
  estadoInicialModulos,
  etiquetaAccion,
  interruptoresDelNivel,
  mismosOverrides,
  ordenarMovimientos,
  preferenciasQueSeLimpian,
  resumenEnPalabras,
  resumirCambiosModulos,
  type FichaModulo,
  type MovimientoAuditoria,
  type VistaModulos,
} from './funciones-modelo';
import {
  construirEstado,
  cuerpoDelPut,
  type ValoresDeReglas,
  type VistaReglas,
} from './reglas-catalogo';

const NIVELES = ['platform', 'tenant', 'site', 'checkpoint'] as const;

function ficha(parcial: Record<string, unknown>): AnyRuleParameter {
  return parcial as unknown as AnyRuleParameter;
}

function modulo(parcial: Record<string, unknown>): FichaModulo {
  return parcial as unknown as FichaModulo;
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

const EXIGIR_GPS = ficha({
  key: 'exigirUbicacion',
  label: 'Exigir permiso de ubicación',
  description: 'Si el guardia no acepta compartir su ubicación, no puede iniciar la ronda.',
  type: 'boolean',
  unit: null,
  default: true,
  scopes: NIVELES,
  group: 'ubicacion',
});

const ORDEN_ALEATORIO = ficha({
  key: 'ordenAleatorio',
  label: 'Orden aleatorio de la ronda',
  description: 'Presenta los puntos en orden distinto cada vez.',
  type: 'boolean',
  unit: null,
  default: false,
  scopes: NIVELES,
  group: 'operacion',
});

const DESTINATARIOS = ficha({
  key: 'destinatarios',
  label: 'Destinatarios del informe',
  description: 'Correos que reciben el informe además de los administradores.',
  type: 'email-list',
  unit: null,
  maxItems: 10,
  default: [],
  scopes: ['tenant', 'site'],
  group: 'avisos',
});

const EDITABLES = [UMBRAL, EXIGIR_GPS, ORDEN_ALEATORIO, DESTINATARIOS];

function vistaDeEmpresa(overrides: Record<string, unknown>): VistaReglas {
  return {
    scope: 'tenant',
    targetId: null,
    effective: {},
    overrides: overrides as VistaReglas['overrides'],
    sources: {},
    layers: {},
    editable: EDITABLES,
  } as unknown as VistaReglas;
}

describe('el tablero no puede pisar lo que no muestra', () => {
  it('conserva los parámetros con valor al mover un interruptor', () => {
    // La empresa tiene el umbral y los destinatarios escritos en su nivel.
    const vista = vistaDeEmpresa({
      umbral: 85,
      destinatarios: ['jefatura@empresa.cl'],
      exigirUbicacion: true,
    });
    const estado = construirEstado(vista, NIVELES);

    // El admin apaga la exigencia de ubicacion desde el tablero.
    const campo = estado.exigirUbicacion as unknown as { propio: boolean; valor: unknown };
    campo.propio = true;
    campo.valor = false;

    const cuerpo = cuerpoDelPut(estado, vista.editable) as Record<string, unknown>;

    expect(cuerpo.exigirUbicacion).toBe(false);
    // Lo que el tablero NO pinta viaja igual: sin esto, guardar aca devolveria
    // el umbral y los destinatarios al valor heredado.
    expect(cuerpo.umbral).toBe(85);
    expect(cuerpo.destinatarios).toEqual(['jefatura@empresa.cl']);
  });

  it('separa interruptores y parámetros con valor por el tipo del catálogo', () => {
    expect(interruptoresDelNivel(EDITABLES).map((p) => p.key)).toEqual([
      'exigirUbicacion',
      'ordenAleatorio',
    ]);
    expect(ajustesConValor(EDITABLES).map((p) => p.key)).toEqual(['umbral', 'destinatarios']);
  });

  it('avisa de los parámetros ocultos que el servidor descartó', () => {
    const vista = vistaDeEmpresa({ umbral: 85 });
    const estado = construirEstado(vista, NIVELES);
    (estado.umbral as unknown as { descartado: boolean }).descartado = true;

    const trabados = descartadosFueraDelTablero(estado, ajustesConValor(EDITABLES));
    expect(trabados.map((p) => p.key)).toEqual(['umbral']);
  });
});

/**
 * El otro pisoton, el que no se ve: los dos paneles de la misma pagina editan el
 * MISMO recurso con reemplazo total, cada uno con su foto de cuando cargo. Si
 * esta comprobacion se cae, guardar un interruptor devuelve el umbral, la
 * retencion y los destinatarios al valor que tenian al abrir la pagina.
 */
describe('no se guarda encima de lo que cambió otro panel', () => {
  /** Las claves de las fichas de prueba no son claves reales de PatrolRules. */
  function overrides(valores: Record<string, unknown>): ValoresDeReglas {
    return valores as ValoresDeReglas;
  }

  const foto = overrides({
    umbral: 85,
    destinatarios: ['jefatura@empresa.cl'],
    exigirUbicacion: true,
  });

  it('reconoce la foto que no se movió', () => {
    expect(mismosOverrides(foto, overrides({ ...foto }))).toBe(true);
    // El orden de las claves no es un cambio.
    expect(
      mismosOverrides(
        foto,
        overrides({
          exigirUbicacion: true,
          destinatarios: ['jefatura@empresa.cl'],
          umbral: 85,
        }),
      ),
    ).toBe(true);
  });

  it('detecta el parámetro con valor que cambió el panel de reglas', () => {
    // Es el caso real: el admin sube el umbral en «Reglas de operación» y
    // después mueve un interruptor acá.
    expect(mismosOverrides(overrides({ ...foto, umbral: 90 }), foto)).toBe(false);
    expect(
      mismosOverrides(overrides({ ...foto, destinatarios: ['otra@empresa.cl'] }), foto),
    ).toBe(false);
  });

  it('detecta que apareció o desapareció un override', () => {
    expect(mismosOverrides(overrides({ ...foto, ordenAleatorio: true }), foto)).toBe(false);
    expect(
      mismosOverrides(
        overrides({ umbral: 85, destinatarios: ['jefatura@empresa.cl'] }),
        foto,
      ),
    ).toBe(false);
  });

  it('una clave presente en undefined es lo mismo que no estar', () => {
    // El servidor no manda undefined, pero un campo omitido y una clave con
    // undefined tienen que leerse igual: "este nivel no opina".
    expect(mismosOverrides(overrides({ ...foto, ordenAleatorio: undefined }), foto)).toBe(true);
  });
});

describe('hasta dónde alcanza lo que dice la pantalla', () => {
  const RETENCION = ficha({
    key: 'retencion',
    label: 'Retención de la traza de recorrido',
    description: 'Días que se guarda el recorrido.',
    type: 'integer',
    unit: 'days',
    default: 30,
    // Politica legal de la empresa completa: no se afina por recinto.
    scopes: ['platform', 'tenant'],
    group: 'retencion',
  });

  it('marca las reglas que un recinto o un punto puede cambiar', () => {
    expect(admiteExcepcionMasEspecifica(EXIGIR_GPS, 'tenant', NIVELES)).toBe(true);
    expect(admiteExcepcionMasEspecifica(UMBRAL, 'tenant', NIVELES)).toBe(true);
  });

  it('no las marca cuando el nivel empresa es el más específico posible', () => {
    expect(admiteExcepcionMasEspecifica(RETENCION, 'tenant', NIVELES)).toBe(false);
    // Desde el punto de control no queda nada más abajo.
    expect(admiteExcepcionMasEspecifica(EXIGIR_GPS, 'checkpoint', NIVELES)).toBe(false);
  });

  it('el orden de la cascada sale del catálogo, no de una lista escrita acá', () => {
    // Con una cascada que no incluye el nivel, no se afirma nada.
    expect(admiteExcepcionMasEspecifica(EXIGIR_GPS, 'tenant', ['platform'])).toBe(false);
  });
});

describe('módulos dentro de la licencia', () => {
  const MAPA = modulo({
    key: 'map',
    label: 'Mapa en vivo',
    description: 'Muestra por dónde va el guardia.',
    whenOff: 'Desaparece el mapa del panel.',
    default: true,
  });
  const GRAFICAS = modulo({
    key: 'chartsBySite',
    label: 'Gráficas por sucursal',
    description: 'Compara en gráficos el cumplimiento de cada recinto.',
    whenOff: 'Desaparecen los gráficos comparativos.',
    default: true,
  });
  const FALLAS = modulo({
    key: 'crashReporting',
    label: 'Reporte de fallas de la app',
    description: 'Manda el detalle técnico al proveedor.',
    whenOff: 'No se manda nada.',
    default: false,
  });

  function vistaDeModulos(parcial: Partial<VistaModulos> = {}): VistaModulos {
    return {
      plan: { key: 'base', name: 'Base' },
      enabled: { map: true, chartsBySite: false },
      sources: { map: 'plan', chartsBySite: 'admin' },
      sourceLabels: { plan: 'Plan contratado', admin: 'Decisión del administrador' },
      entitlements: { map: true, chartsBySite: true, crashReporting: false },
      entitlementSources: { map: 'plan', chartsBySite: 'plan', crashReporting: 'producto' },
      stored: { chartsBySite: false },
      editable: [MAPA, GRAFICAS],
      modules: [MAPA, GRAFICAS, FALLAS],
      ...parcial,
    } as unknown as VistaModulos;
  }

  it('solo ofrece los módulos que la licencia incluye', () => {
    const estado = estadoInicialModulos(vistaDeModulos());
    expect(Object.keys(estado).sort()).toEqual(['chartsBySite', 'map']);
    // El que no viene en el plan no aparece: no queda visible y bloqueado.
    expect(estado.crashReporting).toBeUndefined();
  });

  it('distingue lo escrito por el admin del valor de fábrica', () => {
    const estado = estadoInicialModulos(vistaDeModulos());
    expect(estado.chartsBySite?.escrito).toBe(true);
    expect(estado.chartsBySite?.origen).toBe('Decisión del administrador');
    expect(estado.map?.escrito).toBe(false);
    expect(estado.map?.origen).toBe('Plan contratado');
  });

  it('el PUT manda lo ya escrito y lo que se movió, y NO lo que nunca se decidió', () => {
    const base = estadoInicialModulos(vistaDeModulos());
    const movido = { ...base, chartsBySite: { ...base.chartsBySite!, encendido: true } };

    const cuerpo = cuerpoDelPutModulos(base, movido) as Record<string, unknown>;
    // `chartsBySite` viaja porque el admin ya lo tenia escrito (y ademas lo movio).
    expect(cuerpo.chartsBySite).toBe(true);
    // `map` NO viaja: esta en su valor de fabrica y nadie lo movio. Mandarlo lo
    // congelaria como decision del admin y le sacaria la insignia "Valor de
    // fabrica" para siempre. Omitido, el servidor cae al default del producto,
    // que es exactamente lo que rige hoy.
    expect('map' in cuerpo).toBe(false);
    // crashReporting no viaja: prenderlo fuera de licencia seria 403 y apagarlo
    // no significa nada.
    expect('crashReporting' in cuerpo).toBe(false);
  });

  it('manda el módulo en valor de fábrica en cuanto el admin lo mueve', () => {
    const base = estadoInicialModulos(vistaDeModulos());
    const movido = { ...base, map: { ...base.map!, encendido: false } };

    expect(cuerpoDelPutModulos(base, movido)).toEqual({ map: false, chartsBySite: false });
  });

  it('conserva la preferencia escrita de un módulo que no se tocó', () => {
    const base = estadoInicialModulos(vistaDeModulos());
    // Sin mover nada: lo escrito tiene que viajar igual, porque el PUT reemplaza
    // el set completo y omitirlo lo devolveria a fabrica sin que nadie lo pida.
    expect(cuerpoDelPutModulos(base, base)).toEqual({ chartsBySite: false });
  });

  it('resume solo lo que cambió', () => {
    const base = estadoInicialModulos(vistaDeModulos());
    const actual = { ...base, map: { ...base.map!, encendido: false } };
    expect(resumirCambiosModulos(base, actual)).toEqual([
      { clave: 'map', etiqueta: 'Mapa en vivo', antes: true, despues: false },
    ]);
  });

  it('avisa de las preferencias que el próximo guardado va a borrar', () => {
    const vista = vistaDeModulos({
      stored: { chartsBySite: false, crashReporting: true, moduloQueYaNoExiste: true },
    });
    const { conocidas, desconocidas } = preferenciasQueSeLimpian(vista);
    expect(conocidas.map((f) => f.key)).toEqual(['crashReporting']);
    expect(desconocidas).toBe(1);
  });
});

describe('no se inventa la consecuencia de una regla', () => {
  it('devuelve null mientras el catálogo no declare el texto', () => {
    // "Exigir ubicacion = No" significa OPCIONAL, no "no se registra nada".
    // Sin texto declarado, la pantalla no dice nada en vez de adivinar.
    expect(consecuenciaDeclarada(EXIGIR_GPS, false)).toBeNull();
    expect(consecuenciaDeclarada(EXIGIR_GPS, true)).toBeNull();
  });

  it('usa el texto del catálogo cuando existe', () => {
    const conTextos = ficha({
      ...EXIGIR_GPS,
      whenOn: 'Sin aceptar el permiso, el guardia no puede iniciar la ronda.',
      whenOff: 'Puede trabajar sin aceptar. A quien acepta se le sigue registrando la ubicación.',
    });
    expect(consecuenciaDeclarada(conTextos, true)).toContain('no puede iniciar la ronda');
    expect(consecuenciaDeclarada(conTextos, false)).toContain('se le sigue registrando');
  });

  it('ignora un texto vacío en vez de mostrar un renglón en blanco', () => {
    expect(consecuenciaDeclarada(ficha({ ...EXIGIR_GPS, whenOff: '   ' }), false)).toBeNull();
  });
});

describe('comprobación contra lo que la app lee', () => {
  const vista = vistaDeEmpresa({ umbral: 85, exigirUbicacion: false });
  const estado = construirEstado(vista, NIVELES);

  it('no marca diferencia cuando el servidor responde lo mismo', () => {
    const filas = comprobarEnTerreno(EDITABLES, estado, {
      umbral: 85,
      exigirUbicacion: false,
      ordenAleatorio: false,
      destinatarios: [],
    } as never);
    expect(filas.every((fila) => !fila.discrepa)).toBe(true);
  });

  it('marca la regla cuyo valor efectivo no coincide con lo guardado', () => {
    const filas = comprobarEnTerreno(EDITABLES, estado, {
      umbral: 70,
      exigirUbicacion: false,
      ordenAleatorio: false,
      destinatarios: [],
    } as never);
    expect(filas.filter((fila) => fila.discrepa).map((fila) => fila.clave)).toEqual(['umbral']);
  });

  it('sin respuesta del servidor no inventa filas', () => {
    expect(comprobarEnTerreno(EDITABLES, estado, null)).toEqual([]);
  });

  it('omite las reglas que el servidor no devolvió', () => {
    const filas = comprobarEnTerreno(EDITABLES, estado, { umbral: 85 } as never);
    expect(filas.map((fila) => fila.clave)).toEqual(['umbral']);
  });
});

describe('historial de auditoría', () => {
  it('pide solo las acciones de configuración que la empresa tiene registradas', () => {
    expect(
      accionesDeConfiguracion([
        'usuario.creado',
        'reglas.modificadas',
        'recinto.creado',
        'modulos.modificados',
        'sinpunto',
        '',
      ]),
    ).toEqual(['reglas.modificadas', 'modulos.modificados']);
  });

  it('junta varias respuestas, quita repetidos y deja lo más nuevo primero', () => {
    const uno: MovimientoAuditoria[] = [
      movimiento('a', '2026-08-01T10:00:00.000Z'),
      movimiento('b', '2026-08-03T10:00:00.000Z'),
    ];
    const dos: MovimientoAuditoria[] = [
      movimiento('b', '2026-08-03T10:00:00.000Z'),
      movimiento('c', '2026-08-02T10:00:00.000Z'),
    ];
    expect(ordenarMovimientos([uno, dos], 10).map((m) => m.id)).toEqual(['b', 'c', 'a']);
  });

  it('respeta el tope y no se cae con una fecha ilegible', () => {
    const lista = [
      movimiento('malo', 'no es una fecha'),
      movimiento('bueno', '2026-08-03T10:00:00.000Z'),
    ];
    const ordenados = ordenarMovimientos([lista], 1);
    expect(ordenados.map((m) => m.id)).toEqual(['bueno']);
  });

  it('nombra las acciones conocidas y no se rompe con una desconocida', () => {
    expect(etiquetaAccion('reglas.modificadas')).toBe('Reglas de operación');
    expect(etiquetaAccion('modulos.modificados')).toBe('Módulos del sistema');
    expect(etiquetaAccion('cosa_nueva.pasada')).toBe('Cosa nueva pasada');
  });

  it('cambia las claves del resumen por el nombre del catálogo', () => {
    const resumen = 'tenant: 2 regla(s) configurada(s): umbral, exigirUbicacion';
    const texto = resumenEnPalabras(resumen, EDITABLES);
    expect(texto).toContain('Toda la empresa');
    expect(texto).toContain('Umbral de cumplimiento');
    expect(texto).toContain('Exigir permiso de ubicación');
    expect(texto).not.toContain('exigirUbicacion');
  });

  it('deja intacto lo que no reconoce y tolera un resumen vacío', () => {
    expect(resumenEnPalabras('site: reglaDesconocida', EDITABLES)).toBe(
      'Un recinto: reglaDesconocida',
    );
    expect(resumenEnPalabras(null, EDITABLES)).toBe('Sin detalle');
  });
});

function movimiento(id: string, createdAt: string): MovimientoAuditoria {
  return {
    id,
    actorId: null,
    actorLabel: 'Jefa de operaciones',
    action: 'reglas.modificadas',
    entityType: 'tenant_rules',
    entityId: null,
    summary: 'tenant: 1 regla(s) configurada(s): umbral',
    createdAt,
  };
}
