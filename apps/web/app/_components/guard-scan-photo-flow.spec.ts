import {
  efectoDelDesenlace,
  fotosDePuntoAdoptables,
  guardarYSubirFotoDePunto,
  nuevoRegistroIdsDeEscaneo,
  type DependenciasFotoDePunto,
  type DesenlaceFotoDePunto,
  type FotoDePunto,
  type RegistroIdsDeEscaneo,
} from './guard-scan-photo-flow';
import type { FotoPendiente } from './guard-photo-store';
import type { EstadoRonda, RegistroPunto } from './guard-shift-state';

/**
 * La prueba del defecto que pierde la foto obligatoria sin señal.
 *
 * El caso real: el guardia escanea un acceso crítico sin señal, toca «Tomar
 * foto», la cámara manda el WebView al fondo y al confirmar lo devuelve al
 * frente. `visibilitychange` dispara la sincronización en el mismo instante que
 * el `onChange`, el push tarda ~300 ms y procesar la foto tarda segundos. El
 * veredicto —que pasa UNA sola vez, porque la operación sale de la cola— cae
 * justo en el medio.
 *
 * El interleaving se fuerza a mano con promesas diferidas: nada de esperas por
 * tiempo, que en una CI cargada dan pruebas que fallan solas.
 */

/** Promesa que resuelve quien escribe la prueba, para fijar el orden exacto. */
function diferido<T>(): { promesa: Promise<T>; resolver: (valor: T) => void } {
  let resolver!: (valor: T) => void;
  const promesa = new Promise<T>((cumplir) => {
    resolver = cumplir;
  });
  return { promesa, resolver };
}

const ARCHIVO = new File([new Uint8Array([1, 2, 3])], 'puerta.jpg', { type: 'image/jpeg' });
const PROCESADA = new Blob([new Uint8Array([9])], { type: 'image/jpeg' });
const TOMADA_AT = '2026-08-05T03:12:00.000Z';

const PUNTO_SIN_SENAL: FotoDePunto = {
  checkpointId: 'punto-acceso-critico',
  nombre: 'Acceso bodega',
  clientScanId: 'cliente-1',
};

interface Espia {
  deps: DependenciasFotoDePunto;
  ids: RegistroIdsDeEscaneo;
  llamadas: string[];
  guardadoCon: (string | null)[];
  fijados: [string, string][];
  subidoCon: [string, string][];
}

function espiar(opciones: {
  procesar?: () => Promise<Blob>;
  guardar?: () => Promise<void>;
  subir?: () => Promise<boolean | undefined>;
} = {}): Espia {
  const ids = nuevoRegistroIdsDeEscaneo();
  const llamadas: string[] = [];
  const guardadoCon: (string | null)[] = [];
  const fijados: [string, string][] = [];
  const subidoCon: [string, string][] = [];

  const deps: DependenciasFotoDePunto = {
    procesar: async () => {
      llamadas.push('procesar');
      return opciones.procesar ? await opciones.procesar() : PROCESADA;
    },
    guardar: async (_cliente, _foto, _tomadaAt, scanId) => {
      llamadas.push('guardar');
      guardadoCon.push(scanId);
      if (opciones.guardar) await opciones.guardar();
    },
    fijarId: async (cliente, scanId) => {
      llamadas.push('fijarId');
      fijados.push([cliente, scanId]);
    },
    subir: async (cliente, scanId) => {
      llamadas.push('subir');
      subidoCon.push([cliente, scanId]);
      return opciones.subir ? await opciones.subir() : true;
    },
    idDelEscaneo: (cliente) => ids.resolver(cliente),
    alGuardar: () => {
      llamadas.push('alGuardar');
    },
  };

  return { deps, ids, llamadas, guardadoCon, fijados, subidoCon };
}

describe('guardarYSubirFotoDePunto', () => {
  it('la foto se guarda antes de tocar la red, siempre', async () => {
    const espia = espiar();
    await guardarYSubirFotoDePunto(
      { ...PUNTO_SIN_SENAL, scanId: 'escaneo-servidor' },
      ARCHIVO,
      TOMADA_AT,
      espia.deps,
    );
    expect(espia.llamadas).toEqual(['procesar', 'guardar', 'alGuardar', 'subir']);
  });

  it('no reescribe el registro cuando ya se guardó con su id: el registro lleva megas', async () => {
    const espia = espiar();
    await guardarYSubirFotoDePunto(
      { ...PUNTO_SIN_SENAL, scanId: 'escaneo-servidor' },
      ARCHIVO,
      TOMADA_AT,
      espia.deps,
    );
    expect(espia.fijados).toEqual([]);
  });

  it('sin señal y sin veredicto: queda a salvo esperando el id, sin intentar subir', async () => {
    const espia = espiar();
    const desenlace = await guardarYSubirFotoDePunto(
      PUNTO_SIN_SENAL,
      ARCHIVO,
      TOMADA_AT,
      espia.deps,
    );

    expect(desenlace).toEqual({ clase: 'esperando_id' });
    expect(espia.guardadoCon).toEqual([null]);
    expect(espia.subidoCon).toEqual([]);
  });

  it('en línea: la foto cuelga del scanId que devolvió el escaneo', async () => {
    const espia = espiar();
    const desenlace = await guardarYSubirFotoDePunto(
      { ...PUNTO_SIN_SENAL, scanId: 'escaneo-servidor' },
      ARCHIVO,
      TOMADA_AT,
      espia.deps,
    );

    expect(desenlace).toEqual({ clase: 'subida', subida: true });
    expect(espia.guardadoCon).toEqual(['escaneo-servidor']);
    expect(espia.subidoCon).toEqual([['cliente-1', 'escaneo-servidor']]);
  });

  // ---------------------------------------------------------------- el defecto

  it('el veredicto llega MIENTRAS se procesa la foto: la foto igual sube', async () => {
    const procesando = diferido<Blob>();
    const espia = espiar({ procesar: () => procesando.promesa });

    const enVuelo = guardarYSubirFotoDePunto(PUNTO_SIN_SENAL, ARCHIVO, TOMADA_AT, espia.deps);

    // Acá está el bug: el push termina y el veredicto trae el id del escaneo
    // mientras `procesarFoto` todavía comprime. Su `fijarServerId()` no encuentra
    // la foto —no existe aún— y el veredicto no vuelve a pasar nunca.
    espia.ids.anotar('cliente-1', 'escaneo-servidor');
    procesando.resolver(PROCESADA);

    // Antes de este arreglo, el flujo decidía con el `pendiente` que capturó al
    // entrar: guardaba con `serverId = null`, anunciaba «se sube cuando vuelva la
    // señal» y esa foto no la reclamaba nadie nunca más.
    expect(await enVuelo).toEqual({ clase: 'subida', subida: true });
    // Se guardó DIRECTO con el id que llegó mientras se procesaba, así que no
    // hace falta reescribir el registro después.
    expect(espia.guardadoCon).toEqual(['escaneo-servidor']);
    expect(espia.fijados).toEqual([]);
    expect(espia.subidoCon).toEqual([['cliente-1', 'escaneo-servidor']]);
  });

  it('el veredicto llega MIENTRAS se guarda la foto: se fija el id y sube igual', async () => {
    const entroAGuardar = diferido<void>();
    const guardando = diferido<void>();
    const espia = espiar({
      guardar: () => {
        entroAGuardar.resolver();
        return guardando.promesa;
      },
    });

    const enVuelo = guardarYSubirFotoDePunto(PUNTO_SIN_SENAL, ARCHIVO, TOMADA_AT, espia.deps);
    // Rendija más angosta: el id llega después de leerlo y antes de que el
    // almacén confirme la escritura. Se espera la señal del propio doble en vez
    // de contar microtareas, que es una prueba que falla sola en una CI cargada.
    await entroAGuardar.promesa;
    espia.ids.anotar('cliente-1', 'escaneo-servidor');
    guardando.resolver();

    expect(await enVuelo).toEqual({ clase: 'subida', subida: true });
    // Se guardó con null porque el id todavía no se sabía...
    expect(espia.guardadoCon).toEqual([null]);
    // ...y por eso el almacén NO puede quedarse así: se fija antes de subir.
    expect(espia.fijados).toEqual([['cliente-1', 'escaneo-servidor']]);
    expect(espia.subidoCon).toEqual([['cliente-1', 'escaneo-servidor']]);
  });

  it('el id de un escaneo ajeno no se usa para esta foto', async () => {
    const espia = espiar();
    espia.ids.anotar('cliente-de-otro-punto', 'escaneo-de-otro-punto');

    const desenlace = await guardarYSubirFotoDePunto(
      PUNTO_SIN_SENAL,
      ARCHIVO,
      TOMADA_AT,
      espia.deps,
    );

    expect(desenlace).toEqual({ clase: 'esperando_id' });
    expect(espia.subidoCon).toEqual([]);
  });

  // ------------------------------------------------------- desenlaces de la red

  it('la subida falla: queda guardada y se dice, no se finge que subió', async () => {
    const espia = espiar({ subir: async () => false });
    const desenlace = await guardarYSubirFotoDePunto(
      { ...PUNTO_SIN_SENAL, scanId: 'escaneo-servidor' },
      ARCHIVO,
      TOMADA_AT,
      espia.deps,
    );
    expect(desenlace).toEqual({ clase: 'sin_subir', subida: false });
  });

  it('la foto ya no estaba: la subió otro camino y no se vuelve a marcar', async () => {
    const espia = espiar({ subir: async () => undefined });
    const desenlace = await guardarYSubirFotoDePunto(
      { ...PUNTO_SIN_SENAL, scanId: 'escaneo-servidor' },
      ARCHIVO,
      TOMADA_AT,
      espia.deps,
    );
    // Sin `subida`: quien la subió ya marcó el punto. Marcarlo acá con un valor
    // inventado es peor que no marcarlo.
    expect(desenlace).toEqual({ clase: 'subida' });
    expect(desenlace.subida).toBeUndefined();
  });
});

describe('nuevoRegistroIdsDeEscaneo', () => {
  it('el id se sabe recién después de anotarlo', () => {
    const ids = nuevoRegistroIdsDeEscaneo();
    expect(ids.resolver('cliente-1')).toBeUndefined();
    ids.anotar('cliente-1', 'escaneo-1');
    expect(ids.resolver('cliente-1')).toBe('escaneo-1');
  });

  it('dos rondas no se mezclan los ids', () => {
    const una = nuevoRegistroIdsDeEscaneo();
    const otra = nuevoRegistroIdsDeEscaneo();
    una.anotar('cliente-1', 'escaneo-1');
    expect(otra.resolver('cliente-1')).toBeUndefined();
  });
});

describe('fotosDePuntoAdoptables', () => {
  const registro = (parcial: Partial<RegistroPunto> & { clientScanId: string }): RegistroPunto => ({
    estado: 'escaneado',
    confirmado: true,
    anomalias: [],
    scannedAt: TOMADA_AT,
    fotoRequerida: true,
    ...parcial,
  });

  const pendiente = (parcial: Partial<FotoPendiente> & { clientEventId: string }): FotoPendiente => ({
    serverId: null,
    takenAtDevice: TOMADA_AT,
    destino: 'escaneo',
    ...parcial,
  });

  const puntos: EstadoRonda['puntos'] = {
    'punto-1': registro({ clientScanId: 'cliente-1', scanId: 'escaneo-servidor-1' }),
    'punto-2': registro({ clientScanId: 'cliente-2' }),
  };

  it('adopta la foto huérfana cuyo escaneo ya tiene id en el estado de la ronda', () => {
    expect(fotosDePuntoAdoptables([pendiente({ clientEventId: 'cliente-1' })], puntos)).toEqual([
      { clientScanId: 'cliente-1', scanId: 'escaneo-servidor-1' },
    ]);
  });

  it('no toca la que ya tiene serverId: esa la sube el camino de siempre', () => {
    const fotos = [pendiente({ clientEventId: 'cliente-1', serverId: 'escaneo-servidor-1' })];
    expect(fotosDePuntoAdoptables(fotos, puntos)).toEqual([]);
  });

  it('no toca la foto de una novedad: cuelga del evento, no de un escaneo', () => {
    const fotos = [pendiente({ clientEventId: 'cliente-1', destino: 'evento' })];
    expect(fotosDePuntoAdoptables(fotos, puntos)).toEqual([]);
  });

  it('el escaneo que todavía no sincronizó no da nada que adoptar', () => {
    expect(fotosDePuntoAdoptables([pendiente({ clientEventId: 'cliente-2' })], puntos)).toEqual([]);
  });

  it('una foto sin punto en la ronda no inventa un id', () => {
    expect(fotosDePuntoAdoptables([pendiente({ clientEventId: 'cliente-9' })], puntos)).toEqual([]);
  });

  it('cruza por clientScanId y no por el id del punto', () => {
    const fotos = [pendiente({ clientEventId: 'punto-1' })];
    expect(fotosDePuntoAdoptables(fotos, puntos)).toEqual([]);
  });

  it('sin fotos pendientes no hay nada que hacer', () => {
    expect(fotosDePuntoAdoptables([], puntos)).toEqual([]);
  });
});


describe('efectoDelDesenlace: el aviso que no llegaba a la pantalla', () => {
  const CLASES: DesenlaceFotoDePunto['clase'][] = ['esperando_id', 'subida', 'sin_subir'];

  it('la foto guardada y no subida deja el panel ABIERTO', () => {
    // El defecto: la pantalla cerraba el panel y recién después escribía el
    // aviso, que solo se pinta DENTRO del panel. Con el panel cerrado el guardia
    // no se enteraba de nada y no podía repetir la foto: un punto ya marcado no
    // vuelve a ser el siguiente en toda la ronda.
    const efecto = efectoDelDesenlace({ clase: 'sin_subir', subida: false }, 'Portón norte');

    expect(efecto.mantenerPanel).toBe(true);
    expect(efecto.aviso).toBeDefined();
    expect(efecto.guardadaSinSubir).toBe(true);
  });

  it.each(CLASES)('si hay aviso, el panel queda abierto (%s)', (clase) => {
    // La invariante, para todas las clases y para las que vengan: un aviso
    // escrito en un componente desmontado es un aviso que no existe.
    const efecto = efectoDelDesenlace({ clase }, 'Portón norte');

    if (efecto.aviso !== undefined) expect(efecto.mantenerPanel).toBe(true);
  });

  it.each(CLASES)('siempre se anuncia algo por la región viva de la lista (%s)', (clase) => {
    // El anuncio va a la lista de puntos, que está montada pase lo que pase. Es
    // la única parte del aviso que no depende de que el panel siga en pantalla.
    expect(efectoDelDesenlace({ clase }, 'Portón norte').anuncio).not.toBe('');
  });

  it('el nombre del punto viaja en el anuncio de la foto que no subió', () => {
    // El guardia camina y no mira la pantalla: si no se dice a qué puerta, el
    // anuncio no le sirve para volver.
    expect(efectoDelDesenlace({ clase: 'sin_subir', subida: false }, 'Portón norte').anuncio).toContain(
      'Portón norte',
    );
  });

  it.each(['esperando_id', 'subida'] as const)('el camino sin novedad cierra el panel (%s)', (clase) => {
    const efecto = efectoDelDesenlace({ clase }, 'Portón norte');

    expect(efecto.mantenerPanel).toBe(false);
    expect(efecto.aviso).toBeUndefined();
    expect(efecto.guardadaSinSubir).toBe(false);
  });
});
