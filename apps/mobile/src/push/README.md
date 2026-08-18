# Push y deep links (#113)

> Si trabajas en `apps/web` y quieres que una alerta abra una pantalla, el
> contrato es `deep-link.ts`. Si trabajas en el shell, empieza por
> `manejador.ts`.

## Por qué existe

Hoy todo aviso es correo (`MailQueueService` + `escalation/`). El correo llega,
pero llega cuando alguien abre la bandeja. Un **pánico** o una **ronda vencida**
se atienden en minutos: necesitan algo que suene en el teléfono del supervisor.

El push **no reemplaza al correo**. El correo sigue siendo el canal garantizado
y trazable — el push es el que despierta. Si el push falla, el aviso llegó igual.

## Por qué el contrato está versionado

Por la **misma razón que el puente `postMessage`** (`../bridge/protocol.ts`):
los dos extremos se despliegan a velocidades incompatibles.

| | Se despliega en | Se revierte |
|---|---|---|
| API que arma el payload | minutos | minutos |
| Shell que lo interpreta (Play Store) | días de revisión + **semanas** hasta que el guardia actualiza | **nunca** |

El servidor puede empezar a mandar un destino que el shell instalado no conoce,
y eso pasa **el día del deploy**, no en un caso raro. De ahí la única regla dura:

> **Un payload que el shell no entiende nunca rompe la notificación.** Se degrada
> a `inicio` y la persona igual entra al portal.

Una alerta de pánico que no abre nada al tocarla es peor que una que abre la
pantalla equivocada.

- **MAJOR** sube cuando un destino cambia de forma o desaparece. El shell nuevo
  soporta MAJOR y MAJOR−1 (`DEEP_LINK_MAJORS_SOPORTADOS`) durante la ventana de
  gracia.
- **MINOR** sube al agregar un destino o un campo opcional.

Las **rutas del portal también son parte del contrato** (`RUTAS_DEEP_LINK`): las
arma el shell instalado, así que cambiar una es un MAJOR, no un ajuste de
routing.

## El payload

Pares de strings, que es lo único que un transporte push acepta. Nada anidado,
nada numérico.

| Clave | Valor |
|---|---|
| `dl` | versión MAJOR del contrato (`"1"`) |
| `destino` | `evento` \| `ronda` \| `inicio` |
| `id` | UUID del evento o de la ronda |
| `siteId` | UUID del recinto (opcional) |

| Destino | Abre | Cuándo |
|---|---|---|
| `evento` | `/app/eventos/<id>` | pánico y novedades de criticidad alta |
| `ronda` | `/app/rondas/<id>` | ronda vencida o con anomalías |
| `inicio` | `/app` | degradado de todo lo que no se entienda |

Las rutas **no llevan el rol**: el mismo aviso le puede llegar al ADMIN y al
SUPERVISOR, y el portal ya redirige por rol.

### Lo que el payload NO lleva

Nombres, correos, el texto de la novedad ni coordenadas. Viaja por un tercero y
se muestra en una pantalla bloqueada que puede estar sobre una mesa. **Todo el
detalle vive detrás de la sesión**, en el portal — que además es lo que hace
seguro abrir el deep link en un teléfono donde inició sesión otra persona: el
servidor responde 403 y no se filtró nada por la notificación.

### Por qué el servidor no manda la URL ya armada

Sería más cómodo (los shells viejos seguirían rutas nuevas sin actualizar) y se
descartó por dos razones:

1. Es un **redirector abierto dentro de la sesión del WebView**: quien pueda
   emitir un push elegiría qué URL abre la app con las cookies del supervisor
   puestas. Por eso `id` sólo se acepta como UUID: sin eso entra `../`.
2. El shell necesita saber **qué es**, no sólo dónde ir. Un pánico justifica
   sonido propio y canal de alta prioridad; una ronda vencida no.

## El permiso (Android 13+)

Desde API 33 `POST_NOTIFICATIONS` es permiso de ejecución. Si no se pide, el
sistema **no muestra nada y tampoco avisa** que lo está ocultando: el síntoma en
terreno es el peor posible — el supervisor jura que la app no sirve porque el
pánico nunca sonó. El permiso ya está declarado en `app.config.ts`.

**Dos rechazos y se acabó**: Android deja de mostrar el diálogo y la única
salida es Ajustes. Por eso este módulo **no pide el permiso al abrir la app**;
`registrarDispositivo()` sólo consulta. Cuándo pedirlo —con contexto, explicando
que es para las alertas de pánico— lo decide el portal, que es el que tiene la
pantalla.

`solicitarPermisoNotificaciones()` devuelve el mismo `ResultadoPermisoPayload`
del puente, así que sirve **tal cual** como manejador de `permission.request`
con `permiso: 'notificaciones'`: no hace falta agregar ningún mensaje al
protocolo del puente.

En Android 12 y anteriores no hay diálogo. Si las notificaciones están apagadas
el estado es `denegado-definitivo` y la interfaz debe ofrecer Ajustes, no
repetir un pedido que en ese sistema no existe.

## Registro del token

`POST /api/push/devices` con `{token, platform:'android', appVersion}` y
`DELETE /api/push/devices/:token` al cerrar sesión.

- **La sesión viaja sola**: el `fetch` nativo de Android comparte el frasco de
  cookies del WebView, igual que la subida de fotos del puente.
- **Va la cabecera `Origin`**: la API protege las mutaciones con
  `csrfOriginProtection`, que acepta el origen del portal o una petición nativa
  *sin cookies*. Ésta es nativa **pero con** cookies, así que sin `Origin`
  respondería 403.
- **Se reregistra en cada arranque y en cada rotación de token.** El sistema
  rota el token sin avisarle a nadie; un registro "una sola vez" termina en un
  supervisor que dejó de recibir alertas sin que nadie se entere.
- **La baja al cerrar sesión es obligatoria.** El teléfono de la empresa pasa de
  un turno al siguiente.

## Cómo se conecta en el shell (`App.tsx`)

```tsx
const push = useMemo(
  () =>
    crearPushDeApp({
      proveedor,                                  // implementación del transporte
      portalOrigen: portal.origin,
      apiBase: `${portal.origin}/api`,
      appVersion: Constants.expoConfig?.version ?? '0.0.0',
      abrirRuta: (ruta) => {
        webView.current?.injectJavaScript(
          `window.location.assign(${JSON.stringify(ruta)}); true;`,
        );
      },
    }),
  [portal.origin],
);

useEffect(() => {
  push.iniciar();
  return push.detener;
}, [push]);

<WebView
  ref={webView}
  onLoadEnd={() => {
    setLoading(false);
    push.marcarPortalListo();   // vacía la ruta que llegó antes de cargar
  }}
  /* …el resto de props ya existentes… */
/>
```

`marcarPortalListo()` **no es opcional**: cuando se toca la notificación con la
app cerrada, el sistema entrega el toque antes de que el WebView cargue. Sin la
cola, esa ruta se pierde y el supervisor termina en la pantalla de inicio
preguntándose qué pasó con el pánico. Es la misma carrera que resuelve el
preámbulo del puente.

## Qué falta

El **proveedor de push no está decidido** (#113), igual que el de correo (#9).
Todo este módulo va contra el puerto `ProveedorPushNativo` y **no hay ninguna
dependencia de Firebase en `package.json`**. El día que se decida, se escribe
una implementación de esa interfaz y nada más cambia. Los pasos y las variables
de entorno están en `INTEGRACION.md` y en `apps/api/src/push/fcm.provider.ts`.

## Cómo se mantiene sincronizado con la API

`deep-link.ts` es **byte por byte el mismo archivo** que
`apps/api/src/push/deep-link.ts`. No importa nada, así que se copia tal cual —
`apps/mobile` está fuera de los workspaces de npm y no puede importar
`@sentrycore/shared`. El riesgo de que se separen sin que nadie lo note se cierra con
el paso de CI propuesto en `INTEGRACION.md`, el mismo que ya se propuso para el
protocolo del puente.
