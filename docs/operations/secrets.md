# Gestión y rotación de secretos

`.env.example` documenta nombres y valores locales no confidenciales. Los valores reales de
desarrollo, staging y producción se crean de forma independiente y se guardan únicamente en el
gestor de variables de Dokploy. Nunca se copian entre entornos ni se escriben en tickets, logs o
capturas.

## Alta de un entorno

1. Crear credenciales exclusivas para PostgreSQL, Redis y SMTP.
2. Generar `JWT_SECRET` con `openssl rand -base64 48`.
3. Cargar las variables en Dokploy y limitar el acceso al equipo de operación.
4. Desplegar. La validación de arranque detiene la API ante valores ausentes, correo inseguro o
   secretos de ejemplo.
5. Verificar `/ready` desde la red interna y realizar login, refresh y envío de invitación.

## Rotación

1. PostgreSQL y Redis: crear la credencial nueva, actualizar Dokploy, redesplegar y revocar la
   anterior después de verificar `/ready`.
2. SMTP: actualizar primero el proveedor, después Dokploy; probar una invitación antes de revocar.
3. `JWT_SECRET`: cambiarlo en Dokploy y redesplegar. Esta rotación invalida todas las sesiones, por
   lo que debe anunciarse y ejecutarse en una ventana de mantenimiento.
4. Ante exposición, revocar primero, rotar inmediatamente y revisar los eventos de autorización.

Cada rotación se registra en el sistema de cambios con fecha, entorno, responsable y nombre del
secreto; nunca con su valor.

## Comprobación del repositorio

Antes de cada release se revisa el historial completo con un detector de secretos, además de la
revisión de código:

```bash
gitleaks git . --redact
```

Si aparece un secreto real, eliminarlo del último commit no basta: hay que revocarlo y luego limpiar
el historial coordinadamente, porque los clones existentes conservan el valor.
