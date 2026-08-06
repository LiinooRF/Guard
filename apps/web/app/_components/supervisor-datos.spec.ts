/**
 * Pruebas del calculo del panel del supervisor (#99).
 *
 * Lo que se prueba es lo que se rompe en silencio y con la pantalla viendose
 * bien: un promedio que suma rondas que todavia no terminaron, un orden que
 * deja abajo el punto que se salta SIEMPRE, un umbral inventado cuando la regla
 * no existe, y un nombre de recinto que se pinta desde la URL.
 */

// Los globales se importan en vez de heredarse de `@types/jest`: `apps/web` no
// declara Jest entre sus dependencias —lo hereda del workspace— y con el tipado
// implicito el `typecheck` del panel se cae segun donde este instalado.
import { describe, expect, it } from '@jest/globals';

import type { PuntoOmitido, RecintoCumplimiento, RutaCumplimiento } from './stats-charts-data';
import {
  TOPE_PUNTOS_OMITIDOS,
  TOPE_RONDAS_LISTADO,
  TOPE_RUTAS,
  clasificarOmisiones,
  elegirRecinto,
  enlaceRecinto,
  esUuid,
  etiquetaEstado,
  excesoDeDuracion,
  leerReglasOmision,
  listadoTruncado,
  omisionesTruncadas,
  resumirOmisiones,
  rutasTruncadas,
  type RecintoDelCatalogo,
  type RondaSupervisor,
} from './supervisor-datos';

/* ------------------------------------------------------------------ */
/* Fabricas                                                            */
/* ------------------------------------------------------------------ */

function ronda(parcial: Partial<RondaSupervisor> & { routeName: string }): RondaSupervisor {
  return {
    id: `${parcial.routeName}-${parcial.compliancePct ?? 'x'}-${Math.random()}`,
    guardName: 'Guardia Uno',
    status: 'completada',
    scheduledStartAt: '2026-08-01T22:00:00.000Z',
    scheduledEndAt: '2026-08-02T06:00:00.000Z',
    compliancePct: null,
    ...parcial,
  };
}

function punto(parcial: Partial<PuntoOmitido> & { checkpointId: string }): PuntoOmitido {
  return {
    checkpointName: `Punto ${parcial.checkpointId}`,
    kind: 'normal',
    siteName: 'Recinto Norte',
    branchName: 'Sucursal Centro',
    expected: 10,
    missed: 1,
    missedPct: 10,
    ...parcial,
  };
}

function recinto(parcial: Partial<RecintoCumplimiento> & { siteId: string }): RecintoCumplimiento {
  return {
    siteName: 'Recinto Norte',
    branchName: 'Sucursal Centro',
    patrols: 10,
    completed: 8,
    incomplete: 1,
    expired: 1,
    open: 0,
    ratedPatrols: 10,
    compliancePct: 90,
    belowThreshold: false,
    ...parcial,
  };
}

function ruta(parcial: Partial<RutaCumplimiento> & { routeId: string }): RutaCumplimiento {
  return {
    routeName: `Ruta ${parcial.routeId}`,
    siteId: '11111111-2222-4333-8444-555555555555',
    siteName: 'Recinto Norte',
    branchName: 'Sucursal Centro',
    patrols: 10,
    completed: 8,
    incomplete: 1,
    expired: 1,
    guards: 2,
    ratedPatrols: 10,
    compliancePct: 90,
    belowThreshold: 0,
    estimatedDurationMin: 45,
    avgDurationMin: 45,
    ...parcial,
  };
}

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/* ------------------------------------------------------------------ */
/* Cumplimiento por ruta                                               */
/* ------------------------------------------------------------------ */

describe('excesoDeDuracion', () => {
  it('dice cuantos minutos se pasa la ruta de lo que declara durar', () => {
    expect(
      excesoDeDuracion(ruta({ routeId: 'a', estimatedDurationMin: 45, avgDurationMin: 62.4 })),
    ).toBe(17.4);
  });

  it('una ruta que termina antes devuelve negativo, no cero', () => {
    // Tambien dice algo: una ruta que se hace en la mitad del tiempo estimado o
    // esta mal medida, o le faltan puntos.
    expect(
      excesoDeDuracion(ruta({ routeId: 'b', estimatedDurationMin: 60, avgDurationMin: 40 })),
    ).toBe(-20);
  });

  it('sin duracion real no compara: ninguna ronda del periodo llego a iniciarse', () => {
    // Es el caso de un recinto cuyas rondas del periodo quedaron todas
    // `vencida`: nunca hubo `started_at`, asi que el servidor manda null.
    expect(excesoDeDuracion(ruta({ routeId: 'c', avgDurationMin: null }))).toBeNull();
  });

  it('una ruta sin duracion declarada no se compara contra cero', () => {
    // `routes.estimated_duration_min` es NOT NULL y CHECK > 0 en la migracion,
    // pero el dato llega por la red. Un 0 aca dejaria TODA ruta marcada como
    // pasada de tiempo y el aviso dejaria de significar nada.
    expect(
      excesoDeDuracion(ruta({ routeId: 'd', estimatedDurationMin: 0, avgDurationMin: 30 })),
    ).toBeNull();
    expect(
      excesoDeDuracion(ruta({ routeId: 'e', estimatedDurationMin: Number.NaN, avgDurationMin: 30 })),
    ).toBeNull();
  });

  it('redondea a un decimal, como el resto del panel', () => {
    expect(
      excesoDeDuracion(ruta({ routeId: 'f', estimatedDurationMin: 30, avgDurationMin: 30.06 })),
    ).toBe(0.1);
  });
});

describe('rutasTruncadas', () => {
  it('avisa cuando la respuesta vino tocando el tope y puede faltar una ruta', () => {
    const lleno = Array.from({ length: TOPE_RUTAS }, (_, indice) => ruta({ routeId: `r${indice}` }));
    expect(rutasTruncadas(lleno)).toBe(true);
    expect(rutasTruncadas(lleno.slice(1))).toBe(false);
    expect(rutasTruncadas([])).toBe(false);
  });

  it('el tope pedido es el maximo que acepta el DTO del endpoint', () => {
    // `TopQueryDto.limit` es `@Max(50)`: pedir mas devuelve 400. Si ese maximo
    // cambia, esta prueba y el DTO tienen que moverse juntos.
    expect(TOPE_RUTAS).toBe(50);
  });
});

describe('listadoTruncado', () => {
  it('avisa cuando el listado viene tocando el tope del endpoint', () => {
    const largo = Array.from({ length: TOPE_RONDAS_LISTADO }, () => ronda({ routeName: 'A' }));
    expect(listadoTruncado(largo)).toBe(true);
    expect(listadoTruncado(largo.slice(1))).toBe(false);
  });
});

describe('etiquetaEstado', () => {
  it('traduce los estados de la base, que es lo que responde la API', () => {
    // El listado de rondas trae `completada` / `en_curso`, no `completed` /
    // `in_progress`. Un mapa con las claves en ingles no revienta: deja pasar el
    // valor crudo y nadie lo nota hasta que se lee la pantalla.
    expect(etiquetaEstado('completada')).toBe('Completada');
    expect(etiquetaEstado('incompleta')).toBe('Incompleta');
    expect(etiquetaEstado('vencida')).toBe('Vencida');
    expect(etiquetaEstado('pendiente')).toBe('Pendiente');
  });

  it('un estado desconocido se muestra tal cual, no como vacio', () => {
    expect(etiquetaEstado('en_curso')).toBe('En curso');
    expect(etiquetaEstado('inventado')).toBe('inventado');
  });
});

/* ------------------------------------------------------------------ */
/* Omision cronica                                                     */
/* ------------------------------------------------------------------ */

describe('leerReglasOmision', () => {
  it('lee las dos reglas cuando vienen completas', () => {
    expect(
      leerReglasOmision({ chronicMissThresholdPct: 60, chronicMissMinPatrols: 5 }),
    ).toEqual({ umbralPct: 60, minimoRondas: 5 });
  });

  it('devuelve null si falta una: media regla no alcanza para etiquetar', () => {
    expect(leerReglasOmision({ chronicMissThresholdPct: 60 })).toBeNull();
    expect(leerReglasOmision({ chronicMissMinPatrols: 5 })).toBeNull();
    expect(leerReglasOmision({})).toBeNull();
    expect(leerReglasOmision(null)).toBeNull();
    expect(leerReglasOmision(undefined)).toBeNull();
  });

  it('rechaza lo que no puede ser una regla: % fuera de 1..100 y rondas < 1', () => {
    expect(leerReglasOmision({ chronicMissThresholdPct: 0, chronicMissMinPatrols: 5 })).toBeNull();
    expect(leerReglasOmision({ chronicMissThresholdPct: 101, chronicMissMinPatrols: 5 })).toBeNull();
    expect(leerReglasOmision({ chronicMissThresholdPct: 60, chronicMissMinPatrols: 0 })).toBeNull();
    expect(
      leerReglasOmision({ chronicMissThresholdPct: 60.5, chronicMissMinPatrols: 5 }),
    ).toBeNull();
    expect(
      leerReglasOmision({ chronicMissThresholdPct: '60', chronicMissMinPatrols: 5 }),
    ).toBeNull();
  });

  it('no copia el tope de rondas del zod: si el servidor lo sube, se acepta', () => {
    // Deliberado. El maximo de `chronicMissMinPatrols` que propone
    // INTEGRACION.md (500) vive en rules.ts y puede cambiar sin que nadie toque
    // este archivo. Si se repitiera aca, el dia que suba el panel descartaria en
    // SILENCIO un valor legitimo y volveria a "Sin umbral configurado" sin
    // mostrar ningun error. Quien valida el rango de negocio es el servidor.
    expect(
      leerReglasOmision({ chronicMissThresholdPct: 60, chronicMissMinPatrols: 900 }),
    ).toEqual({ umbralPct: 60, minimoRondas: 900 });
  });
});

describe('omisionesTruncadas', () => {
  it('avisa cuando el corte del servidor se aplico y puede faltar un punto', () => {
    // El endpoint entrega el top por CANTIDAD absoluta de omisiones
    // (`ORDER BY omitidos DESC ... LIMIT`), asi que reordenar por porcentaje
    // arregla el orden de lo que llego pero no recupera lo que quedo fuera. Si
    // la respuesta vino llena, la tarjeta tiene que decir que puede faltar el
    // punto de baja frecuencia que se salta siempre.
    const lleno = Array.from({ length: TOPE_PUNTOS_OMITIDOS }, (_, indice) =>
      punto({ checkpointId: `p${indice}` }),
    );
    expect(omisionesTruncadas(lleno)).toBe(true);
    expect(omisionesTruncadas(lleno.slice(1))).toBe(false);
    expect(omisionesTruncadas([])).toBe(false);
  });

  it('el tope pedido es el maximo que acepta el DTO del endpoint', () => {
    // `TopQueryDto.limit` es `@Max(50)`: pedir mas devuelve 400. Si algun dia
    // ese maximo cambia, esta prueba y el DTO tienen que moverse juntos.
    expect(TOPE_PUNTOS_OMITIDOS).toBe(50);
  });
});

describe('clasificarOmisiones', () => {
  const reglas = { umbralPct: 60, minimoRondas: 5 };

  it('pone arriba el punto que se salta SIEMPRE, aunque tenga menos omisiones', () => {
    // Este es el bug que la tarjeta del panel general tiene por diseño: ordena
    // por cantidad, asi que 40 de 400 tapa a 12 de 12.
    //
    // OJO con lo que esta prueba NO dice: las dos filas se le entregan a mano a
    // la funcion, asi que solo prueba el ORDEN de lo que llego. Que el 12-de-12
    // llegue depende del `ORDER BY omitidos DESC ... LIMIT` del servidor, que
    // esta funcion no controla. Eso lo cubre `omisionesTruncadas`, que es lo que
    // hace que la tarjeta lo avise en pantalla.
    const puntos = clasificarOmisiones(
      [
        punto({ checkpointId: 'muchas', expected: 400, missed: 40, missedPct: 10 }),
        punto({ checkpointId: 'siempre', expected: 12, missed: 12, missedPct: 100 }),
      ],
      reglas,
    );

    expect(puntos[0]?.checkpointId).toBe('siempre');
    expect(puntos[0]?.nivel).toBe('cronico');
    expect(puntos[1]?.nivel).toBe('ocasional');
  });

  it('no llama cronico a un punto con muestra corta, y lo manda al final', () => {
    const puntos = clasificarOmisiones(
      [
        punto({ checkpointId: 'una-vez', expected: 1, missed: 1, missedPct: 100 }),
        punto({ checkpointId: 'real', expected: 20, missed: 14, missedPct: 70 }),
      ],
      reglas,
    );

    expect(puntos.map((p) => p.checkpointId)).toEqual(['real', 'una-vez']);
    expect(puntos[1]?.nivel).toBe('muestra-corta');
  });

  it('el punto justo en el umbral es cronico; el de abajo no', () => {
    const puntos = clasificarOmisiones(
      [
        punto({ checkpointId: 'justo', expected: 10, missed: 6, missedPct: 60 }),
        punto({ checkpointId: 'casi', expected: 10, missed: 5, missedPct: 59.9 }),
      ],
      reglas,
    );
    expect(puntos.find((p) => p.checkpointId === 'justo')?.nivel).toBe('cronico');
    expect(puntos.find((p) => p.checkpointId === 'casi')?.nivel).toBe('ocasional');
  });

  it('sin reglas ordena igual pero no etiqueta nada', () => {
    const puntos = clasificarOmisiones(
      [
        punto({ checkpointId: 'bajo', expected: 100, missed: 10, missedPct: 10 }),
        punto({ checkpointId: 'alto', expected: 100, missed: 90, missedPct: 90 }),
      ],
      null,
    );

    expect(puntos.map((p) => p.checkpointId)).toEqual(['alto', 'bajo']);
    expect(puntos.every((p) => p.nivel === 'sin-clasificar')).toBe(true);
  });

  it('marca los accesos criticos, que es donde la omision pesa mas', () => {
    const puntos = clasificarOmisiones(
      [punto({ checkpointId: 'puerta', kind: 'acceso_critico', expected: 10, missed: 9, missedPct: 90 })],
      reglas,
    );
    expect(puntos[0]?.critico).toBe(true);
    expect(resumirOmisiones(puntos).criticosCronicos).toBe(1);
  });

  it('resume sin contar dos veces el mismo recinto', () => {
    const resumen = resumirOmisiones(
      clasificarOmisiones(
        [
          punto({ checkpointId: 'a', siteName: 'Norte', expected: 10, missed: 8, missedPct: 80 }),
          punto({ checkpointId: 'b', siteName: 'Norte', expected: 10, missed: 2, missedPct: 20 }),
          punto({ checkpointId: 'c', siteName: 'Sur', expected: 10, missed: 7, missedPct: 70 }),
        ],
        reglas,
      ),
    );

    expect(resumen.puntos).toBe(3);
    expect(resumen.cronicos).toBe(2);
    expect(resumen.omisiones).toBe(17);
    expect(resumen.recintos).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Alcance por recinto                                                 */
/* ------------------------------------------------------------------ */

describe('elegirRecinto', () => {
  it('con un solo recinto asignado lo abre sin pedir que se elija', () => {
    const elegido = elegirRecinto([recinto({ siteId: UUID_A, siteName: 'Bodega' })], '');
    expect(elegido?.id).toBe(UUID_A);
    expect(elegido?.nombre).toBe('Bodega');
    expect(elegido?.confirmado).toBe(true);
  });

  it('acepta el catalogo que devuelve /supervisor/sites, no solo el de las graficas', () => {
    // El catalogo de la pantalla salio primero de `compliance-by-site` —solo los
    // recintos CON rondas en el periodo— y hoy sale de `/supervisor/sites`, que
    // devuelve los asignados. Por eso el parametro es estructural: un supervisor
    // con cinco recintos y dos con actividad tiene que poder elegir los cinco.
    const desdeAsignados: RecintoDelCatalogo[] = [
      { siteId: UUID_A, siteName: 'Bodega sin rondas', branchName: 'Sucursal Centro' },
    ];
    const elegido = elegirRecinto(desdeAsignados, '');
    expect(elegido?.id).toBe(UUID_A);
    expect(elegido?.nombre).toBe('Bodega sin rondas');
    expect(elegido?.confirmado).toBe(true);
  });

  it('con varios recintos y sin filtro no elige por su cuenta', () => {
    expect(
      elegirRecinto([recinto({ siteId: UUID_A }), recinto({ siteId: UUID_B })], ''),
    ).toBeNull();
  });

  it('un id que no vino del servidor no hereda nombre de la URL', () => {
    // El nombre pintado en pantalla nunca puede salir del enlace: seria una
    // forma de afirmar que existe un recinto ajeno con ese nombre.
    const elegido = elegirRecinto([recinto({ siteId: UUID_A })], UUID_B);
    expect(elegido?.id).toBe(UUID_B);
    expect(elegido?.nombre).toBeNull();
    expect(elegido?.sucursal).toBeNull();
    expect(elegido?.confirmado).toBe(false);
  });

  it('un recinto que no tiene forma de UUID se ignora en vez de provocar un 400', () => {
    expect(elegirRecinto([recinto({ siteId: UUID_A }), recinto({ siteId: UUID_B })], 'todos'))
      .toBeNull();
    const unico = elegirRecinto([recinto({ siteId: UUID_A })], '../../admin/sites');
    expect(unico?.id).toBe(UUID_A);
  });

  it('el mismo id en mayusculas es el mismo recinto, no uno sin confirmar', () => {
    // `esUuid` acepta mayusculas y `@IsUUID()` del servidor tambien, pero la API
    // devuelve los uuid en minuscula. Sin normalizar, el `===` fallaba: la
    // consulta traia datos correctos y el panel igual pintaba "Recinto asignado"
    // y el aviso falso de "no aparece entre los que tuvieron rondas".
    const elegido = elegirRecinto(
      [recinto({ siteId: UUID_A, siteName: 'Bodega' }), recinto({ siteId: UUID_B })],
      UUID_A.toUpperCase(),
    );
    expect(elegido?.confirmado).toBe(true);
    expect(elegido?.nombre).toBe('Bodega');
    expect(elegido?.id).toBe(UUID_A);
  });

  it('un id ajeno en mayusculas se devuelve normalizado y sin confirmar', () => {
    const elegido = elegirRecinto([recinto({ siteId: UUID_A })], UUID_B.toUpperCase());
    expect(elegido?.id).toBe(UUID_B);
    expect(elegido?.confirmado).toBe(false);
    expect(elegido?.nombre).toBeNull();
  });

  it('reconoce UUIDs y rechaza lo que no lo es', () => {
    expect(esUuid(UUID_A)).toBe(true);
    expect(esUuid(UUID_A.toUpperCase())).toBe(true);
    expect(esUuid('')).toBe(false);
    expect(esUuid('1111-2222')).toBe(false);
    expect(esUuid(`${UUID_A} OR 1=1`)).toBe(false);
  });
});

describe('enlaceRecinto', () => {
  it('conserva el periodo y la sucursal al cambiar de recinto', () => {
    const enlace = enlaceRecinto(
      { desde: '2026-07-01', hasta: '2026-07-31', sucursal: 'Centro' },
      UUID_A,
    );
    expect(enlace).toBe(
      `?desde=2026-07-01&hasta=2026-07-31&sucursal=Centro&recinto=${UUID_A}#supervisor-informes`,
    );
  });

  it('sin sucursal no manda el parametro vacio', () => {
    const enlace = enlaceRecinto({ desde: '2026-07-01', hasta: '2026-07-31', sucursal: '' }, UUID_A);
    expect(enlace).not.toContain('sucursal=');
  });

  it('conserva los demas parametros de la URL, como la agrupacion de la gráfica', () => {
    // `agrupacion` la lee StatsCharts en esta misma pantalla. Armando la URL
    // desde cero se perdia, y elegir un recinto reseteaba en silencio la
    // granularidad que el usuario habia fijado arriba.
    const enlace = enlaceRecinto(
      { desde: '2026-07-01', hasta: '2026-07-31', sucursal: '' },
      UUID_A,
      { agrupacion: 'semana', desde: '2026-01-01', hasta: '2026-01-31', recinto: UUID_B },
    );

    expect(enlace).toContain('agrupacion=semana');
    expect(enlace).toContain('desde=2026-07-01');
    expect(enlace).toContain('hasta=2026-07-31');
    expect(enlace).toContain(`recinto=${UUID_A}`);
    expect(enlace).not.toContain(UUID_B);
    expect(enlace).not.toContain('2026-01-01');
  });

  it('quita la sucursal heredada cuando el filtro ya no la tiene', () => {
    const enlace = enlaceRecinto(
      { desde: '2026-07-01', hasta: '2026-07-31', sucursal: '' },
      UUID_A,
      { sucursal: 'Centro' },
    );
    expect(enlace).not.toContain('sucursal=');
  });
});
