# 0002 — Proveedor de tiles del mapa

- **Estado: ABIERTA.** Falta que el equipo elija. Este documento existe para que la elección se tome
  con los números delante, no para tomarla.
- Issue: #75 · Fecha: 2026-08-06

## Por qué hay que decidir esto

`tile.openstreetmap.org` **no se puede usar en producción**. Su política de uso prohíbe el tráfico
de aplicaciones reales y bloquean a quien la incumple — y el bloqueo es por IP, así que nos cortarían
el mapa a **todos los clientes a la vez**. El código ya lo impide: `resolverOrigenTiles()` rechaza
`osm.org` y sus subdominios cuando `produccion: true`, y hay 21 pruebas que lo fijan.

Hoy `MAP_TILE_URL` está **vacío**. Eso no rompe nada —el mapa degrada a dibujar los puntos y el
recorrido sin fondo cartográfico, con un aviso a la vista— pero el mapa sin fondo es la mitad del
valor: un supervisor que mira un recorrido flotando en gris no reconoce el recinto.

**La atribución a OpenStreetMap es obligatoria por licencia** con cualquier proveedor de esta lista,
y ya se renderiza en el servidor (`mapa-atribucion.tsx`), así que aparece aunque el mapa no cargue.

## Qué hace falta saber para elegir

Nadie ha medido esto todavía, y sin el número la elección es a ojo:

- **Cuántos tiles pide una sesión real.** Un supervisor mirando el tablero en vivo pide muchos más
  que un guardia en su ronda. Se mide poniendo un contador en `mapa-tiles.ts` una semana en staging.
- **Cuántos supervisores concurrentes** habrá por tenant en el pico (cambio de turno).
- **Si el mapa del guardia necesita fondo.** Con los tiles offline de #76 ya cacheados, quizá no
  — y eso cambia el volumen por un orden de magnitud.

## Opciones

| Opción | Capa gratuita | Qué cuesta después | Riesgo |
|---|---|---|---|
| **Proveedor con capa gratuita** (MapTiler, Stadia, Geoapify, Carto) | del orden de 10k–100k tiles/mes según cual | por millar de tiles; hay que mirar el precio del día, no este documento | Dependencia externa: si cambian la capa gratuita, hay que migrar con el producto en marcha |
| **Tiles propios** (Protomaps/PMTiles o un tileserver) | — | disco y CPU del VPS, más el tiempo de generar y actualizar los datos | Ninguna dependencia ni bloqueo, pero es infraestructura que hay que mantener, y el VPS ya está cerrado a internet a propósito |
| **Sin fondo cartográfico** | — | 0 | Ya es el comportamiento actual. Sirve para salir a producción sin bloquear, pero el mapa vale la mitad |

## Lo que conviene tener presente al elegir

- **El VPS está cerrado a internet a propósito** y todo va por tailnet. Un proveedor externo lo
  consume el **navegador del cliente**, no el servidor, así que no obliga a abrir nada — pero sí
  significa que la IP del cliente y las coordenadas que pide viajan a un tercero. Para un producto
  que vende trazabilidad de trabajadores eso hay que decirlo en la política de privacidad.
- **Tiles propios encajan mejor con la decisión de dominio único** y con los tiles offline que ya
  existen: la misma fuente serviría para los dos.
- **La app móvil ya cachea tiles** (#76). Sea cual sea el proveedor, hay que confirmar que su
  licencia permite el cacheo en el dispositivo: varios lo restringen.

## Consecuencia de no decidir

El mapa sigue sin fondo en producción. No es un error ni rompe el producto, pero **#75 no se puede
cerrar**: su tercer criterio pide que el origen de tiles aguante el volumen sin ser bloqueado, y sin
proveedor no hay origen que aguante nada.

Cuando se decida: llenar `MAP_TILE_URL` en el entorno, actualizar este documento con el proveedor,
el plan y el costo, y cerrar #75 con la medición del primer criterio (que el mapa cargue en menos de
2 segundos con red móvil).
