# apps/mobile — la app del guardia (Android)

**Este directorio está intencionalmente vacío.** Lo inicializa Dev C como primer paso del issue
**#18** (Shell móvil Expo y publicación en Google Play).

No dejamos un `package.json` pre-escrito a propósito: las versiones de Expo, React Native y sus
paquetes tienen que coincidir exactamente entre sí, y esa correspondencia la resuelve el generador
oficial según el SDK vigente. Un `package.json` escrito a mano con versiones adivinadas se rompe en
el primer `npm install`.

## Inicializar

Desde la raíz del monorepo:

```bash
cd apps/mobile
npx create-expo-app@latest . --template blank-typescript
npx expo install react-native-webview expo-secure-store expo-location expo-camera expo-sqlite
npx expo install react-native-nfc-manager
```

## Cuatro cosas a tener presentes antes de escribir la primera línea

1. **Expo Go no sirve.** El NFC y la ubicación en segundo plano necesitan un *development build*
   (`npx expo run:android` o EAS). Ese es el primer tropiezo típico.

2. **`apps/mobile` queda fuera de los workspaces de npm.** Metro, el bundler de Expo, no se lleva
   bien con el hoisting de `node_modules`. Se instala aparte, con su propio `node_modules`.

3. **El NFC no funciona dentro del WebView.** La Web NFC API existe en Chrome para Android pero no
   está expuesta en el componente WebView. El escaneo ocurre en el shell nativo y viaja a la web por
   `postMessage`. El puente es el núcleo del producto, no un accesorio. → issue **#11**

4. **Versiona el protocolo del puente.** Los usuarios de Play Store tardan semanas en actualizar la
   app. Si la web despliega un cambio incompatible, les rompes la app en producción y no puedes
   arreglarlo con un deploy. → issue **#11**

## Consumir el contrato compartido

`@voxia/shared` tiene los roles, las entidades del dominio y las reglas configurables. Como este
proyecto está fuera de los workspaces, se referencia por ruta relativa:

```json
{ "dependencies": { "@voxia/shared": "file:../../packages/shared" } }
```

Requiere que `packages/shared` esté compilado (`npm run build --workspace @voxia/shared` desde la
raíz).
