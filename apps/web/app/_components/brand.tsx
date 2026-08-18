/**
 * La marca en la esquina del panel (#117).
 *
 * Con `nombre` o `logoUri` dibuja la marca DE LA EMPRESA; sin ellos, la del
 * producto. La distincion importa: en un producto white-label el cliente final
 * no deberia notar que el sistema es de un tercero, asi que en cuanto el tenant
 * tiene marca propia, "SentryCore" desaparece de su pantalla.
 *
 * El logo llega como data URI desde `tenant_branding.logo_uri` (nunca una URL
 * externa: el panel no le cuenta a un tercero cuando se abre) y se dibuja con
 * `<img>` comun — un data URI no gana nada con el pipeline de next/image y este
 * componente tambien se usa en contextos sin optimizador.
 */
export function Brand({
  nombre,
  logoUri,
}: {
  /** Nombre comercial del tenant; sin el, la marca del producto. */
  nombre?: string | null;
  /** Logo del tenant como data URI; sin el, el escudo del producto. */
  logoUri?: string | null;
}) {
  const etiqueta = nombre ?? 'SentryCore';
  return (
    <div className="brand" aria-label={etiqueta}>
      {logoUri ? (
        // alt vacio a proposito: el nombre ya esta al lado como texto y
        // repetirlo hace que el lector de pantalla lo diga dos veces.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="brand-logo" src={logoUri} alt="" />
      ) : (
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" role="img">
            <path d="M16 2.5 28 7v8.2c0 7.3-4.9 12.2-12 14.3-7.1-2.1-12-7-12-14.3V7l12-4.5Z" />
            <path d="m10.3 16 3.7 3.7 7.8-8" />
          </svg>
        </span>
      )}
      <span>
        <strong>{nombre ?? 'SentryCore'}</strong>
      </span>
    </div>
  );
}
