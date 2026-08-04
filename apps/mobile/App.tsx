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
import { leerRutaOffline, type RutaOfflineGuardada } from './src/offline/route-store';
import { sincronizarCola } from './src/offline/sync-queue';
import { registrarSincronizacionBackground } from './src/offline/sync-task';
import mobilePackage from './package.json';

const DEVELOPMENT_URL = 'http://10.0.2.2:13000';
const APP_LIKE_DOCUMENT = `
  (function () {
    var viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      viewport = document.createElement('meta');
      viewport.name = 'viewport';
      document.head.appendChild(viewport);
    }
    viewport.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
    var style = document.createElement('style');
    style.textContent = 'body, button, a, label { -webkit-user-select: none; user-select: none; } input, textarea { -webkit-user-select: text; user-select: text; }';
    document.head.appendChild(style);
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

export default function App() {
  const portal = useMemo(configuredPortal, []);
  const webView = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [rutaOffline, setRutaOffline] = useState<RutaOfflineGuardada>();
  const [bloqueo, setBloqueo] = useState<{
    motivo: MotivoIncompatible | 'portal-sin-puente'; mensaje: string;
  } | null>(null);
  const manejadores = useMemo(() => crearManejadoresNfc(puertoNfcAndroid), []);
  const puente = useMemo(() => crearPuenteNativo({
    portalOrigen: portal.origin,
    appVersion: mobilePackage.version,
    inyectar: (javaScript) => webView.current?.injectJavaScript(javaScript),
    manejadores,
    alIncompatible: (motivo, mensaje) => setBloqueo({ motivo, mensaje }),
    alSinSaludo: () => setBloqueo({
      motivo: 'portal-sin-puente',
      mensaje: 'El portal no pudo conectarse con las funciones del teléfono. Avisa a soporte.',
    }),
  }), [manejadores, portal.origin]);

  useEffect(() => puente.detener, [puente]);
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

  const allowNavigation = (navigation: WebViewNavigation) => {
    try {
      return new URL(navigation.url).origin === portal.origin;
    } catch {
      return false;
    }
  };

  const retry = () => {
    setBloqueo(null);
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
        applicationNameForUserAgent="VoxIAAndroid/0.1"
        injectedJavaScriptBeforeContentLoaded={APP_LIKE_DOCUMENT + puente.guionPrevio}
        onMessage={puente.alRecibirMensaje}
        originWhitelist={[`${portal.protocol}//${portal.host}`]}
        onShouldStartLoadWithRequest={allowNavigation}
        onLoadStart={() => {
          setLoading(true);
          setFailed(false);
        }}
        onLoadEnd={() => setLoading(false)}
        onError={mostrarFallo}
        onHttpError={({ nativeEvent }) => {
          if (nativeEvent.statusCode >= 400) {
            mostrarFallo();
          }
        }}
        javaScriptEnabled
        domStorageEnabled
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
          <Text style={styles.loadingText}>Abriendo VoxIA Control…</Text>
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
          <Text style={styles.title}>Sin conexión</Text>
          <Text style={styles.description}>
            No pudimos abrir el portal. Revisa tu conexión y vuelve a intentarlo.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={retry}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>Reintentar</Text>
          </Pressable>
        </View>
      ) : null}

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
