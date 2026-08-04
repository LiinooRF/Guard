'use client';

/**
 * "Asi esta operando hoy" — comprobacion contra lo que la app lee de verdad (#102).
 *
 * Es la prueba del criterio *el admin activa una funcion y aplica sin
 * actualizar la app*: en vez de creerle a la pantalla que acaba de guardar, se
 * le vuelve a preguntar al servidor por `GET /api/rules/effective`, que es
 * exactamente el endpoint que consulta el telefono del guardia. Si lo que
 * responde no coincide con lo guardado, se dice; una interfaz optimista
 * mostraria "listo" aunque el cambio no hubiera llegado a ninguna parte.
 *
 * HASTA DONDE LLEGA ESTA PRUEBA: se pide SIN `siteId`, o sea la resolucion
 * plataforma -> empresa. La mayoria de estas reglas admite excepcion por recinto
 * o por punto (`scopes` del catalogo), y en un recinto con excepcion el guardia
 * recibe OTRO valor. Por eso los textos de esta pantalla dicen "para toda la
 * empresa" y cada fila que admite excepcion lo declara: afirmar que esto es lo
 * que recibe cualquier telefono seria dar por probado un criterio que no se
 * probo. Recinto por recinto se revisa en Reglas de operacion.
 *
 * Doble funcion: esta misma lista es el resumen en lenguaje del cliente de los
 * parametros con valor (umbral de cumplimiento, retencion, destinatarios del
 * informe), que en este panel son de solo lectura.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  admiteExcepcionMasEspecifica,
  comprobarEnTerreno,
  consecuenciaDeclarada,
  type ComprobacionTerreno,
} from './funciones-modelo';
import { pedirJson } from './funciones-peticiones';
import {
  agruparParaFormulario,
  construirEstado,
  etiquetaOrigen,
  formatearValor,
  type CatalogoReglas,
  type ClaveRegla,
  type ValoresDeReglas,
  type VistaReglas,
} from './reglas-catalogo';
import type { RuleSource } from '@voxia/shared';

interface RespuestaEfectivas {
  rules: ValoresDeReglas;
  sources: Partial<Record<ClaveRegla, RuleSource>>;
}

export function FuncionesTerreno({
  catalogo,
  vista,
  apiUrl,
}: {
  catalogo: CatalogoReglas;
  /** La vista GUARDADA del nivel empresa. Comparar contra el formulario a medio editar marcaria diferencias falsas. */
  vista: VistaReglas;
  apiUrl: string;
}) {
  const [efectivas, setEfectivas] = useState<RespuestaEfectivas | null>(null);
  const [consultadoEn, setConsultadoEn] = useState<Date | null>(null);
  const [cargando, setCargando] = useState(false);
  const [fallo, setFallo] = useState(false);

  const comprobar = useCallback(async () => {
    setCargando(true);
    setFallo(false);
    const respuesta = await pedirJson<RespuestaEfectivas | null>(apiUrl, '/rules/effective', null);
    if (!respuesta) {
      setFallo(true);
    } else {
      setEfectivas(respuesta);
      // La hora se toma al recibir la respuesta y solo en el navegador: en el
      // servidor no existe la zona horaria de quien mira.
      setConsultadoEn(new Date());
    }
    setCargando(false);
  }, [apiUrl]);

  // Se comprueba al montar y cada vez que cambia lo guardado (el panel entrega
  // una vista nueva despues de cada PUT).
  useEffect(() => {
    void comprobar();
  }, [comprobar, vista]);

  const grupos = useMemo(
    () => agruparParaFormulario(vista.editable, catalogo),
    [catalogo, vista.editable],
  );
  const filas = useMemo(
    () =>
      comprobarEnTerreno(
        vista.editable,
        construirEstado(vista, catalogo.scopes),
        efectivas?.rules ?? null,
      ),
    [catalogo.scopes, efectivas, vista],
  );
  const porClave = useMemo(
    () => new Map<string, ComprobacionTerreno>(filas.map((fila) => [fila.clave, fila])),
    [filas],
  );
  const discrepantes = useMemo(() => filas.filter((fila) => fila.discrepa), [filas]);

  return (
    <section className="management-card management-wide reglas-panel" id="funciones-terreno">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Funciones del sistema</span>
          <h2>Así está operando hoy</h2>
        </div>
        <button type="button" className="secondary-button" disabled={cargando} onClick={comprobar}>
          {cargando ? 'Comprobando…' : 'Volver a comprobar'}
        </button>
      </div>

      <p className="section-explanation">
        Esto no es lo que dice esta pantalla: es lo que el sistema responde <b>para toda la
        empresa</b> en este momento. Sirve para confirmar que un cambio ya está rigiendo sin haber
        actualizado la app. Un recinto o un punto de control con excepción propia recibe otro
        valor: las reglas que lo permiten van marcadas, y sus excepciones se revisan en{' '}
        <a href="#reglas">Reglas de operación</a>.
      </p>

      {fallo ? (
        <div className="reglas-aviso error" role="status">
          <strong>No pudimos comprobar la configuración vigente</strong>
          <span>Vuelve a intentarlo en unos segundos.</span>
        </div>
      ) : null}

      {discrepantes.length ? (
        <div className="reglas-aviso error" role="status">
          <strong>Hay diferencias entre lo guardado y lo que rige</strong>
          <ul>
            {discrepantes.map((fila) => (
              <li key={fila.clave}>{fila.etiqueta}</li>
            ))}
          </ul>
          <span>
            Puede ser que alguien más lo haya cambiado recién, o que el valor guardado no se pueda
            aplicar. Vuelve a cargar la página antes de guardar encima.
          </span>
        </div>
      ) : null}

      {!efectivas ? (
        <div className="dashboard-empty">
          <strong>{cargando ? 'Consultando la configuración vigente…' : 'Sin datos todavía'}</strong>
          <span>Usa «Volver a comprobar» para preguntarle al servidor.</span>
        </div>
      ) : (
        <>
          {grupos.map((grupo) => (
            <div className="reglas-grupo" key={grupo.grupo}>
              <h3>{grupo.etiqueta}</h3>
              <div className="management-list">
                {grupo.parametros.map((parametro) => {
                  const fila = porClave.get(parametro.key);
                  if (!fila) return null;
                  const origen = efectivas.sources[parametro.key];
                  const consecuencia =
                    parametro.type === 'boolean'
                      ? consecuenciaDeclarada(parametro, Boolean(fila.efectivo))
                      : null;
                  // Lo consultado es el nivel empresa. Si la regla admite
                  // excepcion mas abajo, este valor NO es necesariamente el que
                  // recibe cada telefono.
                  const conExcepciones = admiteExcepcionMasEspecifica(
                    parametro,
                    vista.scope,
                    catalogo.scopes,
                  );
                  return (
                    <article className="management-row" key={parametro.key}>
                      <div>
                        <strong>{parametro.label}</strong>
                        <small>{consecuencia ?? parametro.description}</small>
                        {conExcepciones ? (
                          <small>
                            Un recinto o un punto de control puede tener otra configuración para
                            esta regla; acá se muestra la de toda la empresa.
                          </small>
                        ) : null}
                        {fila.discrepa ? (
                          <small>No coincide con lo guardado para la empresa.</small>
                        ) : null}
                      </div>
                      <span className={`state-chip${fila.discrepa ? '' : ' active'}`}>
                        {formatearValor(parametro, fila.efectivo, catalogo.unitLabels)}
                      </span>
                      <span
                        className={`reglas-origen ${origen === 'tenant' ? 'propio' : 'heredado'}`}
                      >
                        {origen ? `Viene de ${etiquetaOrigen(origen)}` : 'Origen desconocido'}
                      </span>
                    </article>
                  );
                })}
              </div>
            </div>
          ))}

          <p className="reglas-pie-nota">
            {consultadoEn
              ? `Consultado a las ${horaLocal(consultadoEn)} en la zona horaria de este equipo (${zonaDelEquipo()}).`
              : 'Sin consulta registrada.'}{' '}
            Los valores con número (umbrales, retención, destinatarios) se editan en{' '}
            <a href="#reglas">Reglas de operación</a>.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Hora del equipo que mira, nombrando la zona.
 *
 * Las reglas de operacion son de la empresa completa y no de un recinto, asi
 * que no hay una zona horaria del recinto que aplicar: se usa la del navegador
 * y se dice cual es, en vez de mostrar una hora sin zona que cada quien
 * interprete como quiera.
 */
function horaLocal(momento: Date): string {
  return new Intl.DateTimeFormat('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(momento);
}

function zonaDelEquipo(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'zona desconocida';
}
