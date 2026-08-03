# App Android de VoxIA Control

Shell nativo Expo para el guardia. Renderiza el portal mobile-first dentro de
`react-native-webview`; las capacidades que WebView no expone (NFC, cámara y ubicación en segundo
plano) se incorporan como módulos nativos y se comunican mediante un protocolo versionado.

La app queda fuera de los workspaces npm del monorepo. Instalar y comprobar por separado:

```bash
cd apps/mobile
npm ci
EXPO_PUBLIC_WEB_URL=http://localhost:13000 npm run typecheck
npm run config
```

En emulador Android, `10.0.2.2` apunta al host. El valor local predeterminado es
`http://10.0.2.2:13000`; en un teléfono físico se configura la IP LAN mediante `.env.local`.
Producción exige HTTPS:

```bash
EXPO_PUBLIC_WEB_URL=https://control.example.com npx expo run:android
EXPO_PUBLIC_WEB_URL=https://control.example.com npm run build:development
```

`EXPO_PUBLIC_WEB_URL` es público por definición y nunca debe contener secretos. Expo Go no forma
parte del flujo: `expo-dev-client` genera el development build requerido por los futuros módulos
NFC.
