'use client';

/**
 * Editor de la marca de la empresa (#117): nombre comercial, logo, colores y
 * remitente del correo. Solo ADMIN (el PUT exige `tenant:rules:manage`).
 *
 * Tres decisiones que no son de estilo:
 *
 * - **El contraste se muestra ANTES de guardar.** El servidor rechaza un color
 *   ilegible (4.5:1 sobre fondo blanco, WCAG AA), pero enterarse recien en el
 *   rechazo es mala pedagogia: aca se calcula en vivo con el MISMO
 *   `checkContrast` del contrato — un solo origen para la regla.
 * - **El logo se lee como data URI y se valida por tipo y peso** en
 *   `marca-logo.ts` (150 KB): viaja en cada `GET /branding`, tambien al
 *   telefono del guardia con datos moviles.
 * - **La vista previa usa las mismas variables CSS** que el shell de verdad
 *   (`--marca-*`): lo que se ve aqui es lo que veran todos manana.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { checkContrast, contrastRatio, MIN_CONTRAST_AA, type TenantBranding } from '@sentrycore/shared';

import { COLORES_DE_MARCA, COLORES_DE_TEXTO } from './marca-colores';
import { aplicarColoresGuardados } from './marca-aplicacion';
import { logoParaEnviar, validarLogo } from './marca-logo';

type Tono = 'ok' | 'error';

const VACIA: TenantBranding = {
  commercialName: null,
  logoUri: null,
  primaryColor: '#1f3b73',
  primaryTextColor: '#ffffff',
  secondaryColor: '#4263eb',
  mailFromName: null,
  mailFooter: null,
};

export function MarcaConfiguracion({ apiUrl }: { apiUrl: string }) {
  const router = useRouter();
  const [marca, setMarca] = useState<TenantBranding>(VACIA);
  const [logoNuevo, setLogoNuevo] = useState<string | null>(null);
  const [quitarLogo, setQuitarLogo] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [mensaje, setMensaje] = useState<{ tono: Tono; texto: string } | null>(null);

  useEffect(() => {
    let cancelado = false;
    void (async () => {
      try {
        const respuesta = await fetch(`${apiUrl}/branding`, { credentials: 'include' });
        if (!respuesta.ok) return;
        const cuerpo = (await respuesta.json()) as { branding?: TenantBranding };
        if (!cancelado && cuerpo.branding) setMarca(cuerpo.branding);
      } catch {
        // Sin red se edita desde los defaults; el PUT dira la verdad.
      } finally {
        if (!cancelado) setCargando(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiUrl]);

  function alElegirLogo(archivo: File | undefined) {
    setMensaje(null);
    if (!archivo) return;
    const veredicto = validarLogo(archivo.type, archivo.size);
    if (!veredicto.valido) {
      setMensaje({ tono: 'error', texto: veredicto.motivo });
      return;
    }
    const lector = new FileReader();
    lector.onload = () => {
      setLogoNuevo(typeof lector.result === 'string' ? lector.result : null);
      setQuitarLogo(false);
    };
    lector.readAsDataURL(archivo);
  }

  async function guardar() {
    setEnviando(true);
    setMensaje(null);
    try {
      const respuesta = await fetch(`${apiUrl}/branding`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...marca,
          logoUri: logoParaEnviar({ actual: marca.logoUri, nuevo: logoNuevo, quitar: quitarLogo }),
        }),
      });
      if (!respuesta.ok) {
        const detalle = (await respuesta.json().catch(() => null)) as { message?: string } | null;
        setMensaje({
          tono: 'error',
          texto: detalle?.message ?? 'No se pudo guardar la marca. Inténtalo de nuevo.',
        });
        return;
      }
      const cuerpo = (await respuesta.json()) as { branding?: TenantBranding };
      if (cuerpo.branding) {
        setMarca(cuerpo.branding);
        setLogoNuevo(null);
        setQuitarLogo(false);
        const shell = document.querySelector<HTMLElement>('.dashboard-shell');
        if (shell) aplicarColoresGuardados(shell.style, cuerpo.branding);
        // Reconcilia nombre y logo resueltos por el Server Component. Mantiene
        // esta pantalla y su estado: no es una recarga completa del navegador.
        router.refresh();
      }
      setMensaje({
        tono: 'ok',
        texto: 'Marca guardada y aplicada en el panel.',
      });
    } catch {
      setMensaje({ tono: 'error', texto: 'Sin conexión con el servidor. Revisa la red.' });
    } finally {
      setEnviando(false);
    }
  }

  const contrastePrimario = checkContrast(marca.primaryColor);
  const contrasteSecundario = checkContrast(marca.secondaryColor);
  const contrasteTexto = Math.round(contrastRatio(marca.primaryColor, marca.primaryTextColor) * 100) / 100;
  const logoEnPantalla = quitarLogo ? null : (logoNuevo ?? marca.logoUri);

  if (cargando) {
    return <p>Cargando la marca…</p>;
  }

  return (
    <section className="brand-studio" aria-label="Editor de marca">
      <div className="brand-settings">
        <section className="brand-setting-group" aria-labelledby="marca-identidad">
          <header>
            <span className="brand-setting-index">01</span>
            <div>
              <h2 id="marca-identidad">Identidad</h2>
              <p>El nombre y el símbolo que reconoce tu equipo.</p>
            </div>
          </header>

          <label className="brand-field">
            <span>Nombre comercial</span>
            <input
              type="text"
              maxLength={80}
              placeholder="SentryCore"
              value={marca.commercialName ?? ''}
              onChange={(e) =>
                setMarca({ ...marca, commercialName: e.target.value.trim() ? e.target.value : null })
              }
            />
            <small>Se muestra en el panel, el teléfono, los informes y los correos.</small>
          </label>

          <div className="brand-logo-field">
            <div>
              <span className="brand-field-label">Logo</span>
              <small>PNG, JPEG, WebP o SVG · máximo 150 KB.</small>
            </div>
            <div className="brand-logo-control">
              <span className="brand-logo-preview" aria-label={logoEnPantalla ? 'Logo actual' : 'Sin logo'}>
                {logoEnPantalla ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoEnPantalla} alt="Logo actual" />
                ) : (
                  <span aria-hidden="true">{(marca.commercialName ?? 'SentryCore').slice(0, 1)}</span>
                )}
              </span>
              <label className="brand-file-button">
                <span>{logoEnPantalla ? 'Reemplazar' : 'Elegir logo'}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  onChange={(e) => alElegirLogo(e.target.files?.[0])}
                />
              </label>
              {logoEnPantalla ? (
                <button type="button" className="brand-link-button" onClick={() => setQuitarLogo(true)}>
                  Quitar
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="brand-setting-group" aria-labelledby="marca-colores">
          <header>
            <span className="brand-setting-index">02</span>
            <div>
              <h2 id="marca-colores">Colores</h2>
              <p>Elige en la página. Todos los tonos sugeridos cumplen contraste AA.</p>
            </div>
          </header>
          <div className="brand-color-list">
            {(
              [
                ['primaryColor', 'Principal', contrastePrimario],
                ['secondaryColor', 'Secundario', contrasteSecundario],
              ] as const
            ).map(([campo, etiqueta, contraste]) => (
              <div className="brand-color-row" key={campo}>
                <div className="brand-color-summary">
                  <span><strong>{etiqueta}</strong><code>{marca[campo]}</code></span>
                  {contraste.passes ? (
                    <small className="brand-contrast-ok">Legible · {contraste.onSurface}:1</small>
                  ) : (
                    <small className="marca-contraste-malo">
                      El color actual no alcanza {MIN_CONTRAST_AA}:1. Elige una sugerencia.
                    </small>
                  )}
                </div>
                <div className="brand-color-options" role="group" aria-label={`Color ${etiqueta.toLowerCase()}`}>
                  {COLORES_DE_MARCA.map((color) => (
                    <button
                      type="button"
                      className="brand-color-swatch"
                      key={color.valor}
                      aria-label={`${color.nombre}, ${color.valor}`}
                      aria-pressed={marca[campo].toLowerCase() === color.valor}
                      title={`${color.nombre} · ${color.valor}`}
                      style={{ backgroundColor: color.valor }}
                      onClick={() => {
                        setMensaje(null);
                        setMarca({ ...marca, [campo]: color.valor });
                      }}
                    >
                      <span aria-hidden="true">✓</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="brand-color-row brand-text-row">
              <div className="brand-color-summary">
                <span><strong>Texto lateral</strong><code>{marca.primaryTextColor}</code></span>
                <small className="brand-contrast-ok">Legible · {contrasteTexto}:1</small>
              </div>
              <div className="brand-text-options" role="group" aria-label="Color del texto lateral">
                {COLORES_DE_TEXTO.map((color) => (
                  <button
                    type="button"
                    className="brand-text-swatch"
                    key={color.valor}
                    aria-label={`${color.nombre}, ${color.valor}`}
                    aria-pressed={marca.primaryTextColor.toLowerCase() === color.valor}
                    title={`${color.nombre} · ${color.valor}`}
                    style={{ backgroundColor: marca.primaryColor, color: color.valor }}
                    onClick={() => {
                      setMensaje(null);
                      setMarca({ ...marca, primaryTextColor: color.valor });
                    }}
                  >
                    <span aria-hidden="true">Aa</span>
                    <small>{color.nombre}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="brand-setting-group" aria-labelledby="marca-correo">
          <header>
            <span className="brand-setting-index">03</span>
            <div>
              <h2 id="marca-correo">Correo</h2>
              <p>Define cómo se presenta la empresa en cada mensaje.</p>
            </div>
          </header>
          <label className="brand-field">
            <span>Nombre del remitente</span>
            <input
              type="text"
              maxLength={80}
              placeholder="SentryCore"
              value={marca.mailFromName ?? ''}
              onChange={(e) =>
                setMarca({ ...marca, mailFromName: e.target.value.trim() ? e.target.value : null })
              }
            />
          </label>
          <label className="brand-field">
            <span>Pie de los correos</span>
            <textarea
              maxLength={500}
              rows={3}
              placeholder="Razón social, dirección y teléfono de contacto"
              value={marca.mailFooter ?? ''}
              onChange={(e) =>
                setMarca({ ...marca, mailFooter: e.target.value.trim() ? e.target.value : null })
              }
            />
          </label>
        </section>
      </div>

      <div
        className="brand-preview-panel"
        style={{
          ['--marca-primario' as string]: marca.primaryColor,
          ['--marca-primario-texto' as string]: marca.primaryTextColor,
          ['--marca-secundario' as string]: marca.secondaryColor,
          ['--marca-secundario-texto' as string]: contrasteSecundario.fillText,
        }}
      >
        <div className="brand-preview-heading"><span>Vista previa</span><small>Panel web</small></div>
        <div className="brand-preview-window">
          <div className="brand-preview-sidebar">
            <span className="brand-preview-lockup">
              {logoEnPantalla ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoEnPantalla} alt="" />
              ) : (
                <i aria-hidden="true">{(marca.commercialName ?? 'SentryCore').slice(0, 1)}</i>
              )}
              <strong>{marca.commercialName ?? 'SentryCore'}</strong>
            </span>
            <span className="brand-preview-nav active" /><span className="brand-preview-nav" />
            <span className="brand-preview-nav short" />
          </div>
          <div className="brand-preview-content">
            <small>Resumen</small>
            <strong>Operación de hoy</strong>
            <span>Información clara para tomar decisiones.</span>
            <div className="brand-preview-metrics"><i /><i /><i /></div>
            <button type="button" disabled>Acción principal</button>
          </div>
        </div>
      </div>

      <footer className="brand-actions">
        <span aria-live="polite">
          {mensaje ? <span className={`mensaje-${mensaje.tono}`}>{mensaje.texto}</span> : 'La vista previa cambia mientras eliges.'}
        </span>
        <button type="button" className="primary-button" disabled={enviando} onClick={guardar}>
          {enviando ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </footer>
    </section>
  );
}
