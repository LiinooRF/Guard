'use client';

import { useEffect, useState } from 'react';

import { pedirApi } from './guard-outbox';
import { escribirJson, leerJson } from './guard-storage';

/**
 * Los dos parametros configurables del boton de panico (#125).
 *
 * Cuantos segundos hay que sostener el boton y cada cuanto se insiste con una
 * alerta sin entregar son decisiones de cada empresa, no del producto: una
 * empresa con guardias de guantes gruesos va a querer 2 segundos y otra con
 * telefonos que viven en el bolsillo va a querer 5. Por eso salen de
 * `GET /rules/effective` y no de una constante.
 *
 * Orden en que se resuelve el valor, y por que:
 *
 *   1. Lo que responde el servidor para ESTE recinto. Esa respuesta ya trae la
 *      cascada resuelta (plataforma -> empresa -> recinto) Y el default del
 *      producto cuando ningun nivel lo sobreescribe: el telefono no reimplementa
 *      nada de eso.
 *   2. Lo ultimo que se supo, guardado en el telefono. La ronda pasa en
 *      subterraneos: si hay que esperar la red para saber cuanto dura el gesto,
 *      el boton no sirve justo donde se necesita.
 *   3. El ultimo recurso de mas abajo, solo hasta que llegue (1) o (2).
 *
 * A proposito NO se importa `DEFAULT_PATROL_RULES` de `@voxia/shared`: ese valor
 * se calcula con zod, y un import de valor meteria zod entero en el bundle que
 * se abre dentro del WebView de un telefono de gama baja. Todo `apps/web`
 * importa de ese paquete solo tipos, y esto no es la excepcion.
 *
 * Solo se cachean estos dos numeros y ningun dato de personas.
 */

export interface ReglasPanico {
  segundosMantener: number;
  segundosReintento: number;
}

const CLAVE_CACHE = 'voxia.guard.panic.rules.v1';

const CLAVE_MANTENER = 'panicHoldSeconds';
const CLAVE_REINTENTO = 'panicRetrySeconds';

/**
 * ULTIMO RECURSO, y los dos unicos numeros escritos de este carril.
 *
 * NO son la regla del producto: la regla vive en `packages/shared/src/rules.ts`
 * y la edita el admin (ver INTEGRACION.md). Estos valores solo sostienen el
 * primer render y el caso "sin senal y sin nada cacheado todavia", porque un
 * boton de panico que no se puede apretar es peor que uno mal calibrado.
 * Coinciden con el default declarado; si ese default cambia, este no manda.
 */
const SIN_REGLA: ReglasPanico = { segundosMantener: 3, segundosReintento: 15 };

/**
 * El rango lo valida el schema del servidor al guardar; aca solo se descarta lo
 * que no es un entero usable, para no cablear un maximo en la web.
 */
function segundos(valor: unknown): number | undefined {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= 1 ? valor : undefined;
}

function resolver(fuente: Record<string, unknown> | undefined): ReglasPanico {
  return {
    segundosMantener: segundos(fuente?.[CLAVE_MANTENER]) ?? SIN_REGLA.segundosMantener,
    segundosReintento: segundos(fuente?.[CLAVE_REINTENTO]) ?? SIN_REGLA.segundosReintento,
  };
}

export function usePanicoReglas(apiUrl: string, siteId?: string): ReglasPanico {
  // El primer render tiene que dar lo mismo en el servidor y en el navegador:
  // leer el telefono aca romperia la hidratacion. La cache se lee en el efecto.
  const [reglas, setReglas] = useState<ReglasPanico>(SIN_REGLA);

  useEffect(() => {
    let cancelado = false;

    const cache = leerJson<Record<string, unknown> | null>(CLAVE_CACHE, null);
    if (cache) setReglas(resolver(cache));

    void (async () => {
      try {
        const ruta = siteId
          ? `/rules/effective?siteId=${encodeURIComponent(siteId)}`
          : '/rules/effective';
        const respuesta = await pedirApi(apiUrl, ruta);
        if (!respuesta.ok || cancelado) return;

        const cuerpo = (await respuesta.json()) as { rules?: Record<string, unknown> };
        if (cancelado || !cuerpo.rules) return;

        const soloPanico: Record<string, unknown> = {
          [CLAVE_MANTENER]: cuerpo.rules[CLAVE_MANTENER],
          [CLAVE_REINTENTO]: cuerpo.rules[CLAVE_REINTENTO],
        };
        escribirJson(CLAVE_CACHE, soloPanico);
        setReglas(resolver(soloPanico));
      } catch {
        // Sin senal se sigue con lo cacheado. Que no se puedan leer las reglas
        // nunca deja al guardia sin boton.
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [apiUrl, siteId]);

  return reglas;
}
