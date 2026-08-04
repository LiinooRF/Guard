# El puente nativo ⇄ WebView

> Si trabajas en `apps/web` y necesitas escanear NFC, este archivo es tu
> documentación. El contrato es `protocol.ts` y el cliente que debes usar es
> `web-client.ts`.

## Por qué existe

La Web NFC API (`NDEFReader`) existe en Chrome para Android pero **no está
expuesta dentro del componente WebView**. El escaneo tiene que ser nativo
(`react-native-nfc-manager`) y viajar al portal por `postMessage`. Lo mismo con
la ubicación en segundo plano: cuando la pantalla se apaga, el WebView deja de
ejecutar.

## Por qué está versionado

Los dos lados se despliegan a velocidades incompatibles:

| | Se despliega en | Se revierte |
|---|---|---|
| Portal web (`apps/web`) | minutos | minutos |
| Shell nativo (Play Store) | días de revisión + **semanas** hasta que el guardia actualiza | **nunca** |

De ahí sale la única regla que importa:

> **El portal se adapta al shell instalado, nunca al revés.**

El portal declara lo que necesita en `REQUISITO_PORTAL` (`web-client.ts`). Ese
número **se escribe a mano** y no se deriva de `PROTOCOLO_MAJOR`: derivarlo
haría que cada mensaje nuevo del shell rompiera a todos los guardias que aún no
actualizaron, que durante semanas son todos.

- **MAJOR** sube cuando un mensaje cambia de forma o desaparece. El shell nuevo
  soporta MAJOR y MAJOR−1 (`MAJORS_SOPORTADOS`) durante la ventana de gracia.
- **MINOR** sube al agregar un mensaje o un campo opcional. El portal puede
  exigir un mínimo con `minMinor` y degradar si no lo tiene.

## El saludo

```
portal ──hello{portalBuild, requiere:{major,minMinor}}──►  shell
portal ◄──ready{protocolo, majorsSoportados, app, dispositivo}── shell
                       ó
portal ◄──incompatible{motivo, mensaje}──────────────────── shell
```

Nada más se puede pedir antes del `ready`. Tras un `incompatible`, el shell deja
de atender mensajes que no sean `hello`.

### Qué hace cada lado cuando no coinciden

| Veredicto | Qué pasó | El shell | El portal |
|---|---|---|---|
| `app-antigua` | El portal pide más de lo que el shell sabe | Pantalla bloqueante **sin WebView** + botón a Play Store | Al recibir `incompatible`: oculta el escaneo NFC, ofrece el respaldo QR y muestra el aviso de actualizar. **No asume** que el shell mostró algo |
| `portal-antiguo` | El portal habla un MAJOR que el shell ya retiró (pasó tras una reversión del deploy web) | Aviso "el portal de tu empresa está desactualizado, avisa a soporte" + reintentar. **No** manda a Play Store: actualizar no lo arregla y genera un ticket equivocado | Registra el evento: es un error de despliegue nuestro y hay que verlo el mismo día |
| sin puente | El portal se abrió en un navegador de escritorio | — | `conectar()` responde `sin-puente`. **No es un error**: el ADMIN y el SUPERVISOR usan el mismo portal sin app |

## Los mensajes de la v1

**Portal → shell**

| Tipo | Payload | Respuesta |
|---|---|---|
| `hello` | `{portalBuild, requiere}` | `ready` \| `incompatible` |
| `nfc.scan.start` | `{timeoutMs, titulo?}` | `nfc.scan.result` \| `nfc.scan.error` |
| `nfc.scan.cancel` | `{}` | — |
| `permission.request` | `{permiso, divulgacionMostrada}` | `permission.result` \| `error` |
| `permission.query` | `{permiso}` | `permission.result` |
| `connectivity.query` | `{}` | `connectivity.state` |

**Shell → portal**

| Tipo | Cuándo |
|---|---|
| `ready` | Respuesta al saludo, con `dispositivo.tieneNfc` y `nfcActivado` |
| `incompatible` | Veredicto negativo |
| `nfc.scan.result` | `{uid, tech, scannedAt, latitude?, longitude?, accuracyM?}` |
| `nfc.scan.error` | Códigos cerrados: `nfc-no-disponible`, `nfc-desactivado`, `permiso-denegado`, `cancelado`, `timeout`, `etiqueta-ilegible`, `error-desconocido` |
| `permission.result` | `{permiso, estado, puedeVolverAPedir}` |
| `connectivity.state` | **También sin que lo pidan**: se empuja al cambiar la conexión |
| `error` | Fallas del puente, no del escaneo |

La posición GPS viaja **dentro** de `nfc.scan.result` y no en una consulta
aparte: separarlas abre una ventana en la que el guardia camina entre el escaneo
y la lectura del GPS, y la coordenada deja de corresponder al punto de control.

Nombres reservados en la v1 (`RESERVADOS_V1`) para que nadie los reutilice:
`camera.capture`, `camera.capture.result`, `location.track.start`,
`location.track.stop`, `location.track.state`, `haptics.pulse`. Agregarlos es un
MINOR, no un MAJOR.

**Las fotos no viajan por el puente.** Una foto de 10 MB en base64 dentro de un
`postMessage` son ~13 MB de string copiados dos veces. El shell la sube directo
a `POST /api/evidence/scans/:scanId/photos`: en Android el `fetch` nativo
comparte el frasco de cookies del WebView, así que la sesión `HttpOnly` sirve sin
exponer ningún token al JavaScript del portal.

## Lo que el puente bloquea a propósito

1. **Origen.** `onMessage` entrega mensajes de cualquier documento cargado,
   **incluidos los iframes**, que no pasan por `onShouldStartLoadWithRequest`.
   El puente compara `nativeEvent.url` con el origen del portal y descarta el
   resto. Sin eso, una página ajena podría disparar el escaneo NFC o el pedido
   de ubicación en segundo plano.
2. **Tamaño.** Tope de 64 kB por mensaje. Ningún mensaje legítimo se acerca: el
   UID de una etiqueta son 64 caracteres como mucho.
3. **Divulgación destacada.** Un `permission.request` de
   `ubicacion-segundo-plano` con `divulgacionMostrada: false` se rechaza con
   `error{codigo:'divulgacion-faltante'}` y **no se abre el diálogo del
   sistema**. Google exige que el aviso se muestre antes; el puente es el último
   lugar donde se puede impedir el orden equivocado.
4. **Nada se evalúa como código.** Los mensajes se leen con `JSON.parse`, jamás
   con `eval`. La inyección hacia el portal usa doble `JSON.stringify` y escapa
   U+2028/U+2029.
5. **Saludo antes de comandos.** Hasta completar `hello → ready`, el shell no
   atiende escaneos, permisos ni consultas. Los payloads se validan por tipo,
   rango y claves permitidas antes de llegar a un módulo nativo.

### Límite de seguridad de `postMessage`

El origen evita que un iframe ajeno ordene un escaneo, pero el JavaScript del
documento principal comparte el mismo contexto que el cliente del puente. Por
eso `postMessage` no demuestra por sí solo que un resultado nació en hardware.
La garantía contra un `nfc.scan.result` fabricado en la consola se completa en
#59: el dispositivo firma el registro y la API verifica esa firma. No se usa
un secreto inyectado al WebView, porque el mismo JavaScript podría leerlo.

## Cómo se conecta en el shell (`App.tsx`)

```tsx
const puente = useMemo(
  () =>
    crearPuenteNativo({
      portalOrigen: portal.origin,
      appVersion: Constants.expoConfig?.version ?? '0.0.0',
      inyectar: (js) => webView.current?.injectJavaScript(js),
      manejadores,               // los implementa el carril de NFC (#11)
      alIncompatible: (motivo, mensaje) => setBloqueo({ motivo, mensaje }),
      alSinSaludo: () => setBloqueo({ motivo: 'portal-antiguo', mensaje: '…' }),
    }),
  [portal.origin],
);

useEffect(() => puente.detener, [puente]);

<WebView
  ref={webView}
  injectedJavaScriptBeforeContentLoaded={APP_LIKE_DOCUMENT + puente.guionPrevio}
  onMessage={puente.alRecibirMensaje}
  /* …el resto de props ya existentes… */
/>
```

`puente.guionPrevio` **tiene que ir en `injectedJavaScriptBeforeContentLoaded`**,
no en `injectedJavaScript`: el shell puede responder `ready` antes de que el
bundle del portal monte y registre su oyente. El preámbulo instala una cola para
que ese primer mensaje no se pierda.

## Cómo se usa en el portal (`apps/web`)

```ts
const puente = crearClientePuente();
const estado = await puente.conectar();

if (estado.clase === 'sin-puente') {
  // Navegador de escritorio: respaldo QR, sin mensajes de error.
} else if (estado.clase === 'incompatible') {
  // Ocultar el escaneo NFC y mostrar el aviso. Ver la tabla de arriba.
} else if (!estado.info.dispositivo.tieneNfc) {
  // El equipo no tiene antena: este guardia no puede hacer rondas con NFC.
} else {
  try {
    const lectura = await puente.escanearNfc({ timeoutMs: 60_000 });
    // lectura.uid va a POST /api/guard/patrols/:patrolId/scans con
    // method: 'nfc' y un clientScanId generado por el dispositivo.
  } catch (error) {
    if (error instanceof ErrorEscaneoPortal && error.codigo === 'nfc-desactivado') {
      // Se resuelve en Ajustes, no es una falla.
    }
  }
}
```

**Nunca decidas por el texto del mensaje**: los códigos son cerrados justamente
para que la interfaz ramifique por `codigo` y el texto se pueda reescribir sin
romper nada.

## Cómo se mantiene sincronizado con el portal

`protocol.ts` y `web-client.ts` no tienen imports: son copiables tal cual. Como
`apps/mobile` está fuera de los workspaces de npm (Metro no se lleva con el
hoisting), hoy la copia es literal y el riesgo es que se separen sin que nadie
lo note. La propuesta para cerrarlo está en `INTEGRACION.md`
(`## cambios-en-archivos-compartidos`): un paso de CI que compare los dos
archivos y falle si difieren.
