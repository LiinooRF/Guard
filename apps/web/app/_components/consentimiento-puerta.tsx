'use client';

/**
 * La pantalla de consentimiento del PRIMER INGRESO (#78).
 *
 * `consentimiento-aviso.tsx` ya existia pero no lo montaba nadie: era una
 * seccion suelta que ningun panel renderizaba. Esto es lo que faltaba — el
 * envoltorio que la pone delante del trabajador antes que el resto de la
 * pantalla, y que despues la deja siempre a mano para retirar el consentimiento.
 *
 * Tres decisiones:
 *
 *  - Cuando bloquea, los `children` no se MONTAN: el panel no queda a un scroll
 *    de distancia, y un aviso que se puede saltar con la rueda del mouse no es
 *    aviso previo. Ojo con lo que esto NO es: los `children` llegan armados
 *    desde un Server Component (`ConsentimientoTrabajador`), asi que React ya
 *    los renderizo en el servidor y viajan en el payload RSC aunque no se
 *    monten — incluidas las consultas propias de `StatsCharts` en el panel del
 *    supervisor. El bloqueo es de la pantalla, no del trabajo del servidor ni
 *    del peso que baja el WebView del guardia. Decidirlo arriba (que el Server
 *    Component no arme el panel) ahorraria las dos cosas, pero deja al cliente
 *    sin nada que mostrar al aceptar: habria que recargar. Anotado en
 *    INTEGRACION.md.
 *  - Aceptar y no aceptar cierran la puerta por igual, y ademas hay
 *    "Responder más tarde". Nadie queda encerrado: la decision tiene que ser
 *    libre, y el servidor ya se encarga de no guardar recorrido sin aceptacion
 *    vigente.
 *  - Tras responder se vuelve a preguntar el estado al servidor en vez de
 *    suponerlo. La respuesta puede ser distinta de lo que la interfaz espera
 *    (por ejemplo, retirar sin tener nada vigente no cambia nada).
 */
import { useState, type ReactNode } from 'react';

import { ConsentimientoAviso, type AvisoConsentimiento } from './consentimiento-aviso';
import { bajadaDePuerta, debeMostrarPuerta, tituloDePuerta } from './consentimiento-estado';

export function ConsentimientoPuerta({
  avisoInicial,
  apiUrl,
  children,
}: {
  /** `null` = no se pudo leer el aviso. Se avisa, no se finge que no existe. */
  avisoInicial: AvisoConsentimiento | null;
  apiUrl: string;
  children?: ReactNode;
}) {
  const [aviso, setAviso] = useState(avisoInicial);
  const [yaRespondio, setYaRespondio] = useState(false);

  /**
   * La persona respondio (acepto o se nego). Se cierra la puerta y se relee el
   * estado.
   *
   * El orden importa: la puerta se cierra AL TIRO y no cuando llegue la
   * respuesta de la red. En un subterraneo esa consulta puede demorar o fallar,
   * y dejar al trabajador mirando la misma pantalla despues de haber contestado
   * es exactamente el bucle que hay que evitar.
   */
  async function alResponder() {
    setYaRespondio(true);
    try {
      const respuesta = await fetch(`${apiUrl}/consent/policy`, { credentials: 'include' });
      if (respuesta.ok) setAviso((await respuesta.json()) as AvisoConsentimiento);
    } catch {
      // Sin conexion se queda con lo que ya tenia en pantalla. Su respuesta ya
      // viajo al servidor; refrescar el resumen es secundario.
    }
  }

  if (!aviso) {
    return (
      <>
        <section className="management-card management-wide" id="consentimiento">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Ubicación</span>
              <h2>Aviso de geolocalización</h2>
            </div>
          </div>
          <div className="dashboard-empty">
            <strong>No pudimos mostrarte el aviso</strong>
            <span>
              Vuelve a cargar la página. Mientras no puedas leerlo y aceptarlo, tu recorrido no se
              registra.
            </span>
          </div>
        </section>
        {children}
      </>
    );
  }

  if (debeMostrarPuerta(aviso, yaRespondio)) {
    return (
      <>
        <section className="management-card management-wide" id="consentimiento-primer-ingreso">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Antes de continuar</span>
              <h2>{tituloDePuerta(aviso)}</h2>
            </div>
          </div>
          <p className="section-explanation">{bajadaDePuerta(aviso)}</p>
          <div className="row-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setYaRespondio(true)}
            >
              Responder más tarde
            </button>
          </div>
          <p className="form-note">
            Si respondes después, sigues trabajando igual: mientras no aceptes, no se guarda ninguna
            posición tuya. El aviso queda disponible más abajo en esta misma pantalla.
          </p>
        </section>
        <ConsentimientoAviso aviso={aviso} apiUrl={apiUrl} onCambio={() => void alResponder()} />
      </>
    );
  }

  // Fuera de la puerta el aviso va al final: la pantalla vuelve a ser la tarea
  // de la persona, pero retirar el consentimiento sigue estando a un scroll de
  // distancia y no escondido en un menu.
  return (
    <>
      {children}
      <ConsentimientoAviso aviso={aviso} apiUrl={apiUrl} onCambio={() => void alResponder()} />
    </>
  );
}
