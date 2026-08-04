/**
 * Envoltura y estados de las tarjetas del supervisor (#99).
 *
 * Componentes de presentacion puros: sin `'use client'`, sin estado y sin
 * fetch. Se renderizan en el servidor y llegan al navegador como HTML, que es
 * lo que corresponde en un panel que tambien se abre dentro de un WebView en un
 * telefono de gama baja.
 *
 * Las clases son las que ya existen en `globals.css` (las mismas del panel de
 * informes #87). No se agrega ni una regla de estilo: una hoja compartida es
 * mas facil de mantener que cinco variantes parecidas.
 */

import type { ReactNode } from 'react';

import { MOTIVO_TOPE } from './stats-charts-data';
import type { ResultadoSupervisor } from './supervisor-datos';

export function TarjetaSupervisor({
  id,
  eyebrow,
  titulo,
  explicacion,
  insignia,
  children,
}: {
  id: string;
  eyebrow: string;
  titulo: string;
  explicacion: string;
  insignia?: string;
  children: ReactNode;
}) {
  return (
    <section className="management-card stats-tarjeta" id={id}>
      <div className="card-heading">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{titulo}</h2>
        </div>
        {insignia ? <span className="status-pill">{insignia}</span> : null}
      </div>
      <p className="section-explanation">{explicacion}</p>
      {children}
    </section>
  );
}

/**
 * Traduce un resultado sin datos a algo que se pueda leer. Devuelve `null`
 * cuando hay datos: ahi manda el render de la tarjeta.
 *
 * El caso que mas importa es el 403. Para el SUPERVISOR significa siempre lo
 * mismo —ese recinto no esta en sus asignados— y decirlo asi evita que salga a
 * buscar un problema tecnico que no existe.
 */
export function EstadoSupervisor({ resultado }: { resultado: ResultadoSupervisor<unknown> }) {
  if (resultado.estado === 'ok') return null;

  if (resultado.estado === 'sin-permiso') {
    return (
      <p className="stats-estado aviso" role="status">
        <strong>Ese recinto no está entre los tuyos.</strong> Solo ves los recintos que un
        administrador de la empresa te asignó. Elige uno de los tuyos en el filtro de arriba, o
        pídele que te asigne ese.
      </p>
    );
  }

  if (resultado.estado === 'fuera-de-tope') {
    return (
      <p className="stats-estado aviso" role="status">
        <strong>Período demasiado largo para esta tarjeta.</strong>{' '}
        {MOTIVO_TOPE[resultado.clave]} Acorta el período arriba y vuelve a aplicar.
      </p>
    );
  }

  if (resultado.estado === 'rango-rechazado') {
    return (
      <p className="stats-estado aviso" role="status">
        <strong>El período no sirve para esta tarjeta.</strong> {resultado.mensaje}
      </p>
    );
  }

  if (resultado.estado === 'sin-sesion') {
    return (
      <p className="stats-estado error" role="alert">
        <strong>Tu sesión venció.</strong> Vuelve a entrar para ver tus recintos.
      </p>
    );
  }

  return (
    <p className="stats-estado error" role="alert">
      <strong>No pudimos cargar esta tarjeta.</strong> No es que no haya rondas: no logramos
      consultarlas. Actualiza la página en un momento más.
    </p>
  );
}

/**
 * Vacio de verdad: la consulta funciono y no hay nada que mostrar.
 *
 * Es una pantalla distinta de la de error a proposito. Un cero dibujado cuando
 * en realidad no sabemos se lee como "aqui no pasa nada", que es lo contrario
 * de lo que ocurre.
 */
export function VacioSupervisor({ titulo, detalle }: { titulo: string; detalle: string }) {
  return (
    <div className="dashboard-empty stats-vacio">
      <strong>{titulo}</strong>
      <span>{detalle}</span>
    </div>
  );
}
