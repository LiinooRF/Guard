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

import { checkContrast, MIN_CONTRAST_AA, type TenantBranding } from '@voxia/shared';

import { logoParaEnviar, validarLogo } from './marca-logo';

type Tono = 'ok' | 'error';

const VACIA: TenantBranding = {
  commercialName: null,
  logoUri: null,
  primaryColor: '#1f3b73',
  secondaryColor: '#4263eb',
  mailFromName: null,
  mailFooter: null,
};

export function MarcaConfiguracion({ apiUrl }: { apiUrl: string }) {
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
      setMensaje({
        tono: 'ok',
        texto: 'Marca guardada. Se aplica en la próxima carga de cada pantalla, sin despliegue.',
      });
      const cuerpo = (await respuesta.json()) as { branding?: TenantBranding };
      if (cuerpo.branding) {
        setMarca(cuerpo.branding);
        setLogoNuevo(null);
        setQuitarLogo(false);
      }
    } catch {
      setMensaje({ tono: 'error', texto: 'Sin conexión con el servidor. Revisa la red.' });
    } finally {
      setEnviando(false);
    }
  }

  const contrastePrimario = checkContrast(marca.primaryColor);
  const contrasteSecundario = checkContrast(marca.secondaryColor);
  const logoEnPantalla = quitarLogo ? null : (logoNuevo ?? marca.logoUri);

  if (cargando) {
    return <p>Cargando la marca…</p>;
  }

  return (
    <div className="marca-configuracion">
      <div className="form-grid">
        <label>
          Nombre comercial
          <input
            type="text"
            maxLength={80}
            placeholder="El nombre que ve tu equipo (vacío = VoxIA Control)"
            value={marca.commercialName ?? ''}
            onChange={(e) =>
              setMarca({ ...marca, commercialName: e.target.value.trim() ? e.target.value : null })
            }
          />
        </label>

        <label>
          Logo (PNG, JPEG, WebP o SVG, máx. 150 KB)
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={(e) => alElegirLogo(e.target.files?.[0])}
          />
        </label>
        {logoEnPantalla ? (
          <p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoEnPantalla} alt="Logo actual" style={{ maxHeight: 48 }} />{' '}
            <button type="button" className="secondary-button" onClick={() => setQuitarLogo(true)}>
              Quitar el logo
            </button>
          </p>
        ) : null}

        {(
          [
            ['primaryColor', 'Color primario', contrastePrimario],
            ['secondaryColor', 'Color secundario', contrasteSecundario],
          ] as const
        ).map(([campo, etiqueta, contraste]) => (
          <label key={campo}>
            {etiqueta}
            <span className="marca-color">
              <input
                type="color"
                value={marca[campo]}
                onChange={(e) => setMarca({ ...marca, [campo]: e.target.value })}
              />
              <code>{marca[campo]}</code>
            </span>
            {/* La misma regla que aplicara el servidor, contada antes de chocar
                con ella: 4.5:1 sobre el fondo blanco del panel (WCAG AA). */}
            {contraste.passes ? (
              <small>Contraste {contraste.onSurface}:1 — legible.</small>
            ) : (
              <small className="marca-contraste-malo">
                Contraste {contraste.onSurface}:1 sobre fondo blanco; se necesita {MIN_CONTRAST_AA}
                :1. Así de claro no se lee: el servidor lo va a rechazar.
              </small>
            )}
          </label>
        ))}

        <label>
          Remitente del correo (nombre)
          <input
            type="text"
            maxLength={80}
            placeholder="Vacío = el remitente del producto"
            value={marca.mailFromName ?? ''}
            onChange={(e) =>
              setMarca({ ...marca, mailFromName: e.target.value.trim() ? e.target.value : null })
            }
          />
        </label>

        <label>
          Pie de los correos
          <textarea
            maxLength={500}
            rows={3}
            placeholder="Ej.: razón social, dirección y teléfono de contacto"
            value={marca.mailFooter ?? ''}
            onChange={(e) =>
              setMarca({ ...marca, mailFooter: e.target.value.trim() ? e.target.value : null })
            }
          />
        </label>
      </div>

      {/* Lo que se ve aca es lo que veran todos: las MISMAS variables CSS que
          el shell pone en cascada, aplicadas a una esquina de muestra. */}
      <div
        className="marca-vista-previa"
        style={{
          ['--marca-primario' as string]: marca.primaryColor,
          ['--marca-primario-texto' as string]: contrastePrimario.fillText,
          ['--marca-secundario' as string]: marca.secondaryColor,
          ['--marca-secundario-texto' as string]: contrasteSecundario.fillText,
        }}
      >
        <span className="marca-vista-previa-titulo">Vista previa</span>
        <div className="marca-vista-previa-shell">
          {logoEnPantalla ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoEnPantalla} alt="" style={{ maxHeight: 28 }} />
          ) : null}
          <strong>{marca.commercialName ?? 'VoxIA Control'}</strong>
          <button type="button" className="primary-button" disabled>
            Botón de ejemplo
          </button>
        </div>
      </div>

      {mensaje ? <p className={`mensaje-${mensaje.tono}`}>{mensaje.texto}</p> : null}

      <button type="button" className="primary-button" disabled={enviando} onClick={guardar}>
        {enviando ? 'Guardando…' : 'Guardar la marca'}
      </button>
    </div>
  );
}
