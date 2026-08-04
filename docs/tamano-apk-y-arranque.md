# Tamaño de la app y arranque en gama baja — VoxIA Control (issue #137)

El presupuesto de tamaño de la app Android, cómo se mide, cómo lo verifica la CI
y el protocolo para probar una ronda completa en un teléfono de gama baja real.

> **Esto es argumento comercial, no un detalle técnico.** Los teléfonos los
> entrega la empresa de seguridad, son de gama baja y están casi llenos. La
> competencia (Control Guard) publica **11 MB** en su ficha y lo usa como
> argumento de venta: *"la app es muy liviana y corre ligeramente en todos los
> dispositivos"*. Si el jefe de operaciones tiene que borrar fotos para instalar
> nuestra app, esa conversación ya la perdimos.

> **Los valores entre «comillas angulares» son marcadores de posición**: son las
> mediciones que todavía **no se han tomado**. Se rellenan corriendo los
> comandos de la sección 4. Hasta entonces, en este documento hay presupuestos
> acordados, no números medidos.

---

## 1. Qué se mide, y cuál es el número que importa

Hay cuatro números distintos y se confunden todo el tiempo. Elegir el equivocado
es la forma más fácil de discutir dos horas sobre nada.

| Número | De dónde sale | Para qué sirve |
|---|---|---|
| **Tamaño de descarga** | Play Console, o `bundletool get-size total` sobre el AAB | **Es el que se promete al cliente.** Lo que consume el plan de datos y lo que muestra la ficha |
| Tamaño instalado | Play Console (por configuración de dispositivo), o `adb shell pm path` + `du` | Lo que ocupa en un equipo de 32 GB. Suele ser 2 a 3 veces la descarga |
| Tamaño del AAB | `ls -l` del artefacto de `bundleRelease` | Diagnóstico interno. **No es lo que descarga nadie** |
| Tamaño del APK universal | El artefacto del perfil `preview` de EAS | Instalación directa fuera de Play. **No es comparable con la ficha** |

**La trampa principal.** El APK que produce el perfil `preview` es *universal*:
trae las cuatro ABI (`armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`), todas las
densidades y todos los idiomas. Un teléfono real usa una sola de cada cosa.
Pesar ese APK y compararlo con los 11 MB de la competencia es comparar cosas
distintas, y lleva a entrar en pánico —o a relajarse— por el número equivocado.
Play parte el AAB y le entrega a cada equipo solo su porción; por eso el número
que vale sale del **AAB**, no del APK de `preview`.

Los perfiles de build están descritos en `apps/mobile/README.md` → "Los tres
perfiles de build".

---

## 2. Los presupuestos

Viven en un solo lugar ejecutable: el bloque `env` de
`.github/workflows/mobile-size.yml`. Esta tabla los explica; el workflow los
aplica.

| Métrica | Objetivo | Límite duro (falla la CI) | Dónde se verifica |
|---|---|---|---|
| **Descarga**, peor configuración de dispositivo | 18 MiB | **25 MiB** | job `descarga` |
| Payload de JavaScript exportado | — | **4 MiB**, estimado y todavía no medido | job `bundle`, en los PR que tocan `apps/mobile`. **Hoy avisa, no bloquea** (§5) |
| Tamaño instalado en el equipo de referencia | 70 MiB | no se verifica en CI | medición manual, sección 4.2 |

**Por qué 25 MiB y no 11 MB.** Un shell de Expo + WebView tiene un piso que no
se negocia: el motor Hermes, React Native, el componente WebView, CameraX
(`expo-camera`) y los servicios de ubicación de Google (`expo-location`). Bajar
de ahí no es optimizar, es cambiar de arquitectura. El límite se puso donde la
diferencia deja de ser un tema de venta: por debajo de 20 MB, "la nuestra pesa
18 y la de ellos 11" no le cambia la decisión a nadie que reparte cincuenta
teléfonos; por encima de 30 MB en un equipo de 32 GB, sí.

Y lo honesto para adentro: **si el tamaño se convierte en el eje de la venta, la
respuesta no es adelgazar el shell**, es discutir reemplazar el WebView por
pantallas nativas. Eso es otro proyecto, con otro plazo. No lo cierres apretando
el presupuesto hasta que la CI quede roja.

**Cómo se mueven estos números.** Cuando una medición quede claramente por
debajo del límite, se baja el límite en el mismo PR: un presupuesto que nunca se
ajusta deja de presionar. Subirlo se discute en el PR, con el número medido a la
vista y diciendo qué se gana a cambio. Nunca se sube "para que pase la CI".

**Por qué no van a `rules.ts`.** `packages/shared/src/rules.ts` resuelve la
cascada plataforma → tenant → recinto → punto, y lo que hay ahí lo edita un
ADMIN. Un ADMIN no puede cambiar cuánto pesa el APK: es el mismo artefacto para
todos los tenants. Un presupuesto de build es un límite de ingeniería, no una
regla de negocio configurable.

---

## 3. Estado de las mediciones

**Ninguna medición está tomada todavía.** Este documento y el workflow entregan
la maquinaria; el número lo produce la primera corrida.

| Medición | Valor | Cuándo se puede tomar |
|---|---|---|
| Descarga (peor configuración) | «pendiente» | en el primer push a `staging` con el workflow adentro (§5) |
| Descarga (arm64-v8a, xxhdpi, es) | «pendiente» | a mano, con `--dimensions` (§4.1) |
| Tamaño instalado en el equipo de referencia | «pendiente» | cuando exista el APK de `preview` |
| Payload de JavaScript | «pendiente» | en el primer PR que toque `apps/mobile`, o en el mismo push a `staging` |
| Arranque hasta el splash | «pendiente» | cuando exista el APK de `preview` |
| Arranque hasta poder empezar la ronda | «pendiente» | cuando exista el APK de `preview` |

**El primer número no sale de un `workflow_dispatch`**, aunque sea lo natural de
pedir: GitHub solo expone ese botón para workflows que ya están en la rama por
defecto (`main`). Ver §5.

Dos cosas hacen que el primer número sea un **piso** y haya que volver a
medirlo:

1. **Faltan los PNG de icono y splash.** `apps/mobile/assets/` tiene hoy solo
   los SVG maestros. Cuando se exporten y commiteen (ver
   `apps/mobile/assets/README.md`), el paquete crece: son mipmaps en varias
   densidades. Es del orden de cientos de kilobytes, no cambia el veredicto,
   pero cambia el número.
2. **Faltan los módulos nativos de NFC, cámara y ubicación cableados** (carriles
   #11 y #5). `react-native-nfc-manager`, `expo-camera` y `expo-location` ya
   están en `package.json`, así que su peso nativo ya se cuenta; lo que falta es
   código JavaScript, que es la parte barata.

---

## 4. Cómo se mide a mano

### 4.1 Descarga, a partir del AAB

Es lo mismo que hace la CI, pero sirve para probar una palanca sin esperar un
PR. Requiere JDK 17 y el SDK de Android.

```bash
cd apps/mobile
npm ci
NODE_ENV=production EXPO_PUBLIC_WEB_URL=https://control.example.test \
  npx expo prebuild --platform android --clean --no-install
(cd android && ./gradlew :app:bundleRelease)

# bundletool: descargar el jar de https://github.com/google/bundletool/releases
java -jar bundletool.jar build-apks \
  --bundle=android/app/build/outputs/bundle/release/app-release.aab \
  --output=/tmp/app.apks --mode=default --overwrite

# MIN,MAX comprimidos, sobre todas las configuraciones de dispositivo
java -jar bundletool.jar get-size total --apks=/tmp/app.apks

# Desglosado, para saber QUE configuracion es la pesada
java -jar bundletool.jar get-size total --apks=/tmp/app.apks \
  --dimensions=ABI,SCREEN_DENSITY,LANGUAGE
```

Tres avisos sobre este número:

- Es una **cota superior**. Play aplica su propia compresión y entrega algo
  menos. Que la estimación pase el presupuesto y la ficha muestre menos es lo
  esperado; al revés sería un problema.
- El AAB de este procedimiento sale firmado con la **clave de depuración** (así
  viene la plantilla de Expo). Sirve para pesarlo y para nada más: **no se
  distribuye**. La clave real la administra EAS y su respaldo está en
  `apps/mobile/README.md`.
- Sin `EAS_BUILD_PROFILE`, `app.config.ts` avisa por los PNG que faltan en vez
  de caerse. Es a propósito, pero significa que el número no incluye los
  recursos gráficos.

### 4.2 Descarga y tamaño instalado, en Play Console

Una vez que hay una versión subida (aunque sea al track interno, en borrador):
**Versiones → Explorador de artefactos → seleccionar el AAB → Tamaño de
descarga**. Play muestra descarga e instalado **por configuración de
dispositivo**. Es la única fuente que se le puede citar al cliente sin asteriscos.

Contra un teléfono conectado por `adb`:

```bash
# Tamano instalado real, sumando base y splits
adb shell pm path com.voxtilabs.voxiacontrol
adb shell du -sh /data/app/*voxiacontrol*/
```

### 4.3 Payload de JavaScript

```bash
cd apps/mobile
NODE_ENV=production EXPO_PUBLIC_WEB_URL=https://control.example.test \
  npx expo export --platform android --output-dir dist --clear
find dist -type f ! -name '*.map' -printf '%s\t%p\n' | sort -rn | head -20
```

Es un **proxy**, no el tamaño del APK: en una app de React Native las librerías
nativas pesan más que el JavaScript. Sirve para cazar barato una regresión —una
dependencia npm gorda que entró sin que nadie mirara— en cada PR que toca la
app, sin pagar 20 minutos de Gradle.

### 4.4 Desglose del APK, cuando el presupuesto se rompe

```bash
unzip -o /tmp/app.apks -d /tmp/apks
ls -lS /tmp/apks/splits/                      # que division pesa

APKANALYZER="$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer"
"$APKANALYZER" apk summary   /tmp/apks/splits/base-master.apk
"$APKANALYZER" files list    /tmp/apks/splits/base-master.apk
"$APKANALYZER" dex packages --defined-only /tmp/apks/splits/base-master.apk
```

`files list` ordena por peso y responde la pregunta útil: si lo que engordó son
las `.so` (una dependencia nativa nueva), los recursos (un asset que se coló) o
el dex (código Java/Kotlin, donde R8 tiene algo que hacer).

---

## 5. La verificación en CI

`.github/workflows/mobile-size.yml`, dos jobs que **no miden lo mismo**:

| Job | Cuándo | Qué mide | Duración |
|---|---|---|---|
| `bundle` | PRs que tocan `apps/mobile` (o el propio workflow), y cada push a `main`/`staging` | payload de JavaScript | ~3 min |
| `descarga` | push a `main`/`staging`; semanal y a mano **solo cuando el archivo esté en `main`** | descarga real del AAB | ~20 min |

`descarga` no corre en PRs a propósito: tarda más que toda la CI junta y su
resultado no cambia commit a commit.

### Cómo se dispara, y por qué no como uno esperaría

**`workflow_dispatch` y `schedule` no funcionan hasta que este workflow llegue a
`main`.** GitHub solo expone esos dos disparadores para los workflows que ya
están en la **rama por defecto**, que en este repositorio es `main`, y el flujo
es `feature → staging → main`. Consecuencias, mientras el archivo no llegue ahí:

- `gh workflow run mobile-size.yml --ref feature/<n>-<slug>` responde **404**,
  aunque el archivo exista en esa rama;
- el cron semanal **no dispara nunca**.

Así que **el primer número real lo produce el `push` a `staging`**, es decir
después del merge, no antes.

**Si tu PR agrega una dependencia nativa** —cualquier paquete con carpeta
`android/`, que es exactamente lo que engorda el APK— y necesitas el número
antes de mergear, la única forma hoy es agregar temporalmente en tu rama:

```yaml
on:
  push:
    branches: ['feature/**']
```

mirar el resultado y **sacarlo antes de pedir revisión**. Cuando el workflow
llegue a `main`, esto deja de hacer falta y basta con:

```bash
gh workflow run mobile-size.yml --ref feature/<n>-<slug>
```

> **Hoy no marques ninguno de los dos como check requerido en branch
> protection.**
> `descarga` no corre en PRs, y un check requerido que nunca arranca deja el PR
> esperando para siempre un resultado que no va a llegar. `bundle` tiene filtro
> de `paths`: en los PR que no tocan `apps/mobile` tampoco se encola, y queda
> pendiente para siempre por el mismo motivo. Para poder requerir `bundle` hay
> que sacarle antes el filtro de `paths`.

Ambos jobs escriben el número en el resumen de la ejecución, no solo en el log.

### `bundle` avisa, todavía no bloquea

El job `bundle` va con `continue-on-error: true` y su comparación contra el
presupuesto emite un `::warning::`, no un error. **Es provisional y a
propósito**: ni `npx expo export` sobre este proyecto ni el límite de 4 MiB se
ejecutaron nunca, así que ponerlo bloqueante el día del merge dejaría en rojo
todos los PR abiertos a la vez por un umbral estimado, no por una regresión.

Se cierra en este orden, y está anotado igual dentro del workflow:

1. primera corrida verde → escribir el número en la §3 de este documento;
2. fijar `LIMITE_BUNDLE_KIB` a partir de ese número;
3. borrar el `continue-on-error` y devolver el `exit 1` (ambos marcados con
   `PROVISIONAL` en el YAML).

`descarga` sí falla contra `LIMITE_DESCARGA_KIB` desde el día uno: no corre en
PRs, así que su rojo no bloquea a nadie más que a quien lo mira.

### Qué NO cubre la CI

- **No prueba que la app arranque.** Construye y pesa. Que la imagen compile no
  es que el servicio funcione — la misma distinción que ya está escrita en
  `CLAUDE.md` para las imágenes de Docker.
- **No mide en un teléfono.** El arranque y la estabilidad de la sección 7 son
  medición manual sobre hardware real. No hay atajo.
- **No incluye los recursos gráficos** todavía (los PNG no están commiteados).
- **La estimación de bundletool no es la de Play**, es una cota superior.
- **`bundle` todavía no bloquea** (ver arriba): hasta el primer número medido
  avisa y sigue. Un `::warning::` en un PR no lo lee nadie, así que en esta
  ventana la verificación depende de que alguien mire el resumen del run.

---

## 6. Palancas, en orden de rendimiento por esfuerzo

### Ya aplicadas — verificar, no rehacer

- **Hermes.** `useHermesV1` es `true` por defecto y Hermes V1 es el motor por
  defecto desde React Native 0.84 (documentado en
  `node_modules/expo-build-properties/build/pluginConfig.d.ts`); `apps/mobile`
  usa React Native 0.86.2. **Hermes no es trabajo pendiente**: la casilla del
  issue ya está marcada por el SDK. Si alguien "va a activar Hermes", está por
  perder una tarde.
- **App bundle splitting.** Ya está: el perfil `production` produce un AAB
  (`buildType: "app-bundle"` en `eas.json`) y Play parte por ABI, densidad e
  idioma sin que haya que configurar nada. Es la mayor reducción disponible y ya
  la tenemos.
- **`crunchPngs`.** `enablePngCrunchInReleaseBuilds` viene en `true`.

### Pendientes, con nombre y apellido

Todas se aplican en el bloque `expo-build-properties` de
`apps/mobile/app.config.ts`. **Ese archivo lo trabaja el carril móvil**; los
snippets exactos están en `INTEGRACION.md` de este PR para que los aplique quien
corresponda.

1. **R8 / minificación** — `android.enableMinifyInReleaseBuilds: true`. Es la
   propiedad vigente; `enableProguardInReleaseBuilds` está **deprecada** y el
   plugin la traduce a esta (`pluginConfig.js`, manejo de la propiedad
   deprecada). Encoge el dex, que en una app de React Native no es la porción
   más gorda: esperar cientos de kilobytes, no megabytes.

   > **R8 rompe cosas en React Native.** Los módulos nativos usan reflexión y
   > R8 se lleva por delante lo que no ve referenciado. Esto **no se valida con
   > la CI ni con un build de `development`**: se valida instalando el APK del
   > perfil `preview`, que es release, y haciendo una ronda completa. Si algo
   > falla, la solución es una regla en `extraProguardRules`, no desactivar R8.

2. **`shrinkResources`** — `android.enableShrinkResourcesInReleaseBuilds: true`.
   **Requiere R8 sí o sí**: el plugin lanza un error explícito si se activa esto
   sin `enableMinifyInReleaseBuilds` (verificado en
   `expo-build-properties/build/pluginConfig.js`). Van juntas o no van.

3. **Assets que no se usan.** `assetBundlePatterns: ['assets/**/*']` empaqueta
   la carpeta entera. Ahí viven hoy los **SVG maestros y un `README.md`**, que
   no se cargan nunca en tiempo de ejecución y aun así viajan en el binario. Son
   kilobytes, no megabytes: se arregla porque es gratis y porque la carpeta va a
   crecer, no porque mueva el presupuesto.

4. **Confirmar que el cliente de desarrollo no viaja al release.**
   `expo-dev-client` está declarado en `plugins` sin condición. Lo esperable es
   que quede fuera del release, pero **no se da por sabido**: el workflow lo
   comprueba sobre el APK con `apkanalyzer dex packages` y avisa si aparecen
   clases de `expo.modules.devlauncher`. Si aparecen, son megabytes de código que
   el guardia no usa nunca.

### Lo que NO hay que hacer para bajar el número

- **Subir `minSdkVersion`.** Adelgaza poco y deja teléfonos fuera de la ficha, en
  un rubro donde el parque es viejo y prestado. La competencia dice "Android 8.0+";
  antes de tocar esto hay que saber en cuánto estamos —sale del `build.gradle`
  que genera `expo prebuild`, no de la memoria de nadie— y qué equipos se pierden.
- **Filtrar ABI en el AAB.** Play ya entrega una sola ABI por equipo. Filtrar no
  reduce la descarga y sí deja teléfonos sin poder instalar.
- **Sacar el splash.** No pesa nada y es lo único que aparece durante el arranque
  en frío. Sin él, un equipo lento se ve como un equipo colgado.
- **Sacar el respaldo por QR.** No es un asset, es la única forma de trabajar en
  un teléfono sin NFC, que en gama baja es la mitad del parque.

---

## 7. Arranque en gama baja

### Hay dos relojes y solo uno es problema nuestro

`App.tsx` monta un WebView que carga el portal remoto. Eso parte el arranque en
dos tramos con causas distintas:

| Reloj | Desde → hasta | De qué depende |
|---|---|---|
| **A — hasta el splash** | toque en el icono → primer frame dibujado | El APK: proceso, React Native, Hermes. Es lo que este issue controla |
| **B — hasta poder empezar la ronda** | primer frame → el portal responde al toque | El peso del portal web y la red del recinto. **Domina el total** |

Optimizar el APK y no mirar el reloj B es entregar un número bonito y un guardia
esperando igual. En un recinto con 3G intermitente, el reloj B es varias veces
el reloj A.

| Presupuesto | Objetivo | Máximo aceptable |
|---|---|---|
| Reloj A, arranque en frío, equipo de referencia | 1,5 s | **2,5 s** |
| Reloj B, portal usable con 4G | 3 s | **6 s** |
| Sin red: que aparezca la pantalla "Sin conexión" | 3 s | **5 s** |

El tercero es el que más se olvida y el que más soporte genera. Hoy `App.tsx`
muestra "Abriendo VoxIA Control…" mientras el WebView intenta cargar y recién
pasa a "Sin conexión" cuando el WebView falla. Si ese fallo tarda 30 segundos en
un subterráneo, el guardia ve una pantalla que no dice nada y llama por radio.
**Cuánto tarda ese timeout hay que medirlo, no suponerlo.**

### Cómo se mide el reloj A

```bash
PKG=com.voxtilabs.voxiacontrol

# Resolver la actividad de lanzamiento sin adivinar el nombre de la clase
ACT=$(adb shell cmd package resolve-activity --brief \
      -c android.intent.category.LAUNCHER "$PKG" | tail -1)

adb shell am force-stop "$PKG"
adb shell am start -W -n "$ACT"
```

`TotalTime` es hasta el primer frame dibujado. Cinco corridas, se descarta la
primera (caché de página en frío) y se toma la **mediana** de las otras cuatro;
una sola medición en un equipo de gama baja no dice nada porque la varianza es
enorme.

Contraste cruzado, por si `am start -W` reporta de más:

```bash
adb logcat -d | grep -i "Displayed $PKG"
```

### Cómo se mide el reloj B

No hay comando: el hito es "el guardia puede tocar algo y responde", y eso no
lo sabe el sistema. La medición honesta es video:

```bash
adb shell screenrecord --time-limit 30 /sdcard/arranque.mp4
adb pull /sdcard/arranque.mp4
```

Se cuentan los cuadros hasta la primera pantalla utilizable. Es artesanal y es
la verdad. Con la red del recinto, no con la wifi de la oficina.

### Presupuesto del portal (lo que hace grande el reloj B)

El shell no puede arreglar un portal pesado. El carril de `apps/web` debería
tener su propio presupuesto de **First Load JS** de la primera pantalla que ve
el guardia (login y ronda en curso), medido con lo que imprime `npm run build`
de Next.js. **Ese presupuesto no está acordado y este PR no lo propone**: es
decisión del carril web y no corresponde cerrarla desde acá. Queda anotado
porque, sin él, el reloj B no baja por más que adelgacemos el APK.

---

## 8. El equipo de referencia

Se define por **clase, no por modelo**: los modelos se dejan de vender y la
referencia queda inservible en un año.

| Característica | Mínimo de la referencia |
|---|---|
| RAM | 2 GB |
| Almacenamiento | 32 GB, y se prueba con **menos de 4 GB libres** |
| Android | la versión mínima que soporte la app |
| NFC | **presente** (si no, no hay ronda que probar) |
| Red | 4G, y una prueba con datos limitados a 3G |

Tres trampas al comprar el equipo de prueba:

1. **En gama baja, el NFC falta más de lo que uno cree.** Ya está anotado en
   `CLAUDE.md` y tumba el diseño completo, no solo la prueba. El teléfono de
   referencia **tiene que tener NFC** o no prueba nada del producto.
2. **El mismo nombre de modelo se vende con y sin NFC según el mercado.** Hay que
   verificar la ficha técnica de la variante exacta que se compra en Chile, no
   la del modelo en general. Es el error de compra más caro y más frecuente.
3. **Android Go.** Los equipos con la edición Go recortan el trabajo en segundo
   plano. Nuestro muestreo de GPS corre como servicio en primer plano y ahí es
   donde primero se rompe. Si el cliente reparte equipos Go, se prueba en un Go.

Anotar el equipo elegido acá cuando exista, con marca, modelo, variante, RAM,
versión de Android y **versión de Android System WebView** (esa última se
actualiza por Play y explica diferencias de comportamiento entre dos equipos
idénticos):

| Campo | Valor |
|---|---|
| Marca y modelo | «pendiente» |
| RAM / almacenamiento | «pendiente» |
| Android / WebView | «pendiente» |
| ¿NFC? | «pendiente» |

---

## 9. Protocolo de la ronda completa en gama baja

> **Esta prueba no se puede ejecutar todavía.** Requiere los módulos nativos de
> NFC, cámara y ubicación cableados en `App.tsx` (carriles #11 y #5, marcados
> como pendientes en `apps/mobile/README.md`) y los PNG de assets exportados. El
> protocolo se deja escrito para que el día que estén, la prueba se corra igual
> siempre y sus resultados se puedan comparar.

### Preparación

1. Instalar el APK del perfil **`preview`** (`npm run build:preview`). **No el de
   `development`**: un build de depuración esconde justo lo que se rompe en
   release (R8, tráfico en claro bloqueado, permisos) y además arranca más
   lento, así que miente en las dos direcciones.
2. Dejar el equipo con **menos de 4 GB libres**. Un teléfono de prueba vacío no
   se parece al del guardia.
3. **Excluir la app del ahorro de batería** y anotar exactamente dónde estaba esa
   opción en ese teléfono (ver más abajo).
4. Cargar la batería al 100% y anotar el porcentaje al terminar.

### La prueba

1. Arranque en frío ×5. Anotar la mediana del reloj A y del reloj B.
2. Consentimiento de ubicación y permiso en segundo plano, siguiendo el recorrido
   de `docs/play-store.md` (divulgación destacada → primer plano → Ajustes).
3. Iniciar turno. **Confirmar que aparece la notificación permanente.**
4. **Modo avión** y ronda completa: todos los puntos, incluyendo los que exigen
   foto. Ni un escaneo ni una foto se pueden perder.
5. Con el modo avión puesto, **apagar la pantalla y dejar el equipo 30 minutos en
   el bolsillo**. Es la condición normal de trabajo y es donde el sistema mata el
   proceso. Volver y verificar que la app sigue viva y que la traza no se cortó.
6. Restaurar la red y verificar que sincroniza sin duplicar ni perder nada.
7. Cerrar el turno. **Confirmar que la notificación desaparece.**

### Vigilar mientras corre

```bash
PKG=com.voxtilabs.voxiacontrol

# Memoria: en un equipo de 2 GB, un PSS total sobre ~250 MB es zona de riesgo
adb shell dumpsys meminfo "$PKG" | head -30

# Quien mato el proceso, si se murio
adb logcat -d | grep -iE "lowmemorykiller|lmkd|am_kill|ANR in $PKG"
```

Si el proceso muere, el log dice **quién** lo mató, y eso cambia la solución:
`lmkd` es presión de memoria (nuestro problema), el gestor de batería del
fabricante es configuración del equipo (problema de la entrega al cliente).

### Los asesinos de procesos del fabricante

Esta es la causa número uno de "se me cerró la app a mitad de ronda" en gama
baja, y **no se arregla con código**. Cada fabricante trae su propio gestor
agresivo de batería que mata servicios en primer plano pese a la notificación
permanente. El nombre de la opción cambia por marca y por versión ("inicio
automático", "apps en suspensión", "optimización de batería", "apps
protegidas").

Consecuencia operativa: **excluir VoxIA Control del ahorro de batería tiene que
ser un paso de la entrega de cada teléfono al guardia**, con instrucciones por
marca escritas para el jefe de operaciones. Un equipo entregado sin ese paso
produce rondas con la traza cortada que después nadie sabe explicar.

Documentar por cada marca probada:

| Marca | Ruta exacta de la opción | ¿Sobrevivió los 30 min? |
|---|---|---|
| «pendiente» | «pendiente» | «pendiente» |

### Qué NO se pega en el issue

Las capturas de `logcat` y de pantalla de esta prueba llevan **coordenadas,
nombres y credenciales**. La regla del proyecto es que ni los logs ni los
reportes llevan datos de personas: se prueba con cuentas demo, y si hay que
adjuntar un log se recorta a las líneas del fallo, sin coordenadas ni nombres.
Un `logcat` completo pegado en un issue público es una filtración, no una
evidencia.

---

## 10. Estado de los criterios del issue

| Criterio | Estado |
|---|---|
| Hay un límite acordado | **propuesto y verificable en CI**: 25 MiB de descarga. Falta que el equipo lo ratifique |
| Hay un número **medido** de tamaño de descarga | **no**. Nadie corrió el build. La maquinaria está lista; el número lo produce el primer push a `staging` con el workflow adentro (§5) |
| Se verifica en CI | **el archivo existe y nunca se ejecutó.** `descarga` falla contra el límite desde el día uno; `bundle` avisa pero no bloquea hasta que haya un número medido (§5). Está escrito, no comprobado |
| Una ronda completa corre en gama baja sin cerrarse | **no**. Bloqueado: faltan los módulos nativos (#11, #5). El protocolo está escrito |
| Si se dispara: Hermes, R8, splitting, assets | Hermes y splitting **ya estaban**. R8, `shrinkResources` y los assets quedan como snippets en `INTEGRACION.md` para el carril móvil |
