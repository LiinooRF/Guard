# Despliegue en VPS

`docker-compose.production.yml` define los cinco servicios del producto. PostgreSQL, Redis, API y web
solo pertenecen a la red interna; Traefik es el único servicio que publica puertos (80 y 443).

En Dokploy se cargan todas las variables de `.env.example`, con credenciales únicas del entorno. El
despliegue ejecuta migraciones con `DATABASE_MIGRATION_URL` y después inicia la API con el rol
restringido de `DATABASE_URL`.

## Verificación

```bash
docker compose -f docker-compose.production.yml config --quiet
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
curl --fail "https://${APP_DOMAIN}/ready"
```

Los cinco servicios deben quedar `healthy`. `docker compose ps` debe mostrar puertos publicados
solamente para Traefik. Los volúmenes `postgres_data` y `evidence_data` sobreviven reinicios y
recreaciones de contenedores; no usar `down -v` en un entorno con datos.

Antes de actualizar, respaldar PostgreSQL y el volumen de evidencias. Después del despliegue probar
login, refresh, invitación y una lectura de cada panel por rol.
