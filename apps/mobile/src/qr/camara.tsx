import { Camera, CameraView } from 'expo-camera';
import { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, Vibration, View } from 'react-native';

import { posicionDelEscaneo } from '../geo/posicion';
import { firmarEscaneo } from '../security/device-signature';
import { crearLectorQr, type LectorQr, type PuertoQr } from './qr-reader';

/**
 * La camara del respaldo por QR, montada sobre el WebView (#226).
 *
 * Por que un controlador afuera de React y no un componente con estado propio:
 * el puente resuelve `qr.scan.start` con una PROMESA, y una promesa no la puede
 * resolver un componente que se desmonta. El controlador vive fuera del arbol,
 * la vista solo lo mira. Asi ademas el lector se prueba entero sin renderizar
 * nada (`qr-reader.test.ts`).
 *
 * `expo-camera` funciona en Expo Go y `react-native-nfc-manager` no: este
 * archivo es la razon por la que una ronda completa se puede ejecutar sin
 * compilar un APK.
 */

export interface EstadoCamaraQr {
  readonly activa: boolean;
  readonly titulo?: string;
}

export interface CamaraQr {
  /** Lo que consume el puente. */
  readonly lector: LectorQr;
  readonly suscribir: (fn: () => void) => () => void;
  readonly estadoActual: () => EstadoCamaraQr;
  /** La vista avisa cada codigo que entra al cuadro. */
  readonly alLeer: (texto: string) => void;
  /** El boton de cerrar de la vista. Cancela como si lo pidiera el portal. */
  readonly alCancelar: () => void;
}

const APAGADA: EstadoCamaraQr = { activa: false };

export function crearCamaraQr(): CamaraQr {
  let estado: EstadoCamaraQr = APAGADA;
  const oyentes = new Set<() => void>();
  let entregarCodigo: ((texto: string) => void) | undefined;
  let fallarLectura: ((error: Error) => void) | undefined;

  function publicar(siguiente: EstadoCamaraQr): void {
    estado = siguiente;
    for (const oyente of oyentes) oyente();
  }

  const puerto: PuertoQr = {
    permisoCamara: async () => {
      const respuesta = await Camera.requestCameraPermissionsAsync();
      if (respuesta.status === 'granted') return 'concedido';
      return respuesta.canAskAgain ? 'denegado' : 'denegado-definitivo';
    },
    abrirCamara: (titulo) => publicar({ activa: true, ...(titulo ? { titulo } : {}) }),
    cerrarCamara: () => {
      // Primero se corta la espera y despues se apaga la vista: al reves, quien
      // esta esperando un codigo se queda colgado con la camara ya cerrada.
      fallarLectura?.(new Error('camara-cerrada'));
      entregarCodigo = undefined;
      fallarLectura = undefined;
      if (estado.activa) publicar(APAGADA);
    },
    esperarCodigo: () =>
      new Promise<string>((resolver, rechazar) => {
        entregarCodigo = resolver;
        fallarLectura = rechazar;
      }),
    posicion: posicionDelEscaneo,
    // El mismo pulso que confirma una etiqueta NFC: el guardia esta caminando y
    // mirando el punto, no la pantalla.
    confirmar: () => Vibration.vibrate(80),
    firmar: firmarEscaneo,
  };

  const lector = crearLectorQr(puerto);

  return {
    lector,
    suscribir: (fn) => {
      oyentes.add(fn);
      return () => oyentes.delete(fn);
    },
    estadoActual: () => estado,
    alLeer: (texto) => entregarCodigo?.(texto),
    alCancelar: () => lector.cancelar(),
  };
}

/**
 * Vista previa a pantalla completa. Se monta SIEMPRE y se pinta sola cuando hay
 * un escaneo en curso: montarla recien al escanear agregaria el arranque de la
 * camara al tiempo de la lectura.
 *
 * Las medidas no son decorativas y son las mismas de la pantalla del guardia:
 * objetivos tactiles de 48 px porque esto se usa con guantes, y contraste alto
 * porque la mitad de las rondas son de noche y la otra mitad al sol.
 */
export function VistaCamaraQr({ camara }: { camara: CamaraQr }) {
  const estado = useSyncExternalStore(camara.suscribir, camara.estadoActual, camara.estadoActual);
  if (!estado.activa) return null;

  return (
    <View style={estilos.capa}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        // Solo QR: los codigos de barras de un producto en bodega no son puntos
        // de control y solo servirian para leer basura.
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => camara.alLeer(data)}
      />
      <View style={estilos.marco} pointerEvents="none">
        <View style={estilos.mira} />
      </View>
      <View style={estilos.pie}>
        <Text style={estilos.titulo}>{estado.titulo ?? 'Código QR del punto'}</Text>
        <Text style={estilos.ayuda}>
          Apunta al código pegado en el punto. Queda registrado como respaldo.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cerrar la cámara"
          onPress={camara.alCancelar}
          style={estilos.boton}
        >
          <Text style={estilos.botonTexto}>Cerrar la cámara</Text>
        </Pressable>
      </View>
    </View>
  );
}

const estilos = StyleSheet.create({
  capa: {
    position: 'absolute',
    inset: 0,
    backgroundColor: '#000000',
  },
  marco: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mira: {
    width: 240,
    height: 240,
    borderWidth: 3,
    borderColor: '#ffffff',
    borderRadius: 16,
  },
  pie: {
    gap: 10,
    padding: 24,
    paddingBottom: 36,
    backgroundColor: 'rgba(11,18,32,.92)',
  },
  titulo: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
  },
  ayuda: {
    color: '#d7dced',
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  boton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    marginTop: 6,
    backgroundColor: '#ffffff',
  },
  botonTexto: {
    color: '#0b1220',
    fontSize: 16,
    fontWeight: '800',
  },
});
