'use client';

import { useEffect, useState } from 'react';

import { pedirApi } from './guard-outbox';
import { escribirJson, leerJson } from './guard-storage';
import { tareasDelCierre } from './guard-tareas-modelo';

/**
 * Checklist del turno (#93).
 *
 * La plantilla la resuelve el servidor por recinto y turno; el teléfono no
 * decide cuál corresponde. Un ítem marcado como FALLA no es un dato de informe:
 * el extintor descargado le llega al supervisor mientras el guardia todavía está
 * en el recinto, así que se manda apenas se completa y no al final del turno.
 *
 * OJO con lo offline: `POST /sync/push` solo acepta operaciones `scan` y
 * `event`, así que el checklist NO tiene cola. Sin señal las respuestas quedan
 * guardadas en el teléfono y el guardia reintenta. Ver INTEGRACION.md.
 *
 * Acá quedan SOLO las tareas sin punto (#265). Las que tienen `checkpointId` se
 * responden al escanear su punto, con su propia cola —`guard-tareas-punto`—, y
 * ofrecerlas otra vez en el cierre haría que el guardia conteste algo que el
 * servidor va a descartar por duplicado.
 */

const CLAVE_RESPUESTAS = 'sentrycore.guard.checklist.v1';

type TipoRespuesta = 'ok_falla' | 'texto' | 'numero';

interface ItemChecklist {
  id: string;
  position: number;
  label: string;
  responseType: TipoRespuesta;
  requiresPhotoOnFail: boolean;
  /** Con punto, la tarea se responde al escanearlo y no acá. Ver #265. */
  checkpointId?: string | null;
}

type Plantilla =
  | { patrolId: string; hasChecklist: false }
  | {
      patrolId: string;
      hasChecklist: true;
      template: { id: string; name: string; items: ItemChecklist[] };
    };

interface ResultadoItem {
  itemId: string;
  status: 'aplicado' | 'duplicado' | 'rechazado';
  reason?: string;
}

interface Respuesta {
  value: string;
  notes?: string;
}

export function GuardChecklist({ patrolId, apiUrl }: { patrolId: string; apiUrl: string }) {
  const [plantilla, setPlantilla] = useState<Plantilla>();
  const [respuestas, setRespuestas] = useState<Record<string, Respuesta>>({});
  const [enviando, setEnviando] = useState(false);
  const [mensaje, setMensaje] = useState<string>();
  const [rechazos, setRechazos] = useState<ResultadoItem[]>([]);

  useEffect(() => {
    let cancelado = false;
    setRespuestas(leerJson<Record<string, Respuesta>>(`${CLAVE_RESPUESTAS}:${patrolId}`, {}));

    void (async () => {
      try {
        const respuesta = await pedirApi(apiUrl, `/checklists/patrols/${patrolId}/template`);
        if (!respuesta.ok || cancelado) return;
        setPlantilla((await respuesta.json()) as Plantilla);
      } catch {
        // Sin señal no hay checklist que mostrar; el resto del cierre sirve igual.
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [apiUrl, patrolId]);

  if (plantilla === undefined || !plantilla.hasChecklist) return null;

  function responder(itemId: string, cambio: Respuesta) {
    setRespuestas((actual) => {
      const siguiente = { ...actual, [itemId]: cambio };
      escribirJson(`${CLAVE_RESPUESTAS}:${patrolId}`, siguiente);
      return siguiente;
    });
  }

  async function enviar() {
    const seleccion = Object.entries(respuestas)
      .filter(([, respuesta]) => respuesta.value.trim().length > 0)
      .map(([itemId, respuesta]) => ({
        itemId,
        value: respuesta.value.trim(),
        ...(respuesta.notes?.trim() ? { notes: respuesta.notes.trim() } : {}),
      }));
    if (!seleccion.length) {
      setMensaje('Responde al menos un ítem antes de enviar.');
      return;
    }

    setEnviando(true);
    setMensaje(undefined);
    setRechazos([]);
    try {
      const respuesta = await pedirApi(apiUrl, `/checklists/patrols/${patrolId}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses: seleccion }),
      });
      if (!respuesta.ok) {
        setMensaje('El servidor no aceptó el checklist. Vuelve a intentarlo.');
        return;
      }
      const cuerpo = (await respuesta.json()) as { results: ResultadoItem[]; failed: number };
      const malos = cuerpo.results.filter((resultado) => resultado.status === 'rechazado');
      setRechazos(malos);
      setMensaje(
        malos.length
          ? `Se guardaron ${cuerpo.results.length - malos.length} ítems; ${malos.length} quedaron pendientes.`
          : cuerpo.failed
            ? `Checklist enviado. ${cuerpo.failed} falla(s) avisadas al supervisor.`
            : 'Checklist enviado.',
      );
    } catch {
      setMensaje(
        'Sin señal: tus respuestas quedaron guardadas en el teléfono. Reintenta cuando tengas conexión.',
      );
    } finally {
      setEnviando(false);
    }
  }

  const items = tareasDelCierre(plantilla.template.items);
  // Una plantilla cuyas tareas son todas de un punto no deja nada que responder
  // en el cierre: la sección entera sobra.
  if (!items.length) return null;

  return (
    <section className="guardia-checklist" aria-labelledby="guardia-checklist-titulo">
      <h3 id="guardia-checklist-titulo">{plantilla.template.name}</h3>

      {items.map((item) => (
        <Item
          key={item.id}
          item={item}
          respuesta={respuestas[item.id]}
          onResponder={(cambio) => responder(item.id, cambio)}
        />
      ))}

      <button
        className="guardia-boton-primario"
        disabled={enviando}
        onClick={() => void enviar()}
        type="button"
      >
        {enviando ? 'Enviando…' : 'Enviar checklist'}
      </button>

      {mensaje ? (
        <p className="guardia-anuncio" role="status" aria-live="polite">
          {mensaje}
        </p>
      ) : null}
      {rechazos.length ? (
        <ul className="guardia-rechazos" role="alert">
          {rechazos.map((rechazo) => (
            <li key={rechazo.itemId}>{rechazo.reason ?? 'El servidor rechazó este ítem.'}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Item({
  item,
  respuesta,
  onResponder,
}: {
  item: ItemChecklist;
  respuesta: Respuesta | undefined;
  onResponder: (cambio: Respuesta) => void;
}) {
  const valor = respuesta?.value ?? '';
  const esFalla = item.responseType === 'ok_falla' && valor === 'falla';

  return (
    <div className="guardia-checklist-item">
      <p className="guardia-checklist-label" id={`item-${item.id}`}>
        {item.label}
      </p>

      {item.responseType === 'ok_falla' ? (
        <div className="guardia-ok-falla" role="group" aria-labelledby={`item-${item.id}`}>
          <button
            className={`guardia-boton-opcion${valor === 'ok' ? ' elegida' : ''}`}
            onClick={() => onResponder({ value: 'ok' })}
            type="button"
          >
            OK
          </button>
          <button
            className={`guardia-boton-opcion falla${esFalla ? ' elegida' : ''}`}
            onClick={() => onResponder({ value: 'falla', ...(respuesta?.notes ? { notes: respuesta.notes } : {}) })}
            type="button"
          >
            Falla
          </button>
        </div>
      ) : (
        <input
          aria-labelledby={`item-${item.id}`}
          className="guardia-entrada"
          inputMode={item.responseType === 'numero' ? 'decimal' : 'text'}
          maxLength={500}
          onChange={(evento) => onResponder({ value: evento.target.value })}
          type="text"
          value={valor}
        />
      )}

      {esFalla ? (
        <>
          <textarea
            aria-label={`Observación de ${item.label}`}
            className="guardia-texto"
            maxLength={500}
            onChange={(evento) => onResponder({ value: 'falla', notes: evento.target.value })}
            placeholder="Qué observaste"
            rows={2}
            value={respuesta?.notes ?? ''}
          />
          {item.requiresPhotoOnFail ? (
            <p className="guardia-aviso">
              Este ítem exige foto cuando se marca falla y todavía no se puede adjuntar desde esta
              pantalla. Descríbelo en la observación y avisa por radio.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
