# Invitaciones y recuperación de acceso

## Flujos

- Un usuario con correo recibe una invitación con vigencia de 24 horas y no
  puede iniciar sesión hasta definir su propia contraseña.
- Un guardia sin correo se crea con `username` y una clave inicial entregada
  por el administrador mediante un canal seguro.
- La recuperación siempre responde el mismo `202`, exista o no el correo.
- Cada nueva invitación o recuperación invalida los enlaces anteriores del
  mismo tipo.

Los enlaces llevan el token en el fragmento (`#invite=` o `#reset=`). El
fragmento no viaja al servidor web ni aparece en sus access logs. La API recibe
el token sólo al confirmar la nueva contraseña.

## Controles de seguridad

- 32 bytes aleatorios mediante el generador criptográfico del sistema.
- PostgreSQL guarda únicamente SHA-256 del token.
- Consumo atómico: `used_at` cambia en el mismo `UPDATE` que decide si el token
  sigue vigente, por lo que dos solicitudes concurrentes no pueden usarlo.
- Contraseñas con Argon2id y mínimo de 12 caracteres.
- Las sesiones anteriores se revocan al completar una recuperación.
- Solicitudes limitadas en Redis por identidad y por IP.
- La tabla lleva `tenant_id`, RLS forzado y acceso de escritura sólo mediante
  funciones `SECURITY DEFINER` con `search_path` fijo.

## Correo local y producción

En desarrollo, Mailpit captura los mensajes en `http://localhost:8025`. En
producción la API se niega a arrancar si no se configura `MAIL_DRIVER=smtp` con
TLS (`SMTP_SECURE=true`). `WEB_PUBLIC_URL` debe ser la URL HTTPS pública que
abrirá la app o el navegador.
