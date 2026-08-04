'use client';

/**
 * Panel de reglas configurables del ADMIN (#83).
 *
 * Tres niveles de la cascada le pertenecen al admin: empresa, recinto y punto
 * de control. El de plataforma lo ve solo como herencia (es del SUPERADMIN).
 *
 * Todo el formulario se genera desde el catalogo que devuelve el servidor:
 * aca no hay ni un nombre de regla ni un rango escrito a mano.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RuleScope } from '@voxia/shared';

import { ReglasCampo } from './reglas-campo';
import {
  agruparParaFormulario,
  construirEstado,
  contarPropios,
  cuerpoDelPut,
  frasesDelCambio,
  NIVEL_TITULO,
  resumirCambios,
  validarFormulario,
  type CatalogoReglas,
  type ClaveRegla,
  type EstadoReglas,
  type VistaReglas,
} from './reglas-catalogo';

export interface RecintoParaReglas {
  id: string;
  name: string;
  branchName: string;
  isActive: boolean;
}

export interface PuntoParaReglas {
  id: string;
  name: string;
  kind: string;
  isActive: boolean;
}

interface Aviso {
  tono: 'ok' | 'error';
  texto: string;
  detalle?: string[];
}

export function ReglasPanel({
  catalogo,
  vistaInicial,
  recintos,
  apiUrl,
}: {
  catalogo: CatalogoReglas;
  vistaInicial: VistaReglas;
  recintos: RecintoParaReglas[];
  apiUrl: string;
}) {
  const [nivel, setNivel] = useState<RuleScope>(vistaInicial.scope);
  const [recintoId, setRecintoId] = useState('');
  const [puntoId, setPuntoId] = useState('');
  const [puntos, setPuntos] = useState<PuntoParaReglas[]>([]);
  const [vista, setVista] = useState<VistaReglas>(vistaInicial);
  const [estado, setEstado] = useState<EstadoReglas>(() =>
    construirEstado(vistaInicial, catalogo.scopes),
  );
  const [base, setBase] = useState<EstadoReglas>(() =>
    construirEstado(vistaInicial, catalogo.scopes),
  );
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  // Si la carga del nivel falla, el formulario se esconde: mostrar los valores
  // del nivel anterior bajo el titulo de otro nivel es peor que no mostrar nada.
  const [sinVista, setSinVista] = useState(false);

  // La vista inicial ya viene renderizada desde el servidor: no se vuelve a pedir.
  const rutaCargada = useRef<string | null>(rutaDeNivel(vistaInicial.scope, vistaInicial.targetId));

  const recintosActivos = useMemo(() => recintos.filter((r) => r.isActive), [recintos]);
  const ruta = rutaDeNivel(
    nivel,
    nivel === 'site' ? recintoId : nivel === 'checkpoint' ? puntoId : null,
  );

  const aplicarVista = useCallback(
    (nueva: VistaReglas) => {
      setVista(nueva);
      setEstado(construirEstado(nueva, catalogo.scopes));
      setBase(construirEstado(nueva, catalogo.scopes));
    },
    [catalogo.scopes],
  );

  // Carga de la vista del nivel elegido.
  useEffect(() => {
    if (!ruta || ruta === rutaCargada.current) return;
    let vigente = true;
    setCargando(true);
    setAviso(null);
    fetch(`${apiUrl}${ruta}`, { credentials: 'include' })
      .then(async (respuesta) => {
        if (!vigente) return;
        if (!respuesta.ok) {
          setSinVista(true);
          setAviso({ tono: 'error', texto: await mensajeDeError(respuesta) });
          return;
        }
        rutaCargada.current = ruta;
        setSinVista(false);
        aplicarVista((await respuesta.json()) as VistaReglas);
      })
      .catch(() => {
        if (vigente) {
          setSinVista(true);
          setAviso({ tono: 'error', texto: 'No pudimos cargar la configuración. Reintenta.' });
        }
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [apiUrl, aplicarVista, ruta]);

  // Puntos del recinto elegido, para el selector del nivel mas especifico.
  useEffect(() => {
    if (!recintoId) {
      setPuntos([]);
      return;
    }
    let vigente = true;
    fetch(`${apiUrl}/admin/sites/${recintoId}/checkpoints`, { credentials: 'include' })
      .then(async (respuesta) => {
        if (!vigente || !respuesta.ok) return;
        const lista = (await respuesta.json()) as PuntoParaReglas[];
        setPuntos(lista.filter((punto) => punto.isActive));
      })
      .catch(() => {
        if (vigente) setPuntos([]);
      });
    return () => {
      vigente = false;
    };
  }, [apiUrl, recintoId]);

  const grupos = useMemo(
    () => agruparParaFormulario(vista.editable, catalogo),
    [catalogo, vista.editable],
  );
  const cambios = useMemo(
    () => resumirCambios(base, estado, vista.editable),
    [base, estado, vista.editable],
  );
  const errores = useMemo(
    () => validarFormulario(estado, vista.editable),
    [estado, vista.editable],
  );
  const hayErrores = Object.keys(errores).length > 0;
  const propios = contarPropios(estado, vista.editable);

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

  function cambiarNivel(siguiente: RuleScope) {
    setNivel(siguiente);
    setAviso(null);
    // Con un solo recinto no tiene sentido obligar a elegirlo a mano.
    if (siguiente !== 'tenant' && !recintoId) {
      setRecintoId(recintosActivos[0]?.id ?? '');
    }
  }

  async function guardar() {
    if (!ruta || hayErrores || !cambios.length) return;
    const detalle = cambios.map(
      (cambio) => `«${cambio.etiqueta}» ${frasesDelCambio(cambio, catalogo.unitLabels)}`,
    );
    setGuardando(true);
    setAviso(null);
    try {
      const respuesta = await fetch(`${apiUrl}${ruta}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpoDelPut(estado, vista.editable)),
      });
      if (!respuesta.ok) {
        setAviso({ tono: 'error', texto: await mensajeDeError(respuesta) });
        return;
      }
      // El PUT devuelve la vista recalculada: se pinta esa, no lo que creiamos.
      aplicarVista((await respuesta.json()) as VistaReglas);
      setAviso({
        tono: 'ok',
        texto: `Guardado en ${NIVEL_TITULO[vista.scope].toLocaleLowerCase('es')}. ${detalle.length} ${
          detalle.length === 1 ? 'regla cambió' : 'reglas cambiaron'
        }:`,
        detalle,
      });
    } catch {
      setAviso({ tono: 'error', texto: 'No pudimos guardar. Revisa la conexión y reintenta.' });
    } finally {
      setGuardando(false);
    }
  }

  const faltaContexto =
    (nivel === 'site' && !recintoId) || (nivel === 'checkpoint' && !puntoId);
  const bloqueado = cargando || guardando;
  const hayFormulario = !faltaContexto && !sinVista;

  return (
    <section className="management-card management-wide reglas-panel" id="reglas">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Configuración</span>
          <h2>Reglas de operación</h2>
        </div>
        {hayFormulario ? (
          <span className="status-pill">
            {propios} de {vista.editable.length} definidas aquí
          </span>
        ) : null}
      </div>
      <p className="section-explanation">
        Cada regla se hereda del nivel de arriba mientras no la definas acá. El orden es plataforma →
        empresa → recinto → punto de control, y manda siempre el nivel más específico.
      </p>

      <div className="reglas-niveles" role="group" aria-label="Nivel de configuración">
        {nivelesDelAdmin(catalogo.scopes).map((opcion) => (
          <button
            key={opcion}
            type="button"
            className={`reglas-nivel${opcion === nivel ? ' activo' : ''}`}
            aria-pressed={opcion === nivel}
            disabled={guardando}
            onClick={() => cambiarNivel(opcion)}
          >
            {NIVEL_TITULO[opcion]}
          </button>
        ))}
      </div>

      {nivel !== 'tenant' ? (
        <div className="reglas-contexto">
          <label>
            <span>Recinto</span>
            <select
              value={recintoId}
              disabled={guardando}
              onChange={(evento) => {
                setRecintoId(evento.target.value);
                setPuntoId('');
              }}
            >
              <option value="">Elige un recinto</option>
              {recintosActivos.map((recinto) => (
                <option key={recinto.id} value={recinto.id}>
                  {recinto.branchName} · {recinto.name}
                </option>
              ))}
            </select>
          </label>
          {nivel === 'checkpoint' ? (
            <label>
              <span>Punto de control</span>
              <select
                value={puntoId}
                disabled={guardando || !recintoId}
                onChange={(evento) => setPuntoId(evento.target.value)}
              >
                <option value="">Elige un punto</option>
                {puntos.map((punto) => (
                  <option key={punto.id} value={punto.id}>
                    {punto.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

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

      {faltaContexto ? (
        <div className="dashboard-empty">
          <strong>
            {!recintosActivos.length
              ? 'Todavía no hay recintos activos'
              : nivel === 'site'
                ? 'Elige un recinto'
                : 'Elige un recinto y un punto de control'}
          </strong>
          <span>
            {!recintosActivos.length
              ? 'Crea un recinto en la sección Recintos y vuelve acá para afinar sus reglas.'
              : `Lo que configures acá solo afecta a ese ${nivel === 'site' ? 'recinto' : 'punto'}; el resto sigue heredando.`}
          </span>
        </div>
      ) : sinVista ? (
        <div className="dashboard-empty">
          <strong>No pudimos mostrar este nivel</strong>
          <span>Elige otro nivel o vuelve a intentarlo en unos segundos.</span>
        </div>
      ) : (
        <>
          <div className="reglas-leyenda">
            <span className="reglas-origen propio">Definido aquí</span>
            <span className="reglas-origen heredado">Heredado</span>
            <small>
              {cargando
                ? 'Cargando configuración…'
                : 'Lo heredado se sigue moviendo solo si cambia el nivel de arriba.'}
            </small>
          </div>

          {grupos.map((grupo) => (
            <div className="reglas-grupo" key={grupo.grupo}>
              <h3>{grupo.etiqueta}</h3>
              <div className="reglas-lista">
                {grupo.parametros.map((parametro) => {
                  const campo = estado[parametro.key];
                  if (!campo) return null;
                  return (
                    <ReglasCampo
                      key={parametro.key}
                      parametro={parametro}
                      campo={campo}
                      unitLabels={catalogo.unitLabels}
                      error={errores[parametro.key]}
                      bloqueado={bloqueado}
                      onCambiar={(valor) => definir(parametro.key, valor)}
                      onHeredar={() => heredar(parametro.key)}
                    />
                  );
                })}
              </div>
            </div>
          ))}

          {cambios.length ? (
            <div className="reglas-previa">
              <strong>Antes de guardar, esto es lo que cambia</strong>
              <ul>
                {cambios.map((cambio) => (
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
                ? 'Hay valores fuera de rango. Corrígelos para poder guardar.'
                : cambios.length
                  ? `${cambios.length} ${cambios.length === 1 ? 'cambio pendiente' : 'cambios pendientes'} en ${NIVEL_TITULO[vista.scope].toLocaleLowerCase('es')}.`
                  : 'Sin cambios pendientes.'}
            </span>
            <span className="reglas-barra-acciones">
              <button
                type="button"
                className="secondary-button"
                disabled={!cambios.length || bloqueado}
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
                disabled={!cambios.length || hayErrores || bloqueado}
                onClick={guardar}
              >
                {guardando ? 'Guardando…' : 'Guardar configuración'}
              </button>
            </span>
          </div>

          <p className="reglas-pie-nota">
            Solo aparecen las reglas que este nivel puede configurar. Las que no están se definen más
            arriba y llegan hasta acá por herencia.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Niveles que administra el ADMIN. El de plataforma es del SUPERADMIN
 * (PUT /api/platform/rules): acá se ve solo como origen de una herencia.
 */
function nivelesDelAdmin(scopes: readonly RuleScope[]): RuleScope[] {
  return scopes.filter((scope) => scope !== 'platform');
}

/** Endpoint de la vista de cada nivel. Sin id todavia no hay nada que pedir. */
function rutaDeNivel(nivel: RuleScope, targetId: string | null): string | null {
  if (nivel === 'tenant') return '/rules/admin';
  if (!targetId) return null;
  if (nivel === 'site') return `/rules/admin/sites/${targetId}`;
  if (nivel === 'checkpoint') return `/rules/admin/checkpoints/${targetId}`;
  return null;
}

async function mensajeDeError(respuesta: Response): Promise<string> {
  try {
    const datos = (await respuesta.json()) as { message?: string | string[] };
    if (Array.isArray(datos.message)) return datos.message.join('. ');
    if (datos.message) return datos.message;
  } catch {
    // Sin cuerpo util: se responde con el texto generico de abajo.
  }
  if (respuesta.status === 403) return 'Tu cuenta no puede configurar reglas en este nivel.';
  if (respuesta.status === 404) return 'Ese recinto o punto de control ya no está disponible.';
  return 'No fue posible completar la operación.';
}
