# Geolocalización, traza del recorrido y consentimiento (issue #15, #134)

Rastrear la ubicación de un trabajador no es una función más del producto: en
Chile el monitoreo de ubicación exige **aviso previo y proporcionalidad**, y
Google Play exige **divulgación destacada** para la ubicación en segundo plano.
Este documento es la descripción operativa de qué se guarda, cuándo, por cuánto
tiempo y cómo se corta. Está escrito para poder mostrárselo a un cliente, a un
trabajador o a un fiscalizador sin traducirlo.

## Qué se rastrea

Dos cosas distintas, que conviene no confundir:

| | Dónde vive | Qué es |
|---|---|---|
| **Punto de escaneo** | `scans.latitude/longitude` | Una posición puntual por punto de control tocado. Existe desde #63 y no cambia con este issue. |
| **Traza del recorrido** | `patrol_tracks` | Un muestreo periódico de posiciones mientras la ronda está en curso. Es lo nuevo. |

Cada fila de `patrol_tracks` guarda: la ronda, el guardia, la hora del
dispositivo, latitud, longitud, precisión en metros y —opcional— el porcentaje
de batería. La batería está para explicar un hueco en la traza sin acusar a
nadie: un teléfono en 3% deja de muestrear.

No se guarda: IMEI, número de teléfono, redes wifi vistas, ni nada del equipo
más allá de un `device_info` de texto (marca y modelo) en el consentimiento.

## Cuándo se rastrea — y cuándo NO

**No se rastrea fuera del turno, y eso es demostrable con la propia base de
datos**, no con una promesa de la app:

1. El endpoint que recibe posiciones es `POST /api/geo/patrols/:patrolId/track`.
   Solo acepta puntos si la ronda indicada **está en curso** (`status =
   'en_curso'`) y pertenece al guardia autenticado. Una ronda cerrada, vencida o
   que todavía no empieza responde `409` y no guarda nada.
2. Los puntos con hora **anterior al inicio de la ronda** se descartan y se
   informan al dispositivo en el campo `outsideShift` de la respuesta. Los que
   vienen del futuro (más de 5 minutos de desfase de reloj) también.
3. Toda fila cuelga de una `patrol_id` con `ON DELETE CASCADE`: no existe una
   traza sin ronda. Si no hay ronda en curso, no hay dónde guardar.

Además, la regla de tenant `gpsSharingRequired` es el interruptor de la empresa:
si está en `false`, el módulo no acumula traza continua aunque el trabajador
haya consentido. La proporcionalidad la fija la empresa, no el dispositivo.

La frecuencia del muestreo la fija `gpsTrackIntervalSeconds` (default 60 s) y la
app la lee de `GET /api/geo/consent`: el intervalo no se codifica en el cliente.

## El consentimiento

Vive en `gps_consents` y es la **evidencia de que al trabajador se le informó**.
Guarda quién, cuándo, qué versión del texto aceptó y en qué equipo.

- `POST /api/geo/consent` — el trabajador acepta. Body:
  `{ "policyVersion": "v1", "deviceInfo": "Moto G54" }`.
  Reintentar con la misma versión **no** crea una fila nueva.
  Si la versión del texto cambió, el consentimiento anterior se cierra y se abre
  uno nuevo: un consentimiento arrastrado a un texto que la persona nunca leyó no
  acredita nada.
- `GET /api/geo/consent` — estado actual más lo que la app necesita para
  decidir si muestrea: `trackingEnabled`, `sampleIntervalSeconds`,
  `retentionDays`.
- `DELETE /api/geo/consent` — **revocar**.

Los tres endpoints exigen `account:sessions:manage`, que tienen los cuatro roles:
cada persona gestiona **su** consentimiento y nadie lo acepta por otra.

### Qué pasa exactamente al revocar

- Responde OK siempre, incluso si no había nada vigente. Revocar es un derecho,
  no un trámite que pueda fallar por estado.
- Desde ese instante, `appendTrack` responde `403` y **no se guarda ni un punto
  más**.
- **La traza ya registrada no se borra.** Son rondas que ya ocurrieron y cuyo
  registro respalda informes ya emitidos; borrarla retroactivamente destruiría
  evidencia de servicios prestados. Lo antiguo caduca solo, por retención.
- La fila del consentimiento tampoco se borra: se marca `revoked_at`. A nivel de
  PostgreSQL, `voxia_app` **no tiene `DELETE`** sobre `gps_consents`.

## Por cuánto tiempo se conserva

La retención de la traza es `gpsTrackRetentionDays` (default **90 días**),
bastante menor que la de la evidencia fotográfica (365) porque una traza es
mucho más invasiva y mucho más pesada: a un punto por minuto, una ronda de 8
horas son ~480 filas, contra decenas de escaneos.

El barrido por retención todavía **no tiene job**: la tabla ya trae el índice
`patrol_tracks_retention_idx` y `voxia_app` tiene `DELETE` sobre
`patrol_tracks` justamente para eso. Está en la misma situación que
`photoRetentionDays`, que tampoco tiene barrido. Mientras no exista, el valor es
una promesa incumplida: es deuda a cerrar antes de vender la función.

## Los mapas (OpenStreetMap)

La traza se entrega lista para dibujar: `GET /api/geo/patrols/:patrolId/track`
devuelve los puntos ordenados por hora, con `totalDistanceM` (haversine sobre
los tramos consecutivos) y `durationMin`. La API no dibuja nada; entrega la
polilínea.

Dos cosas que no son opcionales al implementar el visor:

- **La atribución a OpenStreetMap es obligatoria por licencia.** Va visible en
  el mapa, no escondida en un "acerca de".
- **`tile.openstreetmap.org` no se usa en producción.** Su política de uso
  prohíbe el tráfico de aplicaciones reales y bloquea a quien la incumple. Hay
  que usar un proveedor con capa gratuita o servir tiles propios.

## Sin PostGIS, por ahora

`patrol_tracks` guarda `numeric(9,6)` igual que el resto del esquema. La
justificación completa está en el encabezado de la migración
`1724511600000-CreateTrackAndConsent.ts`; en corto: hoy solo dibujamos una
polilínea y sumamos haversine, que es aritmética, y la extensión habría que
instalarla y mantenerla en todos los entornos —incluido el destino de cada
restore de respaldo—. Como guardamos WGS84, migrar a `geography` después es un
`ALTER ... USING`, no un rediseño. Se agrega cuando aparezca el requisito real:
geocercas por recinto o consultas de proximidad sobre millones de filas.

## Quién ve qué

| Endpoint | Permiso | Rol efectivo |
|---|---|---|
| `POST /api/geo/patrols/:patrolId/track` | `patrols:execute` | GUARDIA, solo sus rondas |
| `GET /api/geo/patrols/:patrolId/track` | `patrols:monitor` | SUPERVISOR, **solo sus recintos asignados** |
| `POST`/`GET`/`DELETE /api/geo/consent` | `account:sessions:manage` | cualquier usuario, solo el suyo |

El SUPERVISOR está limitado a sus recintos asignados (`supervisor_sites`); el
permiso por sí solo no alcanza y el servicio lo verifica aparte, igual que en el
listado de fotos de evidencia.
