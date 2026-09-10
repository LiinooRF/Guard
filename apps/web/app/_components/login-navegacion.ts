/**
 * El salto del ingreso al panel (#231).
 *
 * Se hace con una carga completa y NO con la navegacion de cliente de Next, a
 * proposito. Con `router.push` el boton quedaba en "Verificando…" para siempre
 * dentro de la app: el WebView conserva el paquete JavaScript de antes del
 * despliegue, los nombres de los trozos cambian, la navegacion de cliente no
 * completa y `status` nunca sale de `loading`. No hay error que mostrar porque
 * la peticion de login SI respondio —200 en menos de medio segundo—; lo que no
 * ocurre es el cambio de pantalla. Visto cinco veces en el telefono de prueba,
 * y solo se destrababa cerrando y volviendo a abrir la app.
 *
 * Una carga completa ademas es lo correcto en este borde: el panel se dibuja en
 * el servidor y tiene que hacerlo con la sesion recien creada, no con la que
 * habia cuando se monto esta pantalla.
 */

/** Ruta del panel que le toca a cada rol. */
export function rutaDelPanel(role: string): string {
  return `/app/${role.trim().toLowerCase()}`;
}
