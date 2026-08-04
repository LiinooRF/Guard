'use client';

import { useCallback, useEffect, useState } from 'react';

import { PanicoBoton } from './panico-boton';
import {
  archivarAlerta,
  configurarLectorAcuse,
  dispararPanico,
  iniciarPanico,
  marcarFalsaAlarma,
  reintentarAhora,
  suscribirPanico,
  type AlertaPanico,
  type LectorAcuse,
  type Ubicacion,
} from './panico-envio';
import { PanicoEstado } from './panico-estado';
import { PanicoFalsaAlarma } from './panico-falsa-alarma';
import { usePanicoReglas } from './panico-reglas';

/**
 * El bloque de emergencia de la pantalla del guardia (#125).
 *
 * Reemplaza al bloque `guardia-panico` que hoy vive dentro de
 * `guard-event-form.tsx` con dos confirmaciones a toque. Ver INTEGRACION.md.
 *
 * El panico sigue siendo UNA NOVEDAD con criticidad maxima —mismo endpoint,
 * misma cola, mismo modelo—; lo que cambia es como se dispara y como se ve que
 * llego.
 *
 * Es autonomo a proposito: envia por su cuenta en vez de pedirle al formulario
 * que lo haga. La entrega garantizada necesita sobrevivir a que el guardia
 * cambie de vista, cierre el WebView o se quede sin bateria a mitad del envio, y
 * eso no se sostiene desde el estado de un componente de formulario.
 *
 * LO QUE ESTE COMPONENTE NO HACE, Y ES DELIBERADO:
 *   - no vibra ni suena (`navigator.vibrate` no se llama en ningun camino);
 *   - no muestra confirmacion, ni banner, ni cambio de color al disparar;
 *   - no mueve el foco ni hace scroll: la pantalla queda igual que antes.
 * Quien mire el telefono por encima del hombro del guardia no ve nada.
 */

export function PanicoPanel({
  apiUrl,
  patrolId,
  siteId,
  zonaHoraria,
  ubicacion,
  leerAcuse,
  onDisparada,
}: {
  apiUrl: string;
  /** Ronda en curso. Sin ella el servidor asocia el evento a la ultima del guardia. */
  patrolId?: string;
  /** Recinto, para resolver las reglas en su nivel de la cascada. */
  siteId?: string;
  /** Zona horaria del recinto (`sites.timezone`). Sin ella se usa la del telefono. */
  zonaHoraria?: string;
  /**
   * Ultima posicion conocida, si la pantalla ya la tenia. NO se pide GPS aca: un
   * fix puede tardar segundos y la alerta no espera. Si no hay, la alerta viaja
   * sin coordenadas, que es mejor que una alerta tarde.
   */
  ubicacion?: Ubicacion;
  /** Lectura del acuse de recibo. Ver `LectorAcuse`: hoy la API no la expone. */
  leerAcuse?: LectorAcuse;
  /** Para que la ronda registre la novedad en su resumen del turno. */
  onDisparada?: (alerta: AlertaPanico) => void;
}) {
  const reglas = usePanicoReglas(apiUrl, siteId);
  const [alertas, setAlertas] = useState<readonly AlertaPanico[]>([]);

  useEffect(() => suscribirPanico(setAlertas), []);

  useEffect(
    () => iniciarPanico({ apiUrl, segundosReintento: reglas.segundosReintento }),
    [apiUrl, reglas.segundosReintento],
  );

  useEffect(() => {
    configurarLectorAcuse(leerAcuse);
    return () => configurarLectorAcuse(undefined);
  }, [leerAcuse]);

  const disparar = useCallback(() => {
    const alerta = dispararPanico({
      ...(patrolId ? { patrolId } : {}),
      ...(ubicacion ? { ubicacion } : {}),
    });
    onDisparada?.(alerta);
  }, [onDisparada, patrolId, ubicacion]);

  // La correccion se ofrece sobre la ultima alerta que el servidor ya conoce:
  // sin id de servidor no hay nada que corregir, y una rechazada nunca llego a
  // movilizar a nadie.
  const corregible = alertas.find(
    (alerta) => alerta.eventId !== undefined && !alerta.falsaAlarma && alerta.estado !== 'rechazado',
  );
  const idCorregible = corregible?.eventId;

  return (
    <div className="guardia-panico panico-panel">
      <h3>Emergencia</h3>

      <PanicoBoton onDisparar={disparar} segundosMantener={reglas.segundosMantener} />

      <PanicoEstado
        alertas={alertas}
        onArchivar={archivarAlerta}
        onSubirAhora={reintentarAhora}
        {...(zonaHoraria ? { zonaHoraria } : {})}
      />

      {corregible !== undefined && idCorregible !== undefined ? (
        <PanicoFalsaAlarma
          apiUrl={apiUrl}
          eventId={idCorregible}
          onCancelada={() => marcarFalsaAlarma(corregible.clientEventId)}
        />
      ) : null}
    </div>
  );
}
