import {
  anotarFotoDeTarea,
  aplicarResultadosTareas,
  cargarPlantillaTareas,
  enviarPendientes,
  estadoTareasInicial,
  fotosDeTareaAdoptables,
  itemsDeLaPlantilla,
  loteParaEnviar,
  responderTarea,
  tareaExigeFoto,
  tareaRespondida,
  tareasDelCierre,
  tareasDelPunto,
  tareasDelPuntoPorResponder,
  tareasPendientesDeSubir,
  tareasRechazadas,
  tareasSinResponder,
  type EstadoTareas,
  type ItemTarea,
  type PlantillaTareas,
  type RespuestaParaEnviar,
  type ResultadoTarea,
} from './guard-tareas-modelo';

/**
 * Las tareas del turno en el punto (#265).
 *
 * Lo que se prueba acá es lo que decide si el guardia ve la tarea a tiempo y si
 * la evidencia llega: qué tarea toca en qué punto, cuál exige foto, y qué pasa
 * con una respuesta dada sin señal. Nada de esto se puede probar renderizando —
 * el runner de web corre solo `*.spec.ts` sin jsdom— y las tres cosas son
 * evidencia, así que viven fuera del componente a propósito.
 */

const A_LAS_ONCE: ItemTarea = {
  id: 'tarea-refrigerador',
  position: 2,
  label: 'Fotografiar el refrigerador',
  responseType: 'ok_falla',
  requiresPhotoOnFail: false,
  checkpointId: 'punto-cocina',
  dueLocalTime: '11:00:00',
  requiresPhoto: true,
};

const EN_EL_MISMO_PUNTO: ItemTarea = {
  id: 'tarea-temperatura',
  position: 1,
  label: 'Temperatura del refrigerador',
  responseType: 'numero',
  requiresPhotoOnFail: false,
  checkpointId: 'punto-cocina',
  dueLocalTime: null,
  requiresPhoto: false,
};

const EN_OTRO_PUNTO: ItemTarea = {
  id: 'tarea-porton',
  position: 3,
  label: 'Estado del portón',
  responseType: 'ok_falla',
  requiresPhotoOnFail: true,
  checkpointId: 'punto-porton',
  dueLocalTime: null,
  requiresPhoto: false,
};

/** La de siempre: sin punto, se responde en el cierre. Es lo que existía en #129. */
const DEL_CIERRE: ItemTarea = {
  id: 'tarea-libro',
  position: 4,
  label: 'Libro de novedades al día',
  responseType: 'ok_falla',
  requiresPhotoOnFail: false,
  checkpointId: null,
  dueLocalTime: null,
  requiresPhoto: false,
};

const TODAS = [A_LAS_ONCE, EN_EL_MISMO_PUNTO, EN_OTRO_PUNTO, DEL_CIERRE];

const RESPONDIDA_AT = '2026-08-08T14:03:00.000Z';

function estadoCon(...respuestas: Array<Parameters<typeof responderTarea>[1]>): EstadoTareas {
  return respuestas.reduce(responderTarea, estadoTareasInicial('patrol-1'));
}

describe('qué tarea toca en qué punto', () => {
  it('al escanear un punto salen SUS tareas, en orden de posición', () => {
    expect(tareasDelPunto(TODAS, 'punto-cocina').map((item) => item.id)).toEqual([
      'tarea-temperatura',
      'tarea-refrigerador',
    ]);
  });

  it('la tarea de otro punto no aparece: es lo que hace que el guardia vaya', () => {
    expect(tareasDelPunto(TODAS, 'punto-porton').map((item) => item.id)).toEqual(['tarea-porton']);
  });

  it('un punto sin tareas no muestra nada', () => {
    expect(tareasDelPunto(TODAS, 'punto-sin-tareas')).toEqual([]);
  });

  it('en el cierre quedan SOLO las tareas sin punto', () => {
    // Si una tarea con punto también saliera acá, el guardia la respondería dos
    // veces y la segunda moriría contra el ON CONFLICT del servidor: contestaría
    // creyendo que hace algo.
    expect(tareasDelCierre(TODAS).map((item) => item.id)).toEqual(['tarea-libro']);
  });

  it('ninguna tarea se ofrece en los dos lugares', () => {
    const enPuntos = new Set(
      ['punto-cocina', 'punto-porton'].flatMap((punto) =>
        tareasDelPunto(TODAS, punto).map((item) => item.id),
      ),
    );
    for (const item of tareasDelCierre(TODAS)) expect(enPuntos.has(item.id)).toBe(false);
  });

  it('una API vieja, sin la columna del punto, deja todo en el cierre', () => {
    // El portal se despliega antes que la API o al revés: durante ese rato los
    // items llegan sin `checkpointId`. Que se respondan en el cierre es
    // exactamente el comportamiento anterior, no una regresión.
    const viejo: ItemTarea = {
      id: 'tarea-vieja',
      position: 1,
      label: 'Extintor',
      responseType: 'ok_falla',
      requiresPhotoOnFail: false,
    };
    expect(tareasDelCierre([viejo]).map((item) => item.id)).toEqual(['tarea-vieja']);
    expect(tareasDelPunto([viejo], 'punto-cocina')).toEqual([]);
  });

  it('la plantilla llega ordenada por posición aunque el servidor la mande al revés', () => {
    const plantilla: PlantillaTareas = {
      patrolId: 'patrol-1',
      hasChecklist: true,
      template: { id: 'tpl-1', name: 'Nocturna', items: [DEL_CIERRE, A_LAS_ONCE, EN_EL_MISMO_PUNTO] },
    };
    expect(itemsDeLaPlantilla(plantilla).map((item) => item.position)).toEqual([1, 2, 4]);
  });

  it('una ronda sin checklist no tiene tareas y no rompe nada', () => {
    expect(itemsDeLaPlantilla({ patrolId: 'patrol-1', hasChecklist: false })).toEqual([]);
    expect(itemsDeLaPlantilla(undefined)).toEqual([]);
  });
});

describe('qué tarea exige foto', () => {
  it('requiresPhoto pide foto aunque esté todo bien: es el estado, no la falla', () => {
    expect(tareaExigeFoto(A_LAS_ONCE, 'ok')).toBe(true);
  });

  it('requiresPhotoOnFail pide foto SOLO al marcar falla', () => {
    expect(tareaExigeFoto(EN_OTRO_PUNTO, 'ok')).toBe(false);
    expect(tareaExigeFoto(EN_OTRO_PUNTO, 'falla')).toBe(true);
    expect(tareaExigeFoto(EN_OTRO_PUNTO, ' FALLA ')).toBe(true);
  });

  it('una tarea sin ninguna de las dos no pide foto', () => {
    expect(tareaExigeFoto(EN_EL_MISMO_PUNTO, '4')).toBe(false);
  });
});

describe('responder sin señal', () => {
  it('la respuesta queda en la cola del teléfono y sale en el lote', () => {
    const estado = estadoCon({
      item: EN_EL_MISMO_PUNTO,
      value: '4',
      respondidaAt: RESPONDIDA_AT,
      clientScanId: 'cliente-1',
    });

    expect(tareasPendientesDeSubir(estado)).toBe(1);
    expect(loteParaEnviar(estado)).toEqual([{ itemId: 'tarea-temperatura', value: '4' }]);
  });

  it('sin señal la cola queda INTACTA: no se pierde una sola respuesta', async () => {
    const estado = estadoCon({
      item: EN_EL_MISMO_PUNTO,
      value: '4',
      respondidaAt: RESPONDIDA_AT,
    });

    const despues = await enviarPendientes(estado, () => {
      throw new TypeError('Failed to fetch');
    });

    expect(despues).toEqual(estado);
    expect(tareasPendientesDeSubir(despues)).toBe(1);
  });

  it('al volver la señal se manda el lote entero y la cola se vacía', async () => {
    const estado = estadoCon(
      { item: EN_EL_MISMO_PUNTO, value: '4', respondidaAt: RESPONDIDA_AT },
      { item: DEL_CIERRE, value: 'ok', respondidaAt: RESPONDIDA_AT },
    );
    const enviados: RespuestaParaEnviar[][] = [];

    const despues = await enviarPendientes(estado, async (lote) => {
      enviados.push(lote);
      return lote.map((respuesta) => ({ itemId: respuesta.itemId, status: 'aplicado' as const }));
    });

    expect(enviados[0]?.map((respuesta) => respuesta.itemId)).toEqual([
      'tarea-temperatura',
      'tarea-libro',
    ]);
    expect(tareasPendientesDeSubir(despues)).toBe(0);
    expect(despues.enviadas).toEqual(['tarea-temperatura', 'tarea-libro']);
  });

  it('sin nada pendiente no se toca la red', async () => {
    const enviar = jest.fn();
    await enviarPendientes(estadoTareasInicial('patrol-1'), enviar);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('el reenvío del lote offline no duplica: "duplicado" cierra igual que "aplicado"', () => {
    const estado = estadoCon({
      item: DEL_CIERRE,
      value: 'ok',
      respondidaAt: RESPONDIDA_AT,
    });
    const resultados: ResultadoTarea[] = [{ itemId: 'tarea-libro', status: 'duplicado' }];

    const despues = aplicarResultadosTareas(estado, resultados);

    expect(despues.cola).toEqual([]);
    expect(despues.enviadas).toEqual(['tarea-libro']);
  });

  it('la idempotencia es por (ronda, item): responder dos veces deja UNA respuesta', () => {
    const estado = estadoCon(
      { item: EN_EL_MISMO_PUNTO, value: '4', respondidaAt: RESPONDIDA_AT },
      { item: EN_EL_MISMO_PUNTO, value: '5', respondidaAt: RESPONDIDA_AT },
    );

    // La corrección vale mientras no haya salido: esa respuesta no llegó a
    // ninguna parte todavía.
    expect(loteParaEnviar(estado)).toEqual([{ itemId: 'tarea-temperatura', value: '5' }]);
  });

  it('lo que el servidor ya aceptó no se vuelve a encolar', () => {
    const aceptada = aplicarResultadosTareas(
      estadoCon({ item: DEL_CIERRE, value: 'ok', respondidaAt: RESPONDIDA_AT }),
      [{ itemId: 'tarea-libro', status: 'aplicado' }],
    );

    const despues = responderTarea(aceptada, {
      item: DEL_CIERRE,
      value: 'falla',
      respondidaAt: RESPONDIDA_AT,
    });

    expect(despues).toEqual(aceptada);
    expect(loteParaEnviar(despues)).toEqual([]);
  });

  it('un item rechazado se queda con su motivo y no se reintenta solo', async () => {
    const estado = aplicarResultadosTareas(
      estadoCon({ item: DEL_CIERRE, value: 'tal vez', respondidaAt: RESPONDIDA_AT }),
      [{ itemId: 'tarea-libro', status: 'rechazado', reason: 'Este item solo admite "ok" o "falla"' }],
    );

    expect(tareasRechazadas(estado).map((respuesta) => respuesta.motivo)).toEqual([
      'Este item solo admite "ok" o "falla"',
    ]);
    expect(loteParaEnviar(estado)).toEqual([]);

    const enviar = jest.fn();
    await enviarPendientes(estado, enviar);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('el veredicto de otro item no toca esta respuesta', () => {
    const estado = estadoCon({ item: DEL_CIERRE, value: 'ok', respondidaAt: RESPONDIDA_AT });
    const despues = aplicarResultadosTareas(estado, [
      { itemId: 'tarea-de-otra-plantilla', status: 'aplicado' },
    ]);

    expect(tareasPendientesDeSubir(despues)).toBe(1);
  });
});

describe('la foto obligatoria de la tarea', () => {
  const respondidaConFoto = () =>
    estadoCon({
      item: A_LAS_ONCE,
      value: 'ok',
      respondidaAt: RESPONDIDA_AT,
      clientScanId: 'cliente-1',
      clientPhotoId: 'foto-cliente-1',
    });

  it('NO viaja sin su foto: mandarla la congelaría sin evidencia para siempre', () => {
    // El servidor guarda la primera respuesta y descarta las siguientes
    // (ON CONFLICT DO NOTHING). Si esta saliera ahora, la respuesta con foto que
    // viene después se descartaría en silencio y la tarea quedaría respondida y
    // sin evidencia, sin forma de corregirla desde la app.
    const estado = respondidaConFoto();

    expect(tareasPendientesDeSubir(estado)).toBe(1);
    expect(loteParaEnviar(estado)).toEqual([]);
  });

  it('con la foto arriba, la respuesta sale y lleva su photoId', () => {
    const estado = anotarFotoDeTarea(respondidaConFoto(), 'foto-cliente-1', 'foto-servidor-1');

    expect(loteParaEnviar(estado)).toEqual([
      { itemId: 'tarea-refrigerador', value: 'ok', photoId: 'foto-servidor-1' },
    ]);
  });

  it('la foto de otra tarea no le sirve a esta', () => {
    const estado = anotarFotoDeTarea(respondidaConFoto(), 'foto-de-otra-tarea', 'foto-servidor-9');

    expect(loteParaEnviar(estado)).toEqual([]);
  });

  it('la respuesta sin foto obligatoria sale igual, aunque la de al lado espere', () => {
    const estado = anotarFotoDeTarea(
      estadoCon(
        { item: A_LAS_ONCE, value: 'ok', respondidaAt: RESPONDIDA_AT, clientPhotoId: 'foto-1' },
        { item: EN_EL_MISMO_PUNTO, value: '4', respondidaAt: RESPONDIDA_AT },
      ),
      'ninguna',
      'ninguna',
    );

    expect(loteParaEnviar(estado).map((respuesta) => respuesta.itemId)).toEqual([
      'tarea-temperatura',
    ]);
  });

  it('la foto cuelga del escaneo del punto, que es el mismo camino de la foto del acceso', () => {
    const estado = respondidaConFoto();
    expect(estado.cola[0]?.clientScanId).toBe('cliente-1');
  });

  it('marcar falla en una tarea de foto-al-fallar la deja esperando la foto', () => {
    const estado = estadoCon({
      item: EN_OTRO_PUNTO,
      value: 'falla',
      notes: 'Portón forzado',
      respondidaAt: RESPONDIDA_AT,
      clientPhotoId: 'foto-2',
    });

    expect(loteParaEnviar(estado)).toEqual([]);
    expect(estado.cola[0]?.exigeFoto).toBe(true);
  });

  it('la observación viaja con la falla', () => {
    const estado = anotarFotoDeTarea(
      estadoCon({
        item: EN_OTRO_PUNTO,
        value: 'falla',
        notes: '  Portón forzado  ',
        respondidaAt: RESPONDIDA_AT,
        clientPhotoId: 'foto-2',
      }),
      'foto-2',
      'foto-servidor-2',
    );

    expect(loteParaEnviar(estado)).toEqual([
      {
        itemId: 'tarea-porton',
        value: 'falla',
        notes: 'Portón forzado',
        photoId: 'foto-servidor-2',
      },
    ]);
  });
});

describe('la foto de la tarea que quedó huérfana sin señal', () => {
  const registros = {
    'punto-cocina': { clientScanId: 'cliente-1', scanId: 'escaneo-servidor-1' },
    'punto-porton': { clientScanId: 'cliente-2' },
  };

  const respondidaSinSenal = (clientScanId: string) =>
    estadoCon({
      item: A_LAS_ONCE,
      value: 'ok',
      respondidaAt: RESPONDIDA_AT,
      clientScanId,
      clientPhotoId: 'foto-cliente-1',
    });

  it('se adopta cuando el escaneo ya tiene id en el estado de la ronda', () => {
    // El veredicto de la sincronización pasa UNA vez y muere con el WebView. Sin
    // esta reparación en frío, la respuesta espera para siempre una foto que
    // nadie sube.
    expect(fotosDeTareaAdoptables(respondidaSinSenal('cliente-1'), registros)).toEqual([
      { clientPhotoId: 'foto-cliente-1', scanId: 'escaneo-servidor-1' },
    ]);
  });

  it('el escaneo que todavía viaja en la cola no da nada que adoptar', () => {
    expect(fotosDeTareaAdoptables(respondidaSinSenal('cliente-2'), registros)).toEqual([]);
  });

  it('la foto que ya subió no se vuelve a subir', () => {
    const arriba = anotarFotoDeTarea(
      respondidaSinSenal('cliente-1'),
      'foto-cliente-1',
      'foto-servidor-1',
    );
    expect(fotosDeTareaAdoptables(arriba, registros)).toEqual([]);
  });

  it('una respuesta sin foto no inventa ninguna', () => {
    const estado = estadoCon({
      item: EN_EL_MISMO_PUNTO,
      value: '4',
      respondidaAt: RESPONDIDA_AT,
      clientScanId: 'cliente-1',
    });
    expect(fotosDeTareaAdoptables(estado, registros)).toEqual([]);
  });
});

describe('lo que le falta al guardia', () => {
  it('el punto ya respondido no vuelve a preguntar al re-escanearlo', () => {
    const estado = estadoCon({
      item: EN_EL_MISMO_PUNTO,
      value: '4',
      respondidaAt: RESPONDIDA_AT,
    });

    expect(tareasDelPuntoPorResponder(TODAS, estado, 'punto-cocina').map((item) => item.id)).toEqual(
      ['tarea-refrigerador'],
    );
  });

  it('lo que sigue sin responder se puede listar en el cierre', () => {
    const estado = estadoCon({ item: DEL_CIERRE, value: 'ok', respondidaAt: RESPONDIDA_AT });

    expect(tareasSinResponder(TODAS, estado).map((item) => item.id)).toEqual([
      'tarea-temperatura',
      'tarea-refrigerador',
      'tarea-porton',
    ]);
  });

  it('una respuesta en cola ya cuenta como respondida: no se pide dos veces', () => {
    const estado = estadoCon({ item: A_LAS_ONCE, value: 'ok', respondidaAt: RESPONDIDA_AT });
    expect(tareaRespondida(estado, 'tarea-refrigerador')).toBe(true);
    expect(tareaRespondida(estado, 'tarea-porton')).toBe(false);
  });
});

describe('persistencia', () => {
  it('sin almacenamiento (o en el servidor) no hay plantilla guardada y nada revienta', () => {
    // `guard-storage` degrada a memoria: en el runner de node no hay window, así
    // que esto comprueba que el camino sin almacenamiento devuelve "no hay" en
    // vez de romper la pantalla en terreno.
    expect(cargarPlantillaTareas('patrol-1')).toBeUndefined();
  });
});
