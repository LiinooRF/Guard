<!--
SentryCore — plantilla de PR.

Somos 4 trabajando en paralelo sobre un monorepo. Lo unico que evita que nos
pisemos es que cada PR diga que toca y contra que issue va.
-->

## Que hace

<!-- Una o dos frases. Que cambia para el usuario, no que archivos tocaste. -->

Closes #

## Que toca

- [ ] `apps/api`
- [ ] `apps/web`
- [ ] `apps/mobile`
- [ ] `packages/shared` — ojo: **rompe a los otros tres si cambia el contrato**
- [ ] `docker/` o infraestructura
- [ ] migraciones de base de datos

## Como se prueba

<!-- Pasos concretos para quien revise. "Probe local" no es un paso. -->

1.
2.

## Checklist

- [ ] `npm run typecheck` y `npm run build` pasan
- [ ] Si toca datos: la tabla nueva tiene `tenant_id` y politica RLS
- [ ] Si toca la API: el endpoint valida rol **y** tenant en el servidor
- [ ] Si toca la app movil: probado **sin conexion**, no solo con wifi
- [ ] Si agrega una regla de negocio: es configurable, no un valor fijo en el codigo
- [ ] No hay secretos, tokens ni datos de guardias en el codigo ni en los logs

## Notas para quien revisa

<!-- Decisiones discutibles, deuda que dejas a proposito, lo que no alcanzaste. -->
