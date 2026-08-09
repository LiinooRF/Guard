/**
 * Paleta breve para la marca del tenant.
 *
 * No se genera en el navegador ni depende del selector de color del sistema:
 * cada tono tiene un nombre comprensible y una prueba que garantiza contraste
 * WCAG AA (4.5:1) sobre las superficies blancas del panel.
 */
export const COLORES_DE_MARCA = [
  { nombre: 'Azul noche', valor: '#1f3b73' },
  { nombre: 'Azul vivo', valor: '#4263eb' },
  { nombre: 'Azul profundo', valor: '#3048bc' },
  { nombre: 'Violeta', valor: '#6040a8' },
  { nombre: 'Verde petróleo', valor: '#0b6b5f' },
  { nombre: 'Verde bosque', valor: '#147a50' },
  { nombre: 'Ámbar oscuro', valor: '#965000' },
  { nombre: 'Rojo marca', valor: '#bd2029' },
] as const;

/** Matices claros pensados para texto sobre los fondos oscuros de la paleta. */
export const COLORES_DE_TEXTO = [
  { nombre: 'Blanco', valor: '#ffffff' },
  { nombre: 'Nieve', valor: '#f8fafc' },
  { nombre: 'Marfil', valor: '#fff7ed' },
  { nombre: 'Menta', valor: '#f0fdfa' },
  { nombre: 'Rosa suave', valor: '#fdf2f8' },
] as const;
