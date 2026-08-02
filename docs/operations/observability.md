# Observabilidad operativa

La API escribe una línea JSON por evento. Cada línea contiene `request_id` y `tenant_id`; para
procesos sin request sus valores son `system` y `null`. El middleware acepta un `x-request-id`
seguro del proxy o genera un UUID, lo devuelve en la respuesta y registra método, ruta, estado y
duración. Nunca registra query strings, cuerpos, cookies, tokens, nombres ni ubicaciones.

- `GET /health`: prueba de vida del proceso.
- `GET /ready`: comprueba con operaciones reales PostgreSQL y Redis.
- `scan_sync_queue`: inspecciona la antigüedad de trabajos BullMQ pendientes. Al superar
  `SCAN_SYNC_LAG_ALERT_SECONDS`, emite el evento `scan_sync_queue_delayed` con atraso y cantidad,
  nunca con el contenido del trabajo.

Traefik y Dokploy deben usar `/ready` para enrutar tráfico. Una alerta operativa debe buscar
`event=scan_sync_queue_delayed`; el umbral por defecto es cinco minutos y se configura por entorno.

Para seguir un incidente, buscar primero el `request_id` devuelto al cliente y después filtrar todas
las líneas JSON por ese identificador. El `tenant_id` permite acotar sin exponer datos personales.
