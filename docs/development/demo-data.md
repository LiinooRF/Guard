# Datos demo locales

Los datos demo existen únicamente para validar el producto en la base PostgreSQL
levantada por Docker. No hay accesos directos, previews ni credenciales incrustadas
en la interfaz.

## Cuentas registradas por el seed

| Empresa | Identidad | Contraseña |
|---|---|---|
| Seguridad Andina | `guardia@demo-andina.test` | valor local de `DEMO_PASSWORD` |
| Control Pacífico | `guardia@demo-pacifico.test` | valor local de `DEMO_PASSWORD` |

El seed requiere `DEMO_PASSWORD` (mínimo 12 caracteres) y falla si
`NODE_ENV=production`.

```bash
DEMO_PASSWORD='una-clave-solo-local' npm run seed --workspace @voxia/api
```

## Retirarlos antes de staging o producción

La limpieza usa deliberadamente la conexión administrativa, exige confirmación y
se niega a ejecutarse en producción:

```bash
CONFIRM_REMOVE_DEMO=true npm run seed:remove --workspace @voxia/api
```

El comando elimina ambos tenants, sus rondas, recintos, rutas y membresías mediante
las relaciones de la base, y finalmente elimina los dos usuarios huérfanos.
