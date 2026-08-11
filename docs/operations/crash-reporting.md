# Reporte de caídas (crash reporting)

Issue #27. **Opcional**: viene apagado de fábrica y el producto funciona igual sin esto.

Complementa [`observability.md`](observability.md), que cubre el log estructurado y `/health`.

## Por qué existe

Una vez que la app está publicada en Google Play, no hay otra forma de saber qué se cierra solo en
el teléfono de un guardia a las 3 de la mañana. Ningún guardia va a reportar un cierre inesperado:
vuelve a la planilla de papel y el cliente reclama que "el sistema no funciona", sin un solo dato
para diagnosticar.

## Los dos interruptores, que son distintos

| | Qué decide | Quién lo toca |
|---|---|---|
| `CRASH_REPORT_DRIVER` (entorno) | Si los eventos salen hacia **Sentry** | Operaciones, en Dokploy |
| Módulo `crashReporting` (feature flag) | Si la **empresa** tiene la función | SUPERADMIN, por licencia |

Con el módulo apagado —el default— los dos endpoints responden **404**: de las caídas **del teléfono**
no se guarda ni se reenvía nada. Con el módulo prendido y el driver en `off`, esas caídas **se
guardan en la base** (bajo RLS, con retención) y no sale nada del VPS. Recién con las dos cosas
prendidas hay envío al proveedor externo.

Esta separación es a propósito: la primera es una decisión de infraestructura y la segunda es una
decisión comercial y de privacidad de cada cliente.

> **Una excepción que hay que saber decir en voz alta.** El módulo apagado **no** apaga el reporte de
> los errores **5xx del propio servidor**. Con `CRASH_REPORT_DRIVER=sentry`, un 500 provocado por un
> request de esa empresa igual viaja a Sentry, etiquetado con su `tenant_id`
> (`reportarErrorDeServidor` no pasa por el feature flag, a propósito: una caída del servidor es una
> falla de la plataforma, no una función que el cliente contrata). Lo que viaja es el uuid de la
> empresa, la ruta sin query string y el error enmascarado — nunca el `user_id`, ni el cuerpo del
> request. Si un cliente pregunta "¿qué sale de mi empresa hacia terceros?", **esta es la respuesta
> completa**; el único interruptor que corta también esto es `CRASH_REPORT_DRIVER=off`.

## Variables de entorno

```bash
CRASH_REPORT_DRIVER=off            # off | sentry
SENTRY_DSN=                        # https://<clave>@<host>/<idProyecto>
SENTRY_ENVIRONMENT=                # por defecto, el NODE_ENV
SENTRY_RELEASE=voxia-api@dev       # en produccion NO puede quedar en el valor de ejemplo
CRASH_REPORT_TIMEOUT_MS=2000
CRASH_REPORT_MAX_PER_USER_HOUR=20
```

Con `CRASH_REPORT_DRIVER=sentry` y sin `SENTRY_DSN`, **la API no arranca** y dice exactamente qué
falta. Es el mismo criterio que `MAIL_DRIVER=smtp` sin `SMTP_HOST`.

## Qué viaja y qué no

Lo que sale hacia Sentry se arma **campo por campo**; no hay serialización automática de objetos.

**Sí viaja**: `tenant_id` (uuid de la empresa), versión de la app, modelo del teléfono, versión de
Android, versión del protocolo del puente, tipo y mensaje del error, pila, `request_id`, ambiente y
release.

**No viaja**: nombres, correos, RUT, teléfonos, **ubicación**, tokens, cookies, el `user_id` del
guardia ni el contenido de ningún request.

**Cuándo viaja**: las caídas de la app, sólo con el módulo `crashReporting` prendido **y** el driver
en `sentry`. Los errores 5xx del servidor, con el driver en `sentry` **aunque el módulo esté
apagado** — ver la nota de "Los dos interruptores". Con el driver en `off` no sale nada, en ningún
caso.

Tres rejas, en este orden:

1. **Lista blanca de campos.** El DTO de entrada corre con `forbidNonWhitelisted`, así que un campo
   que no esté declarado devuelve 400 en vez de colarse. Una versión futura de la app **no puede**
   agregar `guardName` y que el servidor lo acepte en silencio.
2. **Enmascarado** de los dos campos que son texto libre por naturaleza —mensaje y pila— en
   `crash-scrubber.ts`: JWT, `Bearer`, pares `clave=secreto`, correos, RUT, teléfonos chilenos,
   coordenadas, IP, hashes largos y el nombre de usuario dentro de rutas tipo `/home/<usuario>`.
3. **Ningún JOIN a `users` ni a `tenants`.** El nombre de una persona no entra a este módulo por
   ningún camino, y hay un test que lo verifica sobre el texto del servicio.

Lo que **no** puede hacer el enmascarado: detectar un nombre propio escrito dentro del mensaje de
una excepción. "Juan Pérez" es indistinguible de cualquier otro par de palabras. Eso se cuida en la
revisión del PR, no con una expresión regular.

## Qué se alerta

Sólo lo que amerita: **5xx y errores sin clase HTTP**. Un 400, un 401 y un 403 son el sistema
funcionando. El 404 tampoco se reporta, y ahí hay una trampa concreta: un módulo que la empresa no
contrató responde 404, así que reportarlos llenaría el tablero de problemas que no existen.

## Sin SDK

No se usa `@sentry/node`. Se habla el protocolo de *envelopes* por HTTP, que son unas 120 líneas.
Dos razones:

1. El SDK instrumenta automáticamente http y captura cabeceras y cuerpos. En un producto donde el
   aislamiento entre empresas de seguridad privada es el requisito número uno, la captura automática
   es exactamente lo que no se quiere.
2. Un issue opcional no mete decenas de paquetes nuevos en el árbol compartido.

Si algún día se quiere el SDK, el punto de cambio es la interfaz `CrashReporter`: nada fuera de
`observability/` sabe cómo viaja el evento.

## Endpoints

| Método | Ruta | Permiso | Roles |
|---|---|---|---|
| POST | `/api/observability/crash-reports` | `account:sessions:manage` | los 4 (en la práctica GUARDIA y SUPERVISOR desde la app) |
| GET | `/api/observability/crash-reports/summary` | `tenant:audit:read` | ADMIN |

El resumen **no** se abre al SUPERVISOR: está limitado a sus recintos asignados y una caída no
cuelga de un recinto —ocurre en un teléfono—, así que no hay forma de recortar la lista a su alcance.

Contrato del POST (todo campo extra devuelve 400):

```json
{
  "errorName": "NfcBridgeError",
  "errorMessage": "no se pudo leer la etiqueta",
  "stack": "at leerTag (app://bundle.js:120:9)",
  "appVersion": "1.4.2",
  "deviceModel": "Redmi 9A",
  "androidVersion": "10",
  "bridgeProtocolVersion": 3,
  "fatal": true,
  "occurredAt": "2026-08-03T03:12:44.000Z"
}
```

Responde **202** siempre que la sesión sea válida, con `{ registrado, enviado }`. Si el teléfono
está en bucle de reinicio y pasó el tope por hora, responde `{ registrado: false, motivo:
"limite_por_hora" }` en vez de 429: un 429 haría reintentar justo cuando el problema es que
reintenta demasiado.

Contrato del GET:

```json
{
  "ventanaDias": 7,
  "retencionDias": 30,
  "grupos": [
    {
      "errorName": "NfcBridgeError",
      "appVersion": "1.4.2",
      "deviceModel": "Redmi 9A",
      "androidVersion": "10",
      "total": 13,
      "fatales": 2
    }
  ]
}
```

El parámetro de consulta `days` es opcional. Sin él se usa la retención configurada; si pide una
ventana mayor, `ventanaDias` informa la ventana efectiva, limitada por `retencionDias`. Cada elemento
de `grupos` contiene **solamente** las cuatro etiquetas proyectadas y los dos conteos del ejemplo.

Antes de construir la respuesta, el servidor aplica una validación cerrada a cada etiqueta:

- `errorName` tiene que coincidir exactamente con una de las 11 clases canónicas y `deviceModel`
  con uno de los 10 modelos canónicos del contrato actual. No se aceptan tipos por llevar el sufijo
  `Error` ni modelos por coincidir con una expresión regular de fabricante: ambos criterios dejarían
  pasar identificadores personales disfrazados de etiquetas técnicas. Los catálogos de API y web,
  junto con sus pruebas, se mantienen sincronizados. Admitir una clase o modelo nuevo exige
  evidencia, actualizar ambos catálogos y agregar la prueba asociada en el mismo cambio.
- `appVersion` admite sólo una versión semántica de tres componentes numéricos o una versión de
  calendario `20YY.MM`, con día `.DD` opcional. El prerelease y los metadatos de compilación, cuando
  existen, también tienen formas cerradas por el contrato.
- `androidVersion` admite sólo una versión numérica.

Todo valor que no cumpla esas reglas se reemplaza completo por un valor fijo —`Error no
identificado`, `Versión de app no identificada`, `Modelo no identificado` o `Versión no
identificada`—; no se conserva ningún fragmento del valor rechazado. Los grupos que quedan con las
mismas cuatro etiquetas después de esa proyección se fusionan y sus conteos se suman.

La consecuencia deliberada es menor cobertura diagnóstica a cambio de confidencialidad: una clase,
modelo o versión legítima pero desconocida cae al fallback hasta que se incorpore con evidencia y
una prueba. Esto evita que texto controlado por quien envía el reporte llegue al navegador sólo por
tener una apariencia técnica; los conteos agregados no se descartan.

La respuesta al navegador **nunca** incluye la huella, el mensaje del error, la pila, fechas, IDs ni
datos personales. La huella y los campos internos de diagnóstico que sí se conservan según las
secciones anteriores permanecen del lado servidor; no forman parte del DTO público. Esta proyección
no reemplaza ni relaja la lista blanca y el enmascarado de entrada.

## Horas

`occurred_at` es la hora **del teléfono** y se guarda porque sirve para investigar, pero el reloj
del teléfono miente (ver el desfase de reloj de #73). Lo que se manda al proveedor es la hora **del
servidor**: un reloj adelantado hace que Sentry descarte el evento por venir del futuro.

El resumen no agrupa por día calendario. Un día sólo existe dentro de una zona horaria, y una caída
no ocurre en un recinto sino en el teléfono de alguien que puede estar en cualquier parte; agrupar
por día obligaría a elegir una zona arbitraria. La ventana móvil se filtra con la hora de recepción
del servidor, pero la respuesta no expone fechas individuales ni agregadas: devuelve sólo la
cantidad de días de la ventana y los conteos agrupados.

## Retención

La regla es `crashReportRetentionDays` (default 30 días, configurable por plataforma y por empresa).
La purga la hace la propia API al recibir un reporte; no hay proceso aparte que barra. 30 días y no
365 como las fotos: un stacktrace de hace un año no se arregla, ya no existe esa versión de la app.

## Cómo comprobar que quedó bien

1. `CRASH_REPORT_DRIVER=off` (default): la API arranca y en el log aparece
   `{"event":"crash_reporting_configurado","driver":"off",...}`.
2. Con el driver en `sentry` y un DSN válido, forzar un 500 y ver el evento en Sentry con el
   `request_id` que devolvió la cabecera `x-request-id`.
3. Con el módulo `crashReporting` prendido para la empresa, hacer el POST de arriba y comprobar en
   Sentry que el evento trae versión de app, modelo y versión de Android.
4. Revisar ese mismo evento y confirmar que no aparece ningún correo, RUT, teléfono ni coordenada.

Los puntos 2, 3 y 4 exigen base y un proyecto de Sentry: **no se pudieron ejecutar** al escribir
esto. Lo que sí está cubierto por tests son el enmascarado, el armado del sobre y las respuestas del
transporte.
