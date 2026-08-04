'use client';

/**
 * Tablero de funciones de la ronda, a nivel EMPRESA (#102).
 *
 * Que es y que no es:
 *
 * - ES el tablero de si/no de la empresa: foto obligatoria, orden aleatorio,
 *   respaldo QR, exigir permiso de ubicacion... Se mueve un interruptor, se
 *   guarda, y se comprueba contra el servidor que ya rige en terreno.
 * - NO reemplaza a `reglas-panel.tsx` (#83), que es el editor de los tres
 *   niveles de la cascada y de los parametros con valor (umbrales, retencion,
 *   destinatarios). Los numeros se afinan alla; aca se prenden y apagan
 *   funciones.
 *
 * Que interruptores se muestran lo decide el catalogo (`type === 'boolean'`),
 * no una lista de reglas escrita aca: una regla nueva de si/no aparece sola.
 *
 * TRAMPA IMPORTANTE: el PUT reemplaza el set COMPLETO de overrides del nivel.
 * Por eso el estado se construye con TODOS los parametros editables del nivel y
 * no solo con los que este tablero pinta: si mandaramos unicamente los
 * interruptores, guardar aca borraria en silencio el umbral, la retencion y los
 * destinatarios que el admin configuro en el panel de reglas.
 *
 * Y por lo mismo, mandar el set completo desde una foto vieja tambien pisa. Este
 * panel y `reglas-panel.tsx` (#83) conviven en la misma pagina y editan el mismo
 * recurso, cada uno con su propia foto tomada al cargar: antes de cada PUT se
 * vuelve a pedir GET /rules/admin y, si los overrides ya no son los que teniamos,
 * NO se guarda (ver `guardar()`). Quitar esa comprobacion reabre el pisoton.
 */
import { useMemo, useState } from 'react';
import type { AnyRuleParameter } from '@voxia/shared';

import {
  ajustesConValor,
  consecuenciaDeclarada,
  descartadosFueraDelTablero,
  interruptoresDelNivel,
  mismosOverrides,
} from './funciones-modelo';
import { mensajeDeErrorApi, pedirJsonConEstado } from './funciones-peticiones';
import { ReglasCampo } from './reglas-campo';
import {
  construirEstado,
  cuerpoDelPut,
  frasesDelCambio,
  resumirCambios,
  validarFormulario,
  valorResultante,
  type CatalogoReglas,
  type ClaveRegla,
  type EstadoReglas,
  type VistaReglas,
} from './reglas-catalogo';

export function FuncionesInterruptores({
  catalogo,
  vistaInicial,
  apiUrl,
  onGuardado,
}: {
  catalogo: CatalogoReglas;
  vistaInicial: VistaReglas;
  apiUrl: string;
  /** Avisa al panel que hay que volver a preguntarle al servidor por lo efectivo. */
  onGuardado?: (vista: VistaReglas) => void;
}) {
  const [vista, setVista] = useState<VistaReglas>(vistaInicial);
  const [estado, setEstado] = useState<EstadoReglas>(() =>
    construirEstado(vistaInicial, catalogo.scopes),
  );
  const [base, setBase] = useState<EstadoReglas>(() =>
    construirEstado(vistaInicial, catalogo.scopes),
  );
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'error'; texto: string; detalle?: string[] } | null>(
    null,
  );

  const interruptores = useMemo(() => interruptoresDelNivel(vista.editable), [vista.editable]);
  const ocultos = useMemo(() => ajustesConValor(vista.editable), [vista.editable]);

  const cambios = useMemo(
    () => resumirCambios(base, estado, vista.editable),
    [base, estado, vista.editable],
  );
  const cambiosDelTablero = useMemo(
    () => cambios.filter((cambio) => cambio.parametro.type === 'boolean'),
    [cambios],
  );

  // Se valida el set COMPLETO porque el set completo es lo que viaja en el PUT.
  const errores = useMemo(
    () => validarFormulario(estado, vista.editable),
    [estado, vista.editable],
  );
  const trabados = useMemo(
    () => parametrosTrabados(ocultos, errores, estado),
    [errores, estado, ocultos],
  );
  const hayErrores = Object.keys(errores).length > 0;

  function definir(clave: ClaveRegla, valor: unknown) {
    setEstado((previo) => {
      const campo = previo[clave];
      if (!campo) return previo;
      return { ...previo, [clave]: { ...campo, propio: true, valor } };
    });
  }

  function heredar(clave: ClaveRegla) {
    setEstado((previo) => {
      const campo = previo[clave];
      if (!campo) return previo;
      return { ...previo, [clave]: { ...campo, propio: false, valor: campo.heredado } };
    });
  }

  function aplicarVista(nueva: VistaReglas) {
    setVista(nueva);
    setEstado(construirEstado(nueva, catalogo.scopes));
    setBase(construirEstado(nueva, catalogo.scopes));
  }

  async function guardar() {
    if (!cambios.length || hayErrores || guardando) return;
    const detalle = cambiosDelTablero.map(
      (cambio) => `«${cambio.etiqueta}» ${frasesDelCambio(cambio, catalogo.unitLabels)}`,
    );
    setGuardando(true);
    setAviso(null);
    try {
      // Antes de mandar el set COMPLETO, se comprueba que la foto de este panel
      // siga siendo la del servidor. El panel de reglas (#83) vive en esta misma
      // pagina, edita el MISMO recurso con la misma semantica de reemplazo total
      // y tiene su propia foto: sin esta comprobacion, mover un interruptor aca
      // despues de guardar alla devuelve el umbral, la retencion y los
      // destinatarios al valor que tenian al cargar la pagina, en silencio.
      const control = await pedirJsonConEstado<VistaReglas | null>(apiUrl, '/rules/admin', null);
      if (!control.ok || !control.datos) {
        setAviso({
          tono: 'error',
          texto:
            'No pudimos comprobar la configuración vigente antes de guardar. No se guardó nada: reintenta.',
        });
        return;
      }
      if (!mismosOverrides(control.datos.overrides, vista.overrides)) {
        // Guardar encima devolveria al valor viejo lo que cambio el otro panel.
        // Se carga lo que hay ahora y se dice que los cambios sin guardar se
        // perdieron, nombrandolos para poder rehacerlos.
        aplicarVista(control.datos);
        onGuardado?.(control.datos);
        setAviso({
          tono: 'error',
          texto:
            'Alguien más cambió la configuración de la empresa mientras esta pantalla estaba abierta. No guardamos nada para no deshacer ese cambio: cargamos lo que rige ahora. Vuelve a mover lo que necesites:',
          detalle,
        });
        return;
      }

      const respuesta = await fetch(`${apiUrl}/rules/admin`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpoDelPut(estado, vista.editable)),
      });
      if (!respuesta.ok) {
        setAviso({ tono: 'error', texto: await mensajeDeErrorApi(respuesta) });
        return;
      }
      const nueva = (await respuesta.json()) as VistaReglas;
      aplicarVista(nueva);
      onGuardado?.(nueva);
      setAviso({
        tono: 'ok',
        texto:
          'Guardado para toda la empresa. Los teléfonos toman la configuración nueva sin actualizar la app:',
        detalle: detalle.length ? detalle : ['La configuración quedó igual a la que ya regía.'],
      });
    } catch {
      setAviso({ tono: 'error', texto: 'No pudimos guardar. Revisa la conexión y reintenta.' });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section className="management-card management-wide reglas-panel" id="funciones-ronda">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Funciones del sistema</span>
          <h2>Funciones de la ronda</h2>
        </div>
        <span className="status-pill">{interruptores.length} funciones</span>
      </div>

      <p className="section-explanation">
        Lo que enciendas acá rige para toda la empresa y llega a los teléfonos sin actualizar la
        app. Cada recinto o punto de control puede tener su propia excepción: eso se ajusta en
        Reglas de operación.
      </p>
      <p className="reglas-pie-nota">
        Lee la explicación de cada función antes de moverla. Apagar una exigencia no es lo mismo que
        apagar un registro: hay funciones donde «no» significa «opcional», no «no ocurre».
      </p>

      {aviso ? (
        <div className={`reglas-aviso ${aviso.tono}`} role="status">
          <strong>{aviso.texto}</strong>
          {aviso.detalle?.length ? (
            <ul>
              {aviso.detalle.map((linea) => (
                <li key={linea}>{linea}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {trabados.length ? (
        <div className="reglas-aviso error" role="status">
          <strong>Hay valores guardados que el sistema no puede aplicar</strong>
          <ul>
            {trabados.map((parametro) => (
              <li key={parametro.key}>{parametro.label}</li>
            ))}
          </ul>
          <span>
            No se editan en esta pantalla y, mientras sigan así, guardar acá puede ser rechazado.
            Corrígelos en <a href="#reglas">Reglas de operación</a>.
          </span>
        </div>
      ) : null}

      {!interruptores.length ? (
        <div className="dashboard-empty">
          <strong>No hay funciones de encendido y apagado en este nivel</strong>
          <span>Revisa Reglas de operación para ver los parámetros con valor.</span>
        </div>
      ) : (
        <>
          <div className="reglas-leyenda">
            <span className="reglas-origen propio">Definido aquí</span>
            <span className="reglas-origen heredado">Heredado</span>
            <small>Lo heredado se mueve solo si cambia el nivel de arriba.</small>
          </div>

          <div className="reglas-lista">
            {interruptores.map((parametro) => {
              const campo = estado[parametro.key];
              if (!campo) return null;
              // Que significa la posicion en la que quedaria si se guarda ahora.
              // `ReglasCampo` solo pinta `description`, que esta redactada desde
              // la posicion "Si": con el interruptor en "No" ese texto se lee
              // como si la exigencia siguiera vigente. Se envuelve el campo sin
              // tocarlo (es de #83).
              const posicion = Boolean(valorResultante(campo));
              const declarada = consecuenciaDeclarada(parametro, posicion);
              return (
                <div key={parametro.key}>
                  <ReglasCampo
                    parametro={parametro}
                    campo={campo}
                    unitLabels={catalogo.unitLabels}
                    error={errores[parametro.key]}
                    bloqueado={guardando}
                    onCambiar={(valor) => definir(parametro.key, valor)}
                    onHeredar={() => heredar(parametro.key)}
                  />
                  <p className="reglas-nota">
                    {declarada
                      ? `En «${posicion ? 'Sí' : 'No'}»: ${declarada}`
                      : `El catálogo todavía no declara qué implica dejarla en «${posicion ? 'Sí' : 'No'}». No des por hecho que «No» apaga la función: en varias reglas significa que deja de ser obligatoria, no que deja de ocurrir.`}
                  </p>
                </div>
              );
            })}
          </div>

          {cambiosDelTablero.length ? (
            <div className="reglas-previa">
              <strong>Antes de guardar, esto es lo que cambia</strong>
              <ul>
                {cambiosDelTablero.map((cambio) => (
                  <li key={cambio.clave} className={`reglas-cambio ${cambio.tipo}`}>
                    <b>{cambio.etiqueta}</b> {frasesDelCambio(cambio, catalogo.unitLabels)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="reglas-barra">
            <span className="reglas-barra-texto">
              {hayErrores
                ? 'Hay valores fuera de rango. Corrígelos en Reglas de operación para poder guardar.'
                : cambiosDelTablero.length
                  ? `${cambiosDelTablero.length} ${cambiosDelTablero.length === 1 ? 'función pendiente' : 'funciones pendientes'} de guardar.`
                  : 'Sin cambios pendientes.'}
            </span>
            <span className="reglas-barra-acciones">
              <button
                type="button"
                className="secondary-button"
                disabled={!cambiosDelTablero.length || guardando}
                onClick={() => {
                  setEstado(base);
                  setAviso(null);
                }}
              >
                Descartar cambios
              </button>
              <button
                type="button"
                className="primary-button reglas-guardar"
                disabled={!cambiosDelTablero.length || hayErrores || guardando}
                onClick={guardar}
              >
                {guardando ? 'Guardando…' : 'Guardar funciones'}
              </button>
            </span>
          </div>

          <p className="reglas-pie-nota">
            {ocultos.length
              ? `Además de estas funciones, la empresa tiene ${ocultos.length} parámetro(s) con valor (umbrales, retención, destinatarios). Se revisan y editan en Reglas de operación.`
              : 'Este nivel no tiene parámetros con valor.'}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Parametros que este tablero no muestra y que impiden guardar: o el servidor
 * descarto lo guardado por invalido, o el valor guardado esta fuera del rango
 * que declara el catalogo. Ambos viajan igual en el PUT del set completo.
 */
function parametrosTrabados(
  ocultos: readonly AnyRuleParameter[],
  errores: Partial<Record<ClaveRegla, string>>,
  estado: EstadoReglas,
): readonly AnyRuleParameter[] {
  const conError = ocultos.filter((parametro) => errores[parametro.key] !== undefined);
  const descartados = descartadosFueraDelTablero(estado, ocultos);
  const vistos = new Set<string>(conError.map((parametro) => parametro.key));
  return [...conError, ...descartados.filter((parametro) => !vistos.has(parametro.key))];
}
