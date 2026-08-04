'use client';

/**
 * Modulos del sistema segun la licencia contratada (#102).
 *
 * El admin prende y apaga SOLO dentro de lo que su plan incluye. El techo lo
 * arma el servidor (producto -> plan -> acuerdo con la empresa) y llega en
 * `editable`: lo que no esta ahi no se pinta. Un modulo que la empresa no tiene
 * desaparece, no queda visible y bloqueado — mostrarlo bloqueado seria decirle
 * al cliente "esto existe y no lo pagaste" en su propio panel.
 *
 * Esconder una casilla no es control de acceso: el servidor responde 403 (y la
 * base tiene ademas un trigger) si alguien intenta prender algo fuera de su
 * licencia. Esta pantalla solo evita el intento.
 */
import { useMemo, useState } from 'react';

import {
  cuerpoDelPutModulos,
  estadoInicialModulos,
  preferenciasQueSeLimpian,
  resumirCambiosModulos,
  type ClaveModulo,
  type EstadoModulos,
  type VistaModulos,
} from './funciones-modelo';
import { mensajeDeErrorApi } from './funciones-peticiones';

/**
 * No se pide GET /api/features/catalog: la vista de administracion ya trae las
 * fichas (`modules`, `editable`) y las etiquetas de nivel (`sourceLabels`).
 * Pedirlo aparte seria una llamada de mas para los mismos datos.
 */
export function FuncionesModulos({
  vistaInicial,
  apiUrl,
  onGuardado,
}: {
  vistaInicial: VistaModulos;
  apiUrl: string;
  /** Avisa al panel que guardo, para que el historial se vuelva a leer. */
  onGuardado?: () => void;
}) {
  const [vista, setVista] = useState<VistaModulos>(vistaInicial);
  const [estado, setEstado] = useState<EstadoModulos>(() => estadoInicialModulos(vistaInicial));
  const [base, setBase] = useState<EstadoModulos>(() => estadoInicialModulos(vistaInicial));
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'error'; texto: string } | null>(null);

  const cambios = useMemo(() => resumirCambiosModulos(base, estado), [base, estado]);
  const aLimpiar = useMemo(() => preferenciasQueSeLimpian(vista), [vista]);
  const encendidos = Object.values(estado).filter((campo) => campo?.encendido).length;

  function mover(clave: ClaveModulo, encendido: boolean) {
    setEstado((previo) => {
      const campo = previo[clave];
      if (!campo) return previo;
      return { ...previo, [clave]: { ...campo, encendido } };
    });
  }

  function aplicarVista(nueva: VistaModulos) {
    setVista(nueva);
    setEstado(estadoInicialModulos(nueva));
    setBase(estadoInicialModulos(nueva));
  }

  async function guardar() {
    if (!cambios.length || guardando) return;
    setGuardando(true);
    setAviso(null);
    try {
      const respuesta = await fetch(`${apiUrl}/features/admin`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        // Con `base` para poder distinguir lo que el admin decidio (ya escrito o
        // movido recien) de lo que solo esta en su valor de fabrica: mandar esto
        // ultimo lo congelaria como decision suya. Ver `cuerpoDelPutModulos`.
        body: JSON.stringify(cuerpoDelPutModulos(base, estado)),
      });
      if (!respuesta.ok) {
        setAviso({ tono: 'error', texto: await mensajeDeErrorApi(respuesta) });
        return;
      }
      // El PUT devuelve la vista recalculada: se pinta esa y no lo que creiamos.
      aplicarVista((await respuesta.json()) as VistaModulos);
      onGuardado?.();
      const unico = cambios.length === 1 ? cambios[0] : undefined;
      setAviso({
        tono: 'ok',
        texto: unico
          ? `Listo. «${unico.etiqueta}» quedó ${unico.despues ? 'activado' : 'apagado'} para toda la empresa.`
          : `Listo. ${cambios.length} módulos actualizados para toda la empresa.`,
      });
    } catch {
      setAviso({ tono: 'error', texto: 'No pudimos guardar. Revisa la conexión y reintenta.' });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section className="management-card management-wide reglas-panel" id="funciones">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Funciones del sistema</span>
          <h2>Módulos contratados</h2>
        </div>
        <span className="status-pill">
          {vista.plan ? `Plan ${vista.plan.name}` : 'Plan sin identificar'}
        </span>
      </div>

      <p className="section-explanation">
        Estos son los módulos que incluye tu plan. Puedes apagar los que tu operación no usa: el
        módulo apagado desaparece del panel y de la app, y se vuelve a prender cuando quieras. Para
        sumar uno que no aparece en esta lista hay que cambiar de plan.
      </p>

      {aviso ? (
        <div className={`reglas-aviso ${aviso.tono}`} role="status">
          <strong>{aviso.texto}</strong>
        </div>
      ) : null}

      {!vista.editable.length ? (
        <div className="dashboard-empty">
          <strong>Tu plan no trae módulos que puedas configurar</strong>
          <span>
            El sistema opera igual con lo que tu plan incluye. Si necesitas activar alguna función,
            conversa el cambio de plan con tu proveedor.
          </span>
        </div>
      ) : (
        <>
          <div className="reglas-leyenda">
            <span className="status-pill">
              {encendidos} de {vista.editable.length} activos
            </span>
            <small>
              Apagar un módulo no borra nada de lo que ya se registró: deja de mostrarse, no se
              elimina.
            </small>
          </div>

          <div className="reglas-lista">
            {vista.editable.map((ficha) => {
              const campo = estado[ficha.key];
              if (!campo) return null;
              return (
                <article
                  key={ficha.key}
                  className={`reglas-campo ${campo.encendido ? 'es-propio' : 'es-heredado'}`}
                >
                  <div className="reglas-campo-cabecera">
                    <div className="reglas-campo-titulo">
                      <strong>{ficha.label}</strong>
                      <p>{ficha.description}</p>
                    </div>
                    <span className={`reglas-origen ${campo.escrito ? 'propio' : 'heredado'}`}>
                      {campo.escrito ? 'Decidido aquí' : 'Valor de fábrica'}
                    </span>
                  </div>

                  <div className="reglas-control">
                    <div className="reglas-switch" role="group" aria-label={ficha.label}>
                      <button
                        type="button"
                        className={campo.encendido ? 'activo' : ''}
                        aria-pressed={campo.encendido}
                        disabled={guardando}
                        onClick={() => mover(ficha.key, true)}
                      >
                        Activado
                      </button>
                      <button
                        type="button"
                        className={!campo.encendido ? 'activo' : ''}
                        aria-pressed={!campo.encendido}
                        disabled={guardando}
                        onClick={() => mover(ficha.key, false)}
                      >
                        Apagado
                      </button>
                    </div>
                  </div>

                  <div className="reglas-campo-pie">
                    <span className="reglas-nota">
                      {campo.encendido ? `Si lo apagas: ${ficha.whenOff}` : ficha.whenOff}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>

          {aLimpiar.conocidas.length || aLimpiar.desconocidas ? (
            <div className="reglas-aviso error" role="status">
              <strong>Hay preferencias guardadas que tu plan ya no incluye</strong>
              <ul>
                {aLimpiar.conocidas.map((ficha) => (
                  <li key={ficha.key}>{ficha.label}</li>
                ))}
                {aLimpiar.desconocidas ? (
                  <li>
                    {aLimpiar.desconocidas} módulo(s) que ya no existen en el sistema.
                  </li>
                ) : null}
              </ul>
              <span>
                Hoy no se aplican. Al guardar en esta pantalla se quitan, y si más adelante vuelven
                a tu plan hay que activarlos de nuevo.
              </span>
            </div>
          ) : null}

          {cambios.length ? (
            <div className="reglas-previa">
              <strong>Antes de guardar, esto es lo que cambia</strong>
              <ul>
                {cambios.map((cambio) => (
                  <li
                    key={cambio.clave}
                    className={`reglas-cambio ${cambio.despues ? 'definido' : 'heredado'}`}
                  >
                    <b>{cambio.etiqueta}</b> {cambio.despues ? 'se activa' : 'se apaga'} para toda
                    la empresa
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="reglas-barra">
            <span className="reglas-barra-texto">
              {cambios.length
                ? `${cambios.length} ${cambios.length === 1 ? 'módulo pendiente' : 'módulos pendientes'} de guardar.`
                : 'Sin cambios pendientes.'}
            </span>
            <span className="reglas-barra-acciones">
              <button
                type="button"
                className="secondary-button"
                disabled={!cambios.length || guardando}
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
                disabled={!cambios.length || guardando}
                onClick={guardar}
              >
                {guardando ? 'Guardando…' : 'Guardar módulos'}
              </button>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
