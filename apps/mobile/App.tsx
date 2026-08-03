import { StatusBar } from 'expo-status-bar';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';

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

  const allowNavigation = (navigation: WebViewNavigation) => {
    try {
      return new URL(navigation.url).origin === portal.origin;
    } catch {
      return false;
    }
  };

  const retry = () => {
    setFailed(false);
    setLoading(true);
    webView.current?.reload();
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <WebView
        ref={webView}
        source={{ uri: portal.href }}
        applicationNameForUserAgent="VoxIAAndroid/0.1"
        injectedJavaScriptBeforeContentLoaded={APP_LIKE_DOCUMENT}
        onMessage={() => undefined}
        originWhitelist={[`${portal.protocol}//${portal.host}`]}
        onShouldStartLoadWithRequest={allowNavigation}
        onLoadStart={() => {
          setLoading(true);
          setFailed(false);
        }}
        onLoadEnd={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setFailed(true);
        }}
        onHttpError={({ nativeEvent }) => {
          if (nativeEvent.statusCode >= 400) {
            setLoading(false);
            setFailed(true);
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

      {failed ? (
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
});
