import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import * as Network from 'expo-network';

import { normalizarConexion } from './src/bridge/default-handlers';
import { crearPuenteNativo, type MotivoIncompatible } from './src/bridge';
import { crearManejadoresNfc } from './src/nfc/handlers';
import { puertoNfcAndroid } from './src/nfc/native-port';
import { crearCamaraQr, VistaCamaraQr } from './src/qr/camara';
import { leerRutaOffline, type RutaOfflineGuardada } from './src/offline/route-store';
import { sincronizarCola } from './src/offline/sync-queue';
import { registrarSincronizacionBackground } from './src/offline/sync-task';
import { iniciarEscuchaNfcLogin, detenerEscuchaNfcLogin } from './src/nfc/login-nfc-listener';
import mobilePackage from './package.json';

const DEVELOPMENT_URL = 'http://10.0.2.2:13000';
/**
 * Cuanto se espera antes de recargar sola, y otra vez antes de rendirse.
 * Ocho segundos porque la ronda empieza en la puerta del recinto, donde la
 * señal es mala: menos convierte una red lenta en un falso error, y mas hace
 * que el guardia crea que la app se colgo.
 */
const PACIENCIA_MS = 8_000;
/*
 * Deja inspeccionar el portal desde `chrome://inspect` de un PC, con DevTools
 * completas: consola, red, elementos.
 *
 * Solo en los perfiles que NO son de tienda (`eas.json` lo pone en `preview` y
 * no en `production`), y no es un detalle de comodidad: con la depuracion
 * abierta, cualquiera con el telefono y un cable ve la sesion, las cookies y
 * los datos del recinto. En un producto que vende trazabilidad de trabajadores
 * eso es exactamente lo que no puede pasar.
 */
const DEPURABLE = process.env.EXPO_PUBLIC_DEPURABLE === '1';
const APP_LIKE_DOCUMENT = `
  (function () {
    // Esto corre en document-start: \`document.head\` puede ser null todavia, y
    // como este guion va CONCATENADO con el del puente, una excepcion aca
    // abortaba los dos y el portal se quedaba sin puente sin saber por que.
    // El viewport tiene que estar ANTES de que la pagina se maquete, o el
    // navegador la dibuja a escala de escritorio y despues salta. Esperar a
    // DOMContentLoaded rompia el layout de forma visible.
    //
    // Si todavia no hay <head>, se crea: es valido y es lo que hace el propio
    // parser un instante despues. Lo que NO se puede es esperar.
    function cabeza() {
      if (!document.head) {
        var creada = document.createElement('head');
        document.documentElement.insertBefore(creada, document.documentElement.firstChild);
      }
      return document.head;
    }
    (function () {
      try {
        var viewport = document.querySelector('meta[name="viewport"]');
        if (!viewport) {
          viewport = document.createElement('meta');
          viewport.name = 'viewport';
          cabeza().appendChild(viewport);
        }
        viewport.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
        var style = document.createElement('style');
        style.textContent = 'body, button, a, label { -webkit-user-select: none; user-select: none; } input, textarea { -webkit-user-select: text; user-select: text; }';
        cabeza().appendChild(style);
      } catch (e) { /* cosmetico: nunca debe tumbar el puente */ }
    })();
    true;
  })();
`;

function configuredPortal(): URL {
  const raw = process.env.EXPO_PUBLIC_WEB_URL ?? DEVELOPMENT_URL;
  const parsed = new URL(raw);
  const localDevelopment =
    __DEV__ && ['localhost', '127.0.0.1', '10.0.2.2'].includes(parsed.hostname);

  if (parsed.protocol !== 'https:' && !localDevelopment) {
    throw new Error('EXPO_PUBLIC_WEB_URL debe usar HTTPS fuera del desarrollo local');
  }
  return parsed;
}

/**
 * Determina si un error HTTP es un fallo fatal de carga del portal o un evento
 * normal de subrecursos / autenticacion que debe manejar el JavaScript web.
 */
function esErrorHttpFatalPortal(
  url: string | undefined,
  statusCode: number,
  portalOrigin: string,
): boolean {
  // Codigos 4xx son controlados por la app web (401 en auth/logout, 403, 404 en assets, 429, etc.)
  if (statusCode < 500) {
    return false;
  }

  if (!url) {
    return true;
  }

  try {
    const urlObj = new URL(url);
    if (urlObj.origin !== portalOrigin) return false;
    const path = urlObj.pathname;
    if (
      path.startsWith('/api/') ||
      path.startsWith('/auth/') ||
      path.startsWith('/_next/') ||
      path.includes('favicon') ||
      /\.(svg|png|jpg|jpeg|gif|webp|ico|css|js|map|json)$/i.test(path)
    ) {
      return false;
    }
  } catch {
    return false;
  }

  // Fallos 5xx en el documento HTML raiz
  return true;
}

export default function App() {
  const portal = useMemo(configuredPortal, []);
  const webView = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [rutaOffline, setRutaOffline] = useState<RutaOfflineGuardada>();
  /*
   * Que fallo exactamente. Sin esto, cualquier problema del WebView se ve
   * igual —una pantalla que no avanza— y lo unico que la persona puede
   * reportar es "no abre". Con el motivo a la vista, un guardia en terreno
   * puede leerlo por radio y soporte sabe si es la red, el portal o el
   * componente del sistema.
   */
  const [motivoFallo, setMotivoFallo] = useState<string>();
  /** Solo se recarga sola UNA vez: en bucle taparia un fallo de verdad. */
  const reintentado = useRef(false);
  const cargadoInicialmente = useRef(false);
  const [urlActual, setUrlActual] = useState(portal.href);
  const [bloqueo, setBloqueo] = useState<{
    motivo: MotivoIncompatible | 'portal-sin-puente'; mensaje: string;
  } | null>(null);
  // La cámara del respaldo por QR (#226) vive fuera del árbol de React: el
  // puente resuelve el escaneo con una promesa y un componente que se desmonta
  // no puede resolverla. `VistaCamaraQr` solo la mira.
  const camaraQr = useMemo(crearCamaraQr, []);
  const manejadores = useMemo(
    () => crearManejadoresNfc(puertoNfcAndroid, camaraQr.lector),
    [camaraQr],
  );
  const puente = useMemo(() => crearPuenteNativo({
    portalOrigen: portal.origin,
    appVersion: mobilePackage.version,
    inyectar: (javaScript) => webView.current?.injectJavaScript(javaScript),
    manejadores,
    alIncompatible: (motivo, mensaje) => setBloqueo({ motivo, mensaje }),
  }), [manejadores, portal.origin]);

  useEffect(() => puente.detener, [puente]);

  /*
   * Si la carga no termina, se avisa. Antes la pantalla giraba para siempre.
   *
   * No es hipotetico: en un Android 9 con Chrome 124 de proveedor de WebView, el
   * componente **no llega a inicializarse** —`NoClassDefFoundError:
   * android/webkit/PacProcessor`, una clase que existe desde Android 10— asi que
   * `onLoadEnd` no dispara nunca y la app se queda en "Abriendo SentryCore..."
   * sin un solo mensaje. A un guardia con un telefono viejo le pasa lo mismo, y
   * lo unico que puede reportar es "no abre".
   *
   * 20 segundos: una ronda empieza en la puerta del recinto, donde la señal
   * suele ser mala. Menos que eso convierte una red lenta en un falso error.
   */
  useEffect(() => {
    if (!loading || failed || cargadoInicialmente.current) return undefined;
    const aviso = setTimeout(() => {
      // Primero se reintenta SOLO. Comprobado en varios telefonos: la primera
      // carga se queda colgada y la recarga entra sin problema — o sea que es
      // una carrera del arranque, no la red ni el portal.
      //
      // Pedirle al guardia que toque "Reintentar" para empezar su turno no es
      // una solucion: lo hace todos los dias, y el dia que no funcione a la
      // primera va a pensar que la app esta rota. Que lo haga la app.
      if (!reintentado.current) {
        reintentado.current = true;
        webView.current?.reload();
        return;
      }
      setMotivoFallo('La pagina no termino de cargar, ni siquiera al reintentar.');
      setLoading(false);
      setFailed(true);
    }, PACIENCIA_MS);
    return () => clearTimeout(aviso);
  }, [loading, failed]);
  useEffect(() => {
    void registrarSincronizacionBackground().catch(() => undefined);
  }, []);

  useEffect(() => {
    const subscription = Network.addNetworkStateListener((estado) => {
      puente.notificarConexion(normalizarConexion(estado));
      if (estado.isConnected === true && estado.isInternetReachable !== false) {
        void sincronizarCola().catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [puente]);

  // Escaneo continuo NFC en la pantalla de Login
  useEffect(() => {
    const enPantallaLogin = !urlActual.includes('/app');
    if (enPantallaLogin && !failed && !bloqueo) {
      void iniciarEscuchaNfcLogin((uid) => {
        const script = `
          if (window.__sentrycoreNfcLogin) {
            window.__sentrycoreNfcLogin(${JSON.stringify(uid)});
          }
          window.dispatchEvent(new CustomEvent('sentrycore:nfc:login', { detail: { uid: ${JSON.stringify(uid)} } }));
          true;
        `;
        webView.current?.injectJavaScript(script);
      });
    } else {
      detenerEscuchaNfcLogin();
    }
    return () => {
      detenerEscuchaNfcLogin();
    };
  }, [urlActual, failed, bloqueo]);

  const allowNavigation = (navigation: WebViewNavigation) => {
    try {
      const target = new URL(navigation.url);
      if (target.origin === portal.origin) {
        setUrlActual(navigation.url);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const retry = () => {
    setBloqueo(null);
    reintentado.current = false;
    setMotivoFallo(undefined);
    setFailed(false);
    setRutaOffline(undefined);
    setLoading(true);
    webView.current?.reload();
  };

  const mostrarFallo = () => {
    setLoading(false);
    setFailed(true);
    void leerRutaOffline().then(setRutaOffline).catch(() => undefined);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <WebView
        ref={webView}
        source={{ uri: portal.href }}
        applicationNameForUserAgent={`SentryCoreAndroid/${mobilePackage.version}`}
        injectedJavaScriptBeforeContentLoaded={APP_LIKE_DOCUMENT + puente.guionPrevio}
        injectedJavaScript={puente.guionPrevio}
        onMessage={puente.alRecibirMensaje}
        originWhitelist={[`${portal.protocol}//${portal.host}`]}
        onShouldStartLoadWithRequest={allowNavigation}
        onNavigationStateChange={(navState) => {
          setUrlActual(navState.url);
        }}
        onLoadStart={() => {
          if (!cargadoInicialmente.current) {
            setLoading(true);
            setFailed(false);
          }
        }}
        onLoadEnd={() => {
          cargadoInicialmente.current = true;
          setLoading(false);
        }}
        onError={({ nativeEvent }) => {
          // Ignorar abortos/cancelaciones de peticiones intermedias
          if (nativeEvent.code === -3 || nativeEvent.code === -999) {
            return;
          }
          if (!cargadoInicialmente.current) {
            setMotivoFallo(`${nativeEvent.description ?? 'error del WebView'} (codigo ${nativeEvent.code})`);
            mostrarFallo();
          }
        }}
        onHttpError={({ nativeEvent }) => {
          if (esErrorHttpFatalPortal(nativeEvent.url, nativeEvent.statusCode, portal.origin)) {
            setMotivoFallo(`El portal respondio HTTP ${nativeEvent.statusCode}`);
            mostrarFallo();
          }
        }}
        webviewDebuggingEnabled={DEPURABLE}
        javaScriptEnabled
        domStorageEnabled
        // Sin esto el selector de archivos del WebView no entrega la foto.
        allowFileAccess
        allowFileAccessFromFileURLs
        // La camara se abre sin que el usuario toque otra vez: el guardia ya
        // apreto "Tomar foto", pedirle un gesto mas es una foto menos.
        mediaPlaybackRequiresUserAction={false}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled={false}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures={false}
        pullToRefreshEnabled={false}
        overScrollMode="never"
        textZoom={100}
        style={styles.webView}
      />

      {loading && !failed ? (
        <View accessibilityRole="progressbar" style={styles.overlay}>
          <ActivityIndicator color="#2563eb" size="large" />
          <Text style={styles.loadingText}>Abriendo SentryCore…</Text>
        </View>
      ) : null}

      {failed && rutaOffline ? (
        <ScrollView accessibilityRole="summary" contentContainerStyle={styles.offlineRoute}>
          <Text style={styles.offlineBadge}>Modo sin conexión</Text>
          <Text style={styles.title}>{rutaOffline.routeName}</Text>
          <Text style={styles.description}>{rutaOffline.siteName}</Text>
          <Text style={styles.offlineHint}>
            Ruta guardada en este teléfono. Puedes consultar todos los puntos aunque no haya señal.
          </Text>
          {rutaOffline.checkpoints
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((punto) => (
              <View key={punto.id} style={styles.offlineCheckpoint}>
                <Text style={styles.offlinePosition}>{punto.position}</Text>
                <Text style={styles.offlineName}>{punto.name}</Text>
              </View>
            ))}
          <Pressable accessibilityRole="button" onPress={retry} style={styles.button}>
            <Text style={styles.buttonText}>Intentar conectar</Text>
          </Pressable>
        </ScrollView>
      ) : failed ? (
        <View accessibilityRole="alert" style={styles.overlay}>
          <Text style={styles.title}>No pudimos abrir el portal</Text>
          {/*
            Se nombran las DOS causas porque desde adentro no se distinguen, y
            decir solo "revisa tu conexión" manda a la persona a mirar donde no
            es. El componente WebView del sistema puede estar desactualizado o
            ser incompatible con la version de Android — ahi la señal esta
            perfecta y no hay nada que revisar en la red.
          */}
          <Text style={styles.description}>
            Revisa tu conexión y vuelve a intentarlo. Si tienes señal y sigue sin
            abrir, actualiza «Android System WebView» desde la Play Store y
            reinicia el teléfono.
          </Text>
          {/*
            El motivo tecnico, a la vista. Un guardia no lo va a entender, pero
            lo puede leer por radio o mandar en una foto — y eso convierte un
            "no abre" en algo que soporte puede resolver sin tener el telefono
            en la mano. Sin esto, cualquier fallo del WebView se ve igual.
          */}
          {motivoFallo ? <Text style={styles.motivo}>{motivoFallo}</Text> : null}
          <Pressable
            accessibilityRole="button"
            onPress={retry}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>Reintentar</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Va sobre el WebView: mientras se lee el QR, la vista previa tapa la
          pantalla del guardia y se cierra sola al terminar o al cancelar. */}
      <VistaCamaraQr camara={camaraQr} />

      {bloqueo ? (
        <View accessibilityRole="alert" style={styles.overlay}>
          <Text style={styles.title}>
            {bloqueo.motivo === 'app-antigua' ? 'Actualización necesaria' : 'Portal incompatible'}
          </Text>
          <Text style={styles.description}>{bloqueo.mensaje}</Text>
          {bloqueo.motivo !== 'app-antigua' ? (
            <Pressable accessibilityRole="button" onPress={retry} style={styles.button}>
              <Text style={styles.buttonText}>Reintentar</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  webView: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 28,
    backgroundColor: '#f8fafc',
  },
  motivo: {
    fontSize: 12,
    color: '#64748b',
    textAlign: 'center',
    fontFamily: 'monospace',
    marginTop: 4,
  },
  loadingText: {
    color: '#475569',
    fontSize: 16,
  },
  title: {
    color: '#0f172a',
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  description: {
    maxWidth: 320,
    color: '#475569',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  button: {
    minWidth: 160,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#2563eb',
  },
  buttonPressed: {
    backgroundColor: '#1d4ed8',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  offlineRoute: {
    minHeight: '100%',
    gap: 14,
    padding: 28,
    paddingTop: 56,
    backgroundColor: '#f8fafc',
  },
  offlineBadge: {
    alignSelf: 'center',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    color: '#713f12',
    backgroundColor: '#fef3c7',
    fontWeight: '700',
  },
  offlineHint: {
    marginBottom: 4,
    color: '#475569',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  offlineCheckpoint: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#ffffff',
  },
  offlinePosition: {
    width: 32,
    color: '#ffffff',
    borderRadius: 16,
    paddingVertical: 6,
    backgroundColor: '#1f3b73',
    fontWeight: '800',
    textAlign: 'center',
  },
  offlineName: {
    flex: 1,
    color: '#0f172a',
    fontSize: 17,
    fontWeight: '700',
  },
});
