'use client';

import { DEFAULT_PATROL_RULES, type PatrolRules } from '@voxia/shared';
import { useEffect, useState } from 'react';

import { pedirApi } from './guard-outbox';
import { borrarClave, escribirJson, leerJson } from './guard-storage';

/**
 * Las dos reglas de empresa que gobiernan el indicador de sincronizacion (#74).
 *
 * Ningun numero de negocio vive en el componente. "Cuanto puede quedar trabajo
 * sin subir antes de tratarlo como problema" y "si terminar el turno con cola
 * pendiente exige confirmacion" son decisiones de cada empresa: una ronda de
 * perimetro sin cobertura tolera media hora, una porteria con wifi no.
 *
 * Se resuelven en el servidor con la cascada completa
 * (plataforma -> tenant -> recinto -> punto) y llegan por
 * `GET /rules/effective`, que el GUARDIA puede leer porque su rol tiene
 * `account:sessions:manage`.
 *
 * OFFLINE: lo ultimo que se leyo queda cacheado en el telefono. Sin senal el
 * endpoint no responde, y pedirle a la pantalla del guardia que espere una
 * regla para poder avisarle que esta sin senal seria exactamente al reves.
 * Mientras no haya nada cacheado se usan los defaults del producto, que salen
 * de `@voxia/shared` y no de este archivo.
 */

const CLAVE_CACHE = 'voxia.guard.sync.reglas.v1';

export interface ReglasSync {
  /** Minutos con trabajo sin subir tras los cuales la pantalla lo trata como problema. */
  esperaMaxMin: number;
  /** Terminar el turno con trabajo sin subir exige una confirmacion explicita. */
  confirmarAlCerrar: boolean;
}

/** Defaults del producto. Salen del catalogo compartido, nunca de un literal aca. */
export const REGLAS_SYNC_POR_DEFECTO: ReglasSync = {
  esperaMaxMin: DEFAULT_PATROL_RULES.syncPendingWarnMin,
  confirmarAlCerrar: DEFAULT_PATROL_RULES.syncConfirmShiftEndWithPending,
};

/**
 * Toma solo las dos claves que esta pantalla usa. Si el servidor manda una
 * regla con un tipo inesperado —o una version vieja del cache no la tiene— se
 * cae al default en vez de romper la pantalla en terreno.
 */
export function extraerReglasSync(valores: Partial<PatrolRules> | undefined): ReglasSync {
  const espera = valores?.syncPendingWarnMin;
  const confirmar = valores?.syncConfirmShiftEndWithPending;
  return {
    esperaMaxMin:
      typeof espera === 'number' && Number.isFinite(espera) && espera > 0
        ? espera
        : REGLAS_SYNC_POR_DEFECTO.esperaMaxMin,
    confirmarAlCerrar:
      typeof confirmar === 'boolean' ? confirmar : REGLAS_SYNC_POR_DEFECTO.confirmarAlCerrar,
  };
}

function leerCache(): ReglasSync | null {
  const guardado = leerJson<Partial<ReglasSync> | null>(CLAVE_CACHE, null);
  if (guardado === null || typeof guardado !== 'object') return null;
  if (typeof guardado.esperaMaxMin !== 'number' || typeof guardado.confirmarAlCerrar !== 'boolean') {
    // Cache de una version anterior con otra forma: se descarta en vez de
    // arrastrar un valor que ya no significa lo mismo.
    borrarClave(CLAVE_CACHE);
    return null;
  }
  return { esperaMaxMin: guardado.esperaMaxMin, confirmarAlCerrar: guardado.confirmarAlCerrar };
}

/**
 * `activo` en false deja el hook quieto: sirve cuando el componente padre ya
 * recibio las reglas resueltas y no hay por que gastar una llamada mas en un
 * telefono que puede estar con senal de sobra o sin ninguna.
 */
export function useReglasSync(apiUrl: string, siteId?: string, activo = true): ReglasSync {
  const [reglas, setReglas] = useState<ReglasSync>(REGLAS_SYNC_POR_DEFECTO);

  useEffect(() => {
    if (!activo) return undefined;
    let cancelado = false;

    // Lo cacheado pinta primero. Se lee despues de montar y no en el estado
    // inicial para no romper la hidratacion: el servidor no tiene localStorage.
    const cacheada = leerCache();
    if (cacheada) setReglas(cacheada);

    void (async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      try {
        const ruta =
          siteId === undefined
            ? '/rules/effective'
            : `/rules/effective?siteId=${encodeURIComponent(siteId)}`;
        const respuesta = await pedirApi(apiUrl, ruta);
        if (!respuesta.ok || cancelado) return;
        const cuerpo = (await respuesta.json()) as { rules?: Partial<PatrolRules> };
        const frescas = extraerReglasSync(cuerpo.rules);
        escribirJson(CLAVE_CACHE, frescas);
        if (!cancelado) setReglas(frescas);
      } catch {
        // Sin senal se sigue con lo cacheado. No es un error que el guardia
        // deba ver: su problema es la ronda, no de donde salio un umbral.
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [activo, apiUrl, siteId]);

  return reglas;
}
