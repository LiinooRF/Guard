/**
 * Puente nativo <-> WebView.
 *
 * `protocol` es el contrato y se copia tal cual al portal web.
 * `native` solo lo usa el shell. `web-client` solo lo usa el portal.
 */
export * from './protocol';
export * from './native';
export * from './web-client';
