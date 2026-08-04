'use client';

/**
 * Un parametro del catalogo, pintado segun su tipo (#83).
 *
 * El control lo decide `parametro.type` y los limites salen de `min`/`max`/
 * `options`/`maxItems` del catalogo. Este archivo no sabe que reglas existen.
 */
import type { AnyRuleParameter } from '@voxia/shared';

import { deOrigen, formatearValor, mismoValor, type EstadoCampo } from './reglas-catalogo';

export function ReglasCampo({
  parametro,
  campo,
  unitLabels,
  error,
  bloqueado,
  onCambiar,
  onHeredar,
}: {
  parametro: AnyRuleParameter;
  campo: EstadoCampo;
  unitLabels: Record<string, string>;
  error: string | undefined;
  bloqueado: boolean;
  onCambiar: (valor: unknown) => void;
  onHeredar: () => void;
}) {
  const unidad = parametro.unit ? unitLabels[parametro.unit] ?? '' : '';
  const heredadoTexto = formatearValor(parametro, campo.heredado, unitLabels);
  const defaultTexto = formatearValor(parametro, parametro.default, unitLabels);
  const esDefault = mismoValor(campo.valor, parametro.default);
  // Una lista de correos necesita el ancho completo de la grilla; un si/no no.
  const ancho = parametro.type === 'email-list' ? ' ancho' : '';

  return (
    <article className={`reglas-campo ${campo.propio ? 'es-propio' : 'es-heredado'}${ancho}`}>
      <div className="reglas-campo-cabecera">
        <div className="reglas-campo-titulo">
          <strong>{parametro.label}</strong>
          <p>{parametro.description}</p>
        </div>
        <span className={`reglas-origen ${campo.propio ? 'propio' : 'heredado'}`}>
          {campo.propio ? 'Definido aquí' : `Heredado ${deOrigen(campo.origenHeredado)}`}
        </span>
      </div>

      <div className="reglas-control">
        <Control
          parametro={parametro}
          campo={campo}
          unidad={unidad}
          bloqueado={bloqueado}
          onCambiar={onCambiar}
        />
      </div>

      {campo.descartado ? (
        <p className="reglas-alerta">
          Este nivel tiene guardado un valor que el sistema no pudo aplicar. Corrígelo y guarda, o
          vuelve a heredarlo.
        </p>
      ) : null}
      {error ? <p className="reglas-error">{error}</p> : null}

      <div className="reglas-campo-pie">
        <span className="reglas-nota">
          {campo.propio
            ? `Si lo quitas, hereda ${heredadoTexto} ${deOrigen(campo.origenHeredado)}.`
            : `Valor en terreno: ${heredadoTexto}. Cámbialo y queda fijado en este nivel.`}
        </span>
        <span className="reglas-campo-acciones">
          {campo.propio && !esDefault ? (
            <button
              type="button"
              className="reglas-boton-suave"
              disabled={bloqueado}
              onClick={() => onCambiar(parametro.default)}
            >
              Valor de fábrica ({defaultTexto})
            </button>
          ) : null}
          {campo.propio ? (
            <button
              type="button"
              className="secondary-button reglas-boton-heredar"
              disabled={bloqueado}
              onClick={onHeredar}
            >
              Volver a heredar
            </button>
          ) : null}
        </span>
      </div>
    </article>
  );
}

function Control({
  parametro,
  campo,
  unidad,
  bloqueado,
  onCambiar,
}: {
  parametro: AnyRuleParameter;
  campo: EstadoCampo;
  unidad: string;
  bloqueado: boolean;
  onCambiar: (valor: unknown) => void;
}) {
  if (parametro.type === 'boolean') {
    const activo = Boolean(campo.valor);
    return (
      <div className="reglas-switch" role="group" aria-label={parametro.label}>
        <button
          type="button"
          className={activo ? 'activo' : ''}
          aria-pressed={activo}
          disabled={bloqueado}
          onClick={() => onCambiar(true)}
        >
          Sí
        </button>
        <button
          type="button"
          className={!activo ? 'activo' : ''}
          aria-pressed={!activo}
          disabled={bloqueado}
          onClick={() => onCambiar(false)}
        >
          No
        </button>
      </div>
    );
  }

  if (parametro.type === 'integer') {
    const numero = Number(campo.valor);
    const valorTexto = Number.isFinite(numero) ? String(numero) : '';
    const min = parametro.min;
    const max = parametro.max;
    const hayRango = min !== undefined && max !== undefined;
    return (
      <div className="reglas-numero">
        {hayRango ? (
          <input
            type="range"
            min={min}
            max={max}
            step={1}
            value={Number.isFinite(numero) ? numero : min}
            disabled={bloqueado}
            aria-label={`${parametro.label} (deslizador)`}
            onChange={(evento) => onCambiar(Number(evento.target.value))}
          />
        ) : null}
        <label className="reglas-numero-caja">
          <input
            type="number"
            inputMode="numeric"
            min={parametro.min}
            max={parametro.max}
            step={1}
            value={valorTexto}
            disabled={bloqueado}
            aria-label={parametro.label}
            onChange={(evento) =>
              onCambiar(evento.target.value === '' ? '' : Number(evento.target.value))
            }
          />
          {unidad ? <span>{unidad}</span> : null}
        </label>
        {hayRango ? (
          <small className="reglas-rango">
            entre {min} y {max}
          </small>
        ) : null}
      </div>
    );
  }

  if (parametro.type === 'multi-select') {
    const elegidas = Array.isArray(campo.valor) ? campo.valor.map(String) : [];
    return (
      <div className="reglas-opciones" role="group" aria-label={parametro.label}>
        {(parametro.options ?? []).map((opcion) => {
          const marcada = elegidas.includes(opcion);
          return (
            <label key={opcion} className={marcada ? 'marcada' : ''}>
              <input
                type="checkbox"
                checked={marcada}
                disabled={bloqueado}
                onChange={() =>
                  onCambiar(
                    marcada
                      ? elegidas.filter((item) => item !== opcion)
                      : [...elegidas, opcion],
                  )
                }
              />
              {opcion}
            </label>
          );
        })}
      </div>
    );
  }

  // email-list: un correo por linea, que es como los pega la gente desde un correo.
  const correos = Array.isArray(campo.valor)
    ? campo.valor.map(String).join('\n')
    : String(campo.valor ?? '');
  return (
    <div className="reglas-lista-correos">
      <textarea
        rows={3}
        value={correos}
        disabled={bloqueado}
        aria-label={parametro.label}
        placeholder={'jefatura@empresa.cl\noperaciones@empresa.cl'}
        onChange={(evento) => onCambiar(evento.target.value.split('\n'))}
      />
      <small>
        Un correo por línea
        {parametro.maxItems !== undefined ? `, hasta ${parametro.maxItems}` : ''}.
      </small>
    </div>
  );
}
