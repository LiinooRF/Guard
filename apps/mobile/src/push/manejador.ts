import { leerDeepLink, rutaDePortal } from './deep-link';
import type { Desuscribir } from './proveedor';
import {
  darDeBajaDispositivo,
  registrarDispositivo,
  type OpcionesRegistro,
  type ResultadoRegistro,
} from './registro';

/**
 * Lado de la app: junta permiso, registro del token y resolucion del deep link.
 *
 * LA COLA DE RUTA PENDIENTE ES EL CORAZON DE ESTE ARCHIVO. Cuando el usuario
 * toca una notificacion con la app cerrada, el sistema arranca el proceso y
 * entrega el toque ANTES de que el WebView haya cargado el portal. Si la ruta
 * se navegara en ese momento se perderia, y el supervisor terminaria en la
 * pantalla de inicio preguntandose que paso con el panico. Es la misma carrera
 * que resuelve el preambulo del puente (`bridge/native.ts`), y se resuelve
 * igual: se encola y se vacia cuando el otro lado avisa que esta listo.
 *
 * SE GUARDA SOLO LA ULTIMA. Dos toques seguidos son dos avisos, pero abrir dos
 * pantallas una tras otra no le sirve a nadie: gana el ultimo.
 */

export interface OpcionesPushDeApp extends OpcionesRegistro {
  /** Navega el WebView a una ruta RELATIVA del portal. */
  readonly abrirRuta: (ruta: string) => void;
}

export interface PushDeApp {
  /** Suscribe los eventos del proveedor e intenta registrar el dispositivo. */
  iniciar(): void;
  /** El portal ya cargo: vacia la ruta pendiente, si la hay. */
  marcarPortalListo(): void;
  /** Reintento tras iniciar sesion en el portal (el primer intento da 401). */
  reintentarRegistro(): Promise<ResultadoRegistro>;
  /** Cierre de sesion: el dispositivo deja de recibir alertas de ese usuario. */
  cerrarSesion(): Promise<void>;
  /** Corta las suscripciones. Llamar al desmontar. */
  detener(): void;
}

export function crearPushDeApp(opciones: OpcionesPushDeApp): PushDeApp {
  const registrar = opciones.registrar ?? (() => undefined);
  const bajas: Desuscribir[] = [];
  let portalListo = false;
  let pendiente: string | null = null;

  function navegar(ruta: string): void {
    if (!portalListo) {
      pendiente = ruta;
      registrar('push.deep-link.encolado');
      return;
    }
    opciones.abrirRuta(ruta);
  }

  function alTocar(datos: Record<string, unknown>): void {
    const lectura = leerDeepLink(datos);
    if (!lectura.ok) {
      // Nunca se rompe la notificacion: se abre el inicio y se registra el
      // motivo. `version-no-soportada` significa que hay shells anteriores al
      // deploy y que ese contrato todavia no se puede retirar.
      registrar('push.deep-link.degradado', lectura.motivo);
    }
    navegar(rutaDePortal(lectura.deepLink));
  }

  return {
    iniciar() {
      bajas.push(opciones.proveedor.alTocarNotificacion(alTocar));
      // El sistema rota el token sin avisar al usuario. Sin reregistrar, el
      // supervisor deja de recibir alertas y nadie se entera.
      bajas.push(
        opciones.proveedor.alRotarToken(() => {
          void registrarDispositivo(opciones);
        }),
      );
      void registrarDispositivo(opciones);
    },

    marcarPortalListo() {
      portalListo = true;
      if (pendiente === null) return;
      const ruta = pendiente;
      pendiente = null;
      opciones.abrirRuta(ruta);
    },

    reintentarRegistro() {
      return registrarDispositivo(opciones);
    },

    async cerrarSesion() {
      await darDeBajaDispositivo(opciones);
      // Una ruta encolada de la sesion anterior no se abre en la siguiente.
      pendiente = null;
    },

    detener() {
      while (bajas.length > 0) {
        bajas.pop()?.();
      }
    },
  };
}
