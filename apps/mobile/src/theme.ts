/**
 * Identidad visual del SHELL nativo (#114).
 *
 * ---------------------------------------------------------------------------
 * ESTO NO ES EL WHITE-LABEL DEL TENANT. Es lo contrario.
 * ---------------------------------------------------------------------------
 * VoxIA Control es un SaaS multi-tenant: muchas empresas de seguridad usan la
 * misma instancia, cada una con su marca. Pero en Google Play hay **una sola
 * ficha y un solo APK**, asi que el icono, el splash y el nombre de la app son
 * de la PLATAFORMA y no se pueden pintar por empresa.
 *
 * La marca del cliente (`tenantBrandingSchema` en `@voxia/shared`) vive dentro
 * del WebView y se resuelve despues del login, que es el primer momento en que
 * se sabe a que empresa pertenece quien abrio la app.
 *
 * Consecuencia practica que hay que decirle al comercial antes de prometerla:
 * "la app con el logo del cliente" significa ficha propia, cuenta de
 * desarrollador propia y revision propia por cada cliente. No es una opcion de
 * configuracion.
 *
 * Lo unico que el shell pinta con color es lo que se ve ANTES del portal: el
 * splash, el indicador de carga y la pantalla de "sin conexion". Todo lo demas
 * lo pinta la web.
 *
 * Los valores espejan los defaults de `tenantBrandingSchema` a proposito: el
 * salto entre el splash y el primer render del portal no debe ser un cambio de
 * marca.
 */

export const colores = {
  /** Azul de la plataforma. Igual al default de `primaryColor` en shared. */
  marca: '#1f3b73',
  marcaClara: '#4263eb',

  /** Fondo del splash y del icono adaptativo. */
  splash: '#1f3b73',

  /** Superficies del shell. Coinciden con las del portal para que no parpadee. */
  superficie: '#f8fafc',
  texto: '#0f172a',
  textoSuave: '#475569',
  sobreMarca: '#ffffff',

  /** Bloqueo por incompatibilidad de puente y estados de error. */
  alerta: '#b45309',
  peligro: '#b91c1c',
} as const;

/**
 * Turno de noche: el guardia trabaja a oscuras y el telefono es la unica fuente
 * de luz. La barra de estado va clara sobre el splash oscuro y oscura sobre las
 * superficies del portal.
 */
export const barraEstado = {
  sobreSplash: 'light',
  sobrePortal: 'dark',
} as const;

/**
 * Minimo tactil. Un guardia opera con guantes, de pie y con una linterna en la
 * otra mano: 48 dp es el piso, no el objetivo.
 */
export const TOQUE_MINIMO_DP = 48;
