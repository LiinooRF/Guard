# App Android de VoxIA Control

Shell nativo Expo para el guardia. Renderiza el portal mobile-first dentro de
`react-native-webview`; lo que el WebView no expone —NFC, cámara y ubicación en
segundo plano— entra como módulo nativo y viaja por un **protocolo versionado**
(`src/bridge/`, tiene su propio README y hay que leerlo antes de tocar el
puente).

Android es la única plataforma. iOS está fuera de alcance.

---

## Antes de nada: dos cosas que hay que hacer el día 1

1. **Abrir la cuenta de Google Play y empezar la verificación de identidad del
   desarrollador.** Tarda días o semanas y no se acelera con más gente. Si se
   empieza cuando la app está lista, la app espera. Ver `docs/play-store.md`.
2. **Decidir el `applicationId`.** Este repositorio usa
   `com.voxtilabs.voxiacontrol`. Es **irreversible** una vez publicada la ficha:
   cambiarlo después significa ficha nueva, instalaciones desde cero y migrar a
   los guardias a mano.

   > El andamiaje original traía `cl.voxia.control`. El cambio es gratis hoy
   > porque no hay nada publicado; mañana no. Si alguien prefiere el anterior,
   > es ahora.

---

## Instalación

`apps/mobile` está **fuera de los workspaces de npm a propósito**: Metro no se
lleva bien con el hoisting. Se instala aparte y **no se agrega nada al
`package.json` raíz**.

```bash
cd apps/mobile
npm install          # la primera vez, para regenerar package-lock.json
npm run typecheck
npm run config       # imprime la config pública resuelta de Expo
```

> **`npm install`, no `npm ci`, en la primera pasada.** El `package-lock.json`
> del repositorio quedó de la versión anterior de `package.json` (la que no
> tenía NFC, cámara ni ubicación). `npm ci` falla cuando los dos archivos no
> coinciden, y la CI usa `npm ci`: **el lockfile regenerado hay que commitearlo
> en el mismo PR** o el job `shell Android` se cae.

Después de instalar, alinear las versiones con las que Expo recomienda para el
SDK y revisar que no falte nada:

```bash
npx expo install --fix
npm run doctor
```

`~57.0.0` en las dependencias de Expo acepta cualquier `57.0.x`; `--fix` las
deja en la que el SDK espera exactamente.

### Exportar los assets

`app.config.ts` referencia PNG que **no están commiteados todavía**; se exportan
desde los SVG maestros. Ver `assets/README.md`. Sin ellos el arranque local
avisa por consola y **los builds de `preview` y `production` fallan a
propósito** — Expo, si no los encuentra, sustituye en silencio por su icono por
defecto, y el logo de Expo se descubre cuando la ficha ya está publicada.

### A qué portal apunta

```bash
# Emulador Android: 10.0.2.2 es el host. Es el valor por defecto.
EXPO_PUBLIC_WEB_URL=http://10.0.2.2:13000 npm run android

# Teléfono físico en la LAN: la IP del PC, en .env.local
EXPO_PUBLIC_WEB_URL=http://192.168.1.20:13000

# Staging (requiere estar en el tailnet del equipo)
EXPO_PUBLIC_WEB_URL=https://test-sentrycore.voxtilabs.cl
```

`EXPO_PUBLIC_WEB_URL` es **público por definición**: se hornea en el bundle y
cualquiera puede leerlo del APK. Nunca lleva secretos. Fuera de desarrollo local
tiene que ser HTTPS y el shell lo verifica al arrancar.

> **Pendiente de la decisión #19** (routing de dominio white-label). La app no
> tiene barra de direcciones, así que hoy apunta a un portal único que resuelve
> el tenant después del login. La URL del perfil `production` en `eas.json` es
> un marcador de posición hasta que esa decisión se cierre.

---

## Por qué Expo Go no sirve

Expo Go es una app ya compilada, publicada por Expo, que solo puede ejecutar los
módulos nativos que **ella** trae dentro. `react-native-nfc-manager` no es uno de
ellos, y NFC es el núcleo del producto: sin escaneo nativo no hay ronda.

Tampoco alcanza con el WebView: la Web NFC API (`NDEFReader`) existe en Chrome
para Android pero **no está expuesta en el componente WebView**.

Lo que se usa es un **development build**: un APK propio, con nuestros módulos
nativos dentro, que además trae el cliente de desarrollo (recarga en caliente,
menú de desarrollador, cambiar de servidor de Metro). Se instala una vez y se
trabaja igual de cómodo que con Expo Go.

### Hacer el development build

```bash
# Opción A — en la nube (no requiere Android Studio)
npx eas-cli login
npx eas-cli build:configure          # solo la primera vez del proyecto
npm run build:development            # perfil development, APK

# Opción B — local, si ya hay Android Studio y JDK 17
npm run prebuild                     # genera android/ desde app.config.ts
npm run android
```

Con el APK instalado, el día a día es:

```bash
npm start                            # expo start --dev-client
```

> `android/` **está en `.gitignore`**: el flujo es CNG y la fuente de verdad es
> `app.config.ts`. Si alguien commitea `android/`, los cambios de permisos dejan
> de tener efecto y nadie se entera hasta que Play rechaza el AAB.

### Probar sin conexión (no es opcional)

Las rondas ocurren en subterráneos y perímetros sin señal. Una ronda completa en
**modo avión** debe registrarse y sincronizar después sin perder ni un escaneo ni
una foto. Si se probó solo con wifi, no está probado.

---

## Los tres perfiles de build

| Perfil | Artefacto | Distribución | Para qué |
|---|---|---|---|
| `development` | APK debug + dev client | interna | Día a día. Recarga en caliente contra Metro |
| `preview` | APK **release** | interna (enlace de instalación) | Probar en el teléfono real del guardia. Es release: aquí aparece lo que solo se rompe fuera de debug (R8, tráfico en claro bloqueado, permisos) |
| `production` | **AAB** firmado | Google Play | Lo que se sube a la ficha |

```bash
npm run build:preview
npm run build:production
npm run submit:production     # sube el AAB al track interno, en borrador
```

`preview` no es un lujo: un APK debug oculta justo los fallos que aparecen en
release, y descubrirlos en la revisión de Play cuesta días.

### Versiones

- `version` en `app.config.ts` es el **versionName** que ve el usuario. Se sube
  a mano, con criterio semántico.
- El **versionCode** lo administra EAS (`appVersionSource: "remote"` +
  `autoIncrement` en el perfil `production`). **No lo pongas en
  `app.config.ts`**: dos fuentes de verdad terminan en "versionCode ya usado" al
  subir a Play, que es el rechazo más tonto y más frecuente.

### El keystore: lo único de acá que no se puede rehacer

El keystore de Android lo genera y guarda **EAS**. Qué hay que saber, sin
adornos:

- **Respaldarlo fuera de Expo es parte del trabajo, no un extra.**
  ```bash
  npm run credentials      # eas credentials -p android → descargar keystore
  ```
  El archivo `.jks` y su contraseña van al gestor de contraseñas de la empresa
  **y** a una copia fuera de línea. Nunca al repositorio: `.gitignore` bloquea
  `*.jks` y `*.keystore`, y gitleaks corre en CI.
- **Perderlo significa no poder actualizar nunca más la app publicada.** No hay
  soporte que lo restaure: hay que crear una ficha nueva, con otro
  `applicationId`, y migrar a todos los usuarios a mano.
- **Matiz que conviene tener claro, porque cambia el plan de contingencia:** las
  fichas nuevas usan Play App Signing obligatoriamente. Eso significa que Google
  guarda la *clave de firma de la app* y nosotros la *clave de subida*. Si se
  pierde la clave de subida, se puede pedir a Google que la reemplace — es un
  ticket de soporte de días, no una catástrofe. Lo irrecuperable es el caso en
  que se decide aportar la clave de firma propia y se pierde, y también los APK
  de `preview` distribuidos fuera de Play, donde no existe ningún reset.
  Conclusión práctica: **respaldar igual**, y no delegar el respaldo en "Google
  lo tiene".

---

## Orden de trámites de Play Store

El detalle completo, con los textos listos para copiar, está en
`docs/play-store.md`. El orden importa porque cada paso bloquea al siguiente y
casi todos son **calendario, no código**:

1. **Cuenta de desarrollador + verificación de identidad.** Días o semanas. Para
   cuenta de organización se pide D-U-N-S. Empieza el día 1.
2. **Crear la ficha** con el `applicationId` definitivo. Irreversible.
3. **Primera subida a mano.** La primera versión de una app nueva se sube desde
   Play Console; la API de publicación (`eas submit`) recién funciona después.
4. **Formularios obligatorios**: seguridad de los datos, clasificación de
   contenido, público objetivo, anuncios, política de privacidad publicada en
   una URL accesible.
5. **Declaración de ubicación en segundo plano** + video demostrativo. Es la
   causa más frecuente de rechazo. Revisión aparte, con su propio plazo.
6. **Pruebas cerradas** antes de producción. Para cuentas personales creadas
   después de noviembre de 2023, Google exige 12 probadores durante 14 días
   seguidos; las cuentas de organización no tienen ese requisito, pero conviene
   confirmarlo en la consola antes de planificar la fecha de lanzamiento.
7. **Revisión de producción.** Días o semanas, y se reinicia con cada rechazo.

> El texto de divulgación destacada de ubicación en segundo plano se muestra
> **dentro de la app y antes del diálogo del sistema**. No sirve ponerlo solo en
> la política de privacidad. El puente lo hace cumplir: rechaza el pedido si el
> portal no declara que ya lo mostró.

---

## Qué hay hoy y qué falta

| | Estado |
|---|---|
| Shell WebView con reintento y sin conexión (`App.tsx`) | hecho |
| Configuración de permisos, identidad visual y perfiles de EAS | hecho (este PR) |
| Contrato del puente versionado (`src/bridge/`) | hecho (este PR) |
| Módulos nativos de NFC, cámara y ubicación | **falta** — carril #11 / #5 |
| Cableado del puente en `App.tsx` | **falta** — el snippet exacto está en `src/bridge/README.md` |

`App.tsx` no se toca en este PR a propósito: lo está trabajando el carril de NFC
y dos agentes escribiendo el mismo archivo es cómo se pierde trabajo.
