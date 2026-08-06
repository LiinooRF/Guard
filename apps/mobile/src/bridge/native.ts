/**
 * Lado NATIVO del puente. Traduce mensajes del portal a modulos nativos y
 * devuelve la respuesta correlacionada por `replyTo`.
 *
 * Este archivo no sabe NADA de NFC, camara ni GPS: recibe los manejadores por
 * parametro. Asi el contrato se puede probar sin dispositivo y el carril de NFC
 * (#11) puede avanzar sin tocar el protocolo.
 */
import type { WebViewMessageEvent } from 'react-native-webview';

import {
  MAJORS_SOPORTADOS,
  PROTOCOLO_MAJOR,
  PROTOCOLO_MINOR,
  armarSobre,
  comoLiteralJs,
  leerMensajePortal,
  verificarCompatibilidad,
  type CapacidadesDispositivo,
  type CodigoErrorEscaneo,
  type ErrorPuentePayload,
  type EscaneoNfcPayload,
  type EscaneoQrPayload,
  type EstadoConexionPayload,
  type HolaPayload,
  type MensajeShell,
  type MotivoIncompatible,
  type Permiso,
  type ResultadoEscaneoPayload,
  type ResultadoEscaneoQrPayload,
  type ResultadoPermisoPayload,
  type RutaOfflinePayload,
  type EncolarSyncPayload,
  type RegistrarFirmaPayload,
} from './protocol';

/**
 * Error tipado del escaneo. Los manejadores rechazan con esto para que el
 * codigo llegue intacto al portal; cualquier otro rechazo se degrada a
 * `error-desconocido` y NO se reenvia el mensaje original — un stack trace
 * puede arrastrar rutas o datos del turno y en los logs no van datos de
 * guardias.
 */
export class ErrorEscaneo extends Error {
  constructor(
    readonly codigo: CodigoErrorEscaneo,
    mensaje: string,
    readonly reintentable: boolean,
  ) {
    super(mensaje);
    this.name = 'ErrorEscaneo';
  }
}

export interface ManejadoresNativos {
  readonly capacidades: () => Promise<CapacidadesDispositivo>;
  /** Rechaza con `ErrorEscaneo`. El timeout lo aplica quien implementa. */
  readonly escanearNfc: (peticion: EscaneoNfcPayload) => Promise<ResultadoEscaneoPayload>;
  readonly cancelarEscaneo: () => void;
  /**
   * Respaldo por camara (#226). Va aparte de `escanearNfc` y no como un
   * parametro suyo porque son dos recursos distintos del telefono, con dos
   * cancelaciones distintas: cancelar el QR tiene que APAGAR la camara, que
   * ademas de bateria esta tapando la pantalla del guardia.
   */
  readonly escanearQr: (peticion: EscaneoQrPayload) => Promise<ResultadoEscaneoQrPayload>;
  readonly cancelarEscaneoQr: () => void;
  readonly pedirPermiso: (permiso: Permiso) => Promise<ResultadoPermisoPayload>;
  readonly consultarPermiso: (permiso: Permiso) => Promise<ResultadoPermisoPayload>;
  readonly estadoConexion: () => Promise<EstadoConexionPayload>;
  readonly guardarRutaOffline: (ruta: RutaOfflinePayload) => Promise<string>;
  readonly borrarRutaOffline: () => Promise<void>;
  readonly encolarSync: (payload: EncolarSyncPayload) => Promise<boolean>;
  readonly sincronizarCola: () => Promise<{ procesadas: number; pendientes: number }>;
  readonly registrarFirma: (payload: RegistrarFirmaPayload) => Promise<string>;
}

export interface OpcionesPuente {
  /** Origen exacto del portal, p.ej. `https://control.voxtilabs.cl`. */
  readonly portalOrigen: string;
  /** `version` de app.config.ts. Se muestra en soporte, no decide nada. */
  readonly appVersion: string;
  /** `webView.current?.injectJavaScript`. */
  readonly inyectar: (javaScript: string) => void;
  readonly manejadores: ManejadoresNativos;
  /** El shell debe pintar la pantalla bloqueante correspondiente. */
  readonly alIncompatible: (motivo: MotivoIncompatible, mensaje: string) => void;
  /**
   * El portal cargo pero nunca saludo. Casi siempre significa que se abrio una
   * pagina que no es el portal, o un portal anterior al puente. Sin esto, el
   * guardia se queda mirando una pantalla que no escanea y sin explicacion.
   */
  readonly alSinSaludo?: () => void;
  /** Solo `tenant_id`/`request_id` y codigos. Nunca nombres ni ubicaciones. */
  readonly alRegistrar?: (evento: string, detalle?: string) => void;
  readonly msEsperaSaludo?: number;
}

export interface PuenteNativo {
  /** Va en `injectedJavaScriptBeforeContentLoaded` del WebView. */
  readonly guionPrevio: string;
  /** Va en `onMessage` del WebView. */
  readonly alRecibirMensaje: (evento: WebViewMessageEvent) => void;
  /** Empuja un cambio de conectividad sin que el portal lo pida. */
  readonly notificarConexion: (estado: EstadoConexionPayload) => void;
  /** Corta temporizadores. Llamar al desmontar. */
  readonly detener: () => void;
}

/**
 * Preambulo que se inyecta ANTES de que cargue el documento.
 *
 * Existe por una razon de carreras: el shell puede responder `ready` antes de
 * que el bundle del portal termine de montar y registre su oyente. Sin cola, ese
 * primer mensaje se pierde y el portal queda esperando para siempre un saludo
 * que ya paso.
 */
function construirGuionPrevio(appVersion: string): string {
  const meta = JSON.stringify({
    major: PROTOCOLO_MAJOR,
    minor: PROTOCOLO_MINOR,
    soportados: MAJORS_SOPORTADOS,
    app: appVersion,
  });

  return `
(function () {
  if (window.__voxiaPuente) { return; }
  var meta = ${meta};
  var cola = [];
  var oyentes = [];
  window.__voxiaPuente = {
    protocolo: 'voxia.bridge',
    major: meta.major,
    minor: meta.minor,
    soportados: meta.soportados,
    appVersion: meta.app,
    enviar: function (json) {
      if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(json); }
    },
    suscribir: function (fn) {
      oyentes.push(fn);
      while (cola.length) { fn(cola.shift()); }
      return function () { oyentes = oyentes.filter(function (o) { return o !== fn; }); };
    },
    recibir: function (json) {
      if (!oyentes.length) { cola.push(json); return; }
      for (var i = 0; i < oyentes.length; i += 1) { oyentes[i](json); }
    }
  };
  window.dispatchEvent(new Event('voxia:puente:listo'));
})();
true;
`;
}

export function crearPuenteNativo(opciones: OpcionesPuente): PuenteNativo {
  const { manejadores, inyectar, portalOrigen, alIncompatible } = opciones;
  const registrar = opciones.alRegistrar ?? (() => undefined);
  let saludado = false;
  let listo = false;
  let bloqueado = false;

  const esperaSaludo: ReturnType<typeof setTimeout> = setTimeout(() => {
    if (!saludado) {
      registrar('puente.sin-saludo');
      opciones.alSinSaludo?.();
    }
  }, opciones.msEsperaSaludo ?? 10_000);

  function enviar(mensaje: MensajeShell): void {
    inyectar(`window.__voxiaPuente && window.__voxiaPuente.recibir(${comoLiteralJs(mensaje)}); true;`);
  }

  /**
   * El error viaja por el MISMO canal que el escaneo que lo produjo: quien pidio
   * `qr.scan.start` espera `qr.scan.result` o `qr.scan.error`, y un error del QR
   * contestado como `nfc.scan.error` deja al portal esperando hasta el timeout.
   */
  function responderError(
    tipo: 'nfc.scan.error' | 'qr.scan.error',
    replyTo: string,
    codigo: CodigoErrorEscaneo,
    mensaje: string,
    reintentable: boolean,
  ): void {
    enviar(armarSobre(tipo, { codigo, mensaje, reintentable }, { replyTo, prefijo: 'err' }));
  }

  function responderErrorPuente(replyTo: string): void {
    enviar(
      armarSobre<'error', ErrorPuentePayload>(
        'error',
        { codigo: 'error-interno', mensaje: 'La función del teléfono no respondió.' },
        { replyTo, prefijo: 'err' },
      ),
    );
  }

  async function atenderHola(id: string, payload: HolaPayload): Promise<void> {
    saludado = true;
    listo = false;
    const veredicto = verificarCompatibilidad(payload.requiere);

    if (!veredicto.ok) {
      bloqueado = true;
      registrar('puente.incompatible', veredicto.motivo);
      enviar(
        armarSobre(
          'incompatible',
          {
            motivo: veredicto.motivo,
            shell: { major: PROTOCOLO_MAJOR, minor: PROTOCOLO_MINOR },
            portalRequiere: payload.requiere,
            mensaje: veredicto.mensaje,
          },
          { replyTo: id, prefijo: 'inc' },
        ),
      );
      alIncompatible(veredicto.motivo, veredicto.mensaje);
      return;
    }

    let dispositivo: CapacidadesDispositivo;
    try {
      dispositivo = await manejadores.capacidades();
    } catch {
      registrar('puente.capacidades.error');
      responderErrorPuente(id);
      return;
    }
    registrar('puente.listo', `nfc=${String(dispositivo.tieneNfc)}`);
    enviar(
      armarSobre(
        'ready',
        {
          protocolo: { major: PROTOCOLO_MAJOR, minor: PROTOCOLO_MINOR },
          majorsSoportados: MAJORS_SOPORTADOS,
          app: { version: opciones.appVersion },
          dispositivo,
        },
        { replyTo: id, prefijo: 'rdy' },
      ),
    );
    bloqueado = false;
    listo = true;
  }

  async function atenderEscaneo(id: string, payload: EscaneoNfcPayload): Promise<void> {
    try {
      const resultado = await manejadores.escanearNfc(payload);
      enviar(armarSobre('nfc.scan.result', resultado, { replyTo: id, prefijo: 'scn' }));
    } catch (error) {
      if (error instanceof ErrorEscaneo) {
        responderError('nfc.scan.error', id, error.codigo, error.message, error.reintentable);
        return;
      }
      registrar('puente.escaneo.error-no-tipado');
      responderError('nfc.scan.error', id, 'error-desconocido', 'No se pudo leer la etiqueta.', true);
    }
  }

  async function atenderEscaneoQr(id: string, payload: EscaneoQrPayload): Promise<void> {
    try {
      const resultado = await manejadores.escanearQr(payload);
      enviar(armarSobre('qr.scan.result', resultado, { replyTo: id, prefijo: 'qrs' }));
    } catch (error) {
      if (error instanceof ErrorEscaneo) {
        responderError('qr.scan.error', id, error.codigo, error.message, error.reintentable);
        return;
      }
      registrar('puente.escaneo-qr.error-no-tipado');
      responderError('qr.scan.error', id, 'error-desconocido', 'No se pudo leer el código.', true);
    }
  }

  async function atenderPermiso(id: string, permiso: Permiso, pedir: boolean): Promise<void> {
    try {
      const resultado = pedir
        ? await manejadores.pedirPermiso(permiso)
        : await manejadores.consultarPermiso(permiso);
      enviar(armarSobre('permission.result', resultado, { replyTo: id, prefijo: 'per' }));
    } catch {
      registrar('puente.permiso.error', permiso);
      responderErrorPuente(id);
    }
  }

  function alRecibirMensaje(evento: WebViewMessageEvent): void {
    const { data, url } = evento.nativeEvent;

    /**
     * El WebView entrega mensajes de CUALQUIER documento cargado, incluido un
     * iframe de terceros o una pagina a la que se navego por un enlace. Sin este
     * chequeo, una pagina ajena podria disparar el escaneo NFC o el pedido de
     * ubicacion en segundo plano. `onShouldStartLoadWithRequest` ya restringe la
     * navegacion; esto es la segunda cerradura, y es la que importa porque los
     * iframes no pasan por ahi.
     */
    let origen = '';
    try {
      origen = new URL(url).origin;
    } catch {
      origen = '';
    }
    if (origen !== portalOrigen) {
      registrar('puente.origen-rechazado');
      return;
    }

    const lectura = leerMensajePortal(data);
    if (!lectura.ok) {
      registrar('puente.mensaje-rechazado', lectura.codigo);
      return;
    }

    const mensaje = lectura.mensaje;

    // El `hello` queda FUERA de este filtro a proposito: es el mensaje que
    // negocia la version, y atenderHola() ya responde 'incompatible' con el
    // motivo. Descartarlo aca dejaba al portal viejo esperando en silencio, sin
    // saber si la app lo escucho — y sin manera de mostrarle al guardia que
    // tiene que actualizar. El portal se despliega solo; la app tarda semanas
    // en llegarle a todos, asi que este cruce de versiones va a pasar.
    if (mensaje.type !== 'hello' && !MAJORS_SOPORTADOS.includes(mensaje.v)) {
      registrar('puente.version-rechazada', String(mensaje.v));
      return;
    }

    if (mensaje.type !== 'hello' && !listo) {
      registrar('puente.comando-antes-de-ready', mensaje.type);
      return;
    }

    // Tras declarar incompatibilidad no se atiende nada mas: seguir contestando
    // a medias produce el peor resultado posible, que es un portal creyendo que
    // escaneo cuando no escaneo nada.
    if (bloqueado && mensaje.type !== 'hello') {
      return;
    }

    switch (mensaje.type) {
      case 'hello':
        void atenderHola(mensaje.id, mensaje.payload);
        return;
      case 'nfc.scan.start':
        void atenderEscaneo(mensaje.id, mensaje.payload);
        return;
      case 'nfc.scan.cancel':
        manejadores.cancelarEscaneo();
        return;
      case 'qr.scan.start':
        void atenderEscaneoQr(mensaje.id, mensaje.payload);
        return;
      case 'qr.scan.cancel':
        manejadores.cancelarEscaneoQr();
        return;
      case 'permission.request': {
        /**
         * Ultima barrera antes de pedir ubicacion en segundo plano. Play exige
         * que la divulgacion destacada se muestre ANTES del dialogo del sistema;
         * si el portal no la mostro, el puente no pide el permiso. Es preferible
         * una funcion que no arranca a un rechazo de la ficha, que cuesta
         * semanas de calendario.
         */
        if (
          mensaje.payload.permiso === 'ubicacion-segundo-plano' &&
          !mensaje.payload.divulgacionMostrada
        ) {
          registrar('puente.divulgacion-faltante');
          enviar(
            armarSobre<'error', ErrorPuentePayload>(
              'error',
              {
                codigo: 'divulgacion-faltante',
                mensaje:
                  'No se puede pedir la ubicacion en segundo plano sin mostrar antes el aviso de uso.',
              },
              { replyTo: mensaje.id, prefijo: 'err' },
            ),
          );
          return;
        }
        void atenderPermiso(mensaje.id, mensaje.payload.permiso, true);
        return;
      }
      case 'permission.query':
        void atenderPermiso(mensaje.id, mensaje.payload.permiso, false);
        return;
      case 'offline.route.save':
        void manejadores.guardarRutaOffline(mensaje.payload)
          .then((savedAt) => enviar(armarSobre(
            'offline.route.saved',
            { patrolId: mensaje.payload.patrolId, savedAt },
            { replyTo: mensaje.id, prefijo: 'off' },
          )))
          .catch(() => {
            registrar('puente.ruta-offline.error');
            responderErrorPuente(mensaje.id);
          });
        return;
      case 'offline.route.clear':
        void manejadores.borrarRutaOffline()
          .then(() => enviar(armarSobre(
            'offline.route.cleared', {}, { replyTo: mensaje.id, prefijo: 'off' },
          )))
          .catch(() => {
            registrar('puente.ruta-offline-borrado.error');
            responderErrorPuente(mensaje.id);
          });
        return;
      case 'sync.queue.enqueue':
        void manejadores.encolarSync(mensaje.payload)
          .then((inserted) => enviar(armarSobre(
            'sync.queue.enqueued',
            { clientId: mensaje.payload.operation.clientId, inserted },
            { replyTo: mensaje.id, prefijo: 'syn' },
          )))
          .catch(() => responderErrorPuente(mensaje.id));
        return;
      case 'sync.queue.flush':
        void manejadores.sincronizarCola()
          .then((resultado) => enviar(armarSobre(
            'sync.queue.flushed',
            { processed: resultado.procesadas, pending: resultado.pendientes },
            { replyTo: mensaje.id, prefijo: 'syn' },
          )))
          .catch(() => responderErrorPuente(mensaje.id));
        return;
      case 'device.signature.register':
        void manejadores.registrarFirma(mensaje.payload)
          .then((deviceId) => enviar(armarSobre(
            'device.signature.registered', { deviceId }, { replyTo: mensaje.id, prefijo: 'sig' },
          )))
          .catch(() => responderErrorPuente(mensaje.id));
        return;
      case 'connectivity.query':
        void manejadores.estadoConexion()
          .then((estado) => enviar(
            armarSobre('connectivity.state', estado, { replyTo: mensaje.id, prefijo: 'net' }),
          ))
          .catch(() => {
            registrar('puente.conectividad.error');
            responderErrorPuente(mensaje.id);
          });
        return;
      default:
        return;
    }
  }

  return {
    guionPrevio: construirGuionPrevio(opciones.appVersion),
    alRecibirMensaje,
    notificarConexion: (estado) => {
      if (listo && !bloqueado) {
        enviar(armarSobre('connectivity.state', estado, { prefijo: 'net' }));
      }
    },
    detener: () => clearTimeout(esperaSaludo),
  };
}
