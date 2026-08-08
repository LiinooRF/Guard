'use client';

import { useState } from 'react';

import { procesarFoto } from './guard-photo';
import { fijarServerId, guardarFoto } from './guard-photo-store';
import { guardarYSubirFotoDePunto } from './guard-scan-photo-flow';
import { nuevoUuid } from './guard-storage';
import { sincronizarTareas, subirFotoDeTareaGuardada } from './guard-tareas-flujo';
import {
  responderTarea,
  tareaExigeFoto,
  tareasDelPuntoPorResponder,
  type EstadoTareas,
  type ItemTarea,
} from './guard-tareas-modelo';

/**
 * Las tareas del turno, EN EL PUNTO (#265).
 *
 * Aparece apenas el punto queda marcado —después de la foto obligatoria del
 * acceso, que es la evidencia que no se puede perder— y muestra solo las tareas
 * de ESE punto. Antes el checklist entero se pedía en el resumen, o sea después
 * del punto de cierre: para la tarea de las 11 en el refrigerador eso llega tres
 * pisos tarde.
 *
 * Dos reglas del producto que se ven acá tal como se decidieron:
 *
 * - **No bloquea la ronda.** El requisito es explícito: *"si la tarea queda
 *   fuera del horario de la ronda, que se envíe igual, se puede trabajar todo
 *   igual"*. Por eso hay un botón para seguir sin responder y la hora se muestra
 *   como referencia, no como veto. Cuánto se atrasó lo calcula el SERVIDOR, que
 *   es el único que conoce la zona del recinto y no le cree al reloj del
 *   teléfono.
 * - **La foto obligatoria se toma acá y ahora**, con la cámara en vivo y nunca
 *   desde la galería (si se pudiera elegir un archivo, el guardia fotografía el
 *   refrigerador una vez y reusa esa imagen todo el mes). El camino de la foto
 *   —marca de agua, almacén persistente antes de la red, subida colgada del
 *   escaneo— es el MISMO que el de la foto del acceso: se reusa
 *   `guardarYSubirFotoDePunto`, con sus pruebas y su arreglo de la carrera del
 *   veredicto. Lo único propio es la clave de la foto, que no puede ser la del
 *   escaneo: esa ya la ocupa la foto del punto y se pisarían.
 */

interface Borrador {
  value: string;
  notes?: string;
  archivo?: File;
  nombreArchivo?: string;
}

export function GuardTareasPunto({
  apiUrl,
  nombrePunto,
  checkpointId,
  clientScanId,
  scanId,
  items,
  estado,
  foto,
  idDelEscaneo,
  onEstado,
  onListo,
}: {
  apiUrl: string;
  nombrePunto: string;
  checkpointId: string;
  /** Escaneo con el que se marcó el punto: la foto de la tarea cuelga de él. */
  clientScanId: string;
  /** Id del escaneo en el servidor, si ya lo devolvió. */
  scanId?: string;
  /** La plantilla completa; acá se filtran las de este punto. */
  items: readonly ItemTarea[];
  estado: EstadoTareas;
  /** Lo que necesita la marca de agua y la compresión, igual que la del punto. */
  foto: { sitio: string; ruta: string; zonaHoraria?: string; objetivoBytes?: number };
  /** El id del escaneo LEÍDO AHORA: puede haber llegado mientras se responde. */
  idDelEscaneo: () => string | undefined;
  onEstado: (estado: EstadoTareas) => void;
  onListo: () => void;
}) {
  const [borradores, setBorradores] = useState<Record<string, Borrador>>({});
  const [guardando, setGuardando] = useState<string>();
  const [aviso, setAviso] = useState<string>();

  const pendientes = tareasDelPuntoPorResponder(items, estado, checkpointId);
  if (!pendientes.length) return null;

  function anotar(itemId: string, cambio: Partial<Borrador>) {
    setBorradores((actual) => ({
      ...actual,
      [itemId]: { value: '', ...actual[itemId], ...cambio },
    }));
  }

  async function guardar(item: ItemTarea) {
    const borrador = borradores[item.id] ?? { value: '' };
    const valor = borrador.value.trim();
    if (!valor) {
      setAviso('Responde la tarea antes de guardarla.');
      return;
    }
    if (tareaExigeFoto(item, valor) && !borrador.archivo) {
      setAviso('Esta tarea exige foto: tómala antes de guardarla.');
      return;
    }

    setGuardando(item.id);
    setAviso(undefined);

    let clientPhotoId: string | undefined;
    let photoId: string | undefined;
    let avisoFoto: string | undefined;

    if (borrador.archivo) {
      // Clave PROPIA para la foto de la tarea. El almacén indexa por esta clave
      // y la del escaneo ya la usa la foto del acceso: compartirla borraría una
      // de las dos evidencias sin decir nada.
      clientPhotoId = nuevoUuid();
      const desenlace = await guardarYSubirFotoDePunto(
        {
          checkpointId,
          nombre: `${nombrePunto} · ${item.label}`,
          clientScanId: clientPhotoId,
          ...(scanId ? { scanId } : {}),
        },
        borrador.archivo,
        new Date().toISOString(),
        {
          procesar: (entrada) =>
            procesarFoto(entrada, {
              sitio: foto.sitio,
              ruta: foto.ruta,
              ...(foto.zonaHoraria ? { zonaHoraria: foto.zonaHoraria } : {}),
              ...(foto.objetivoBytes ? { objetivoBytes: foto.objetivoBytes } : {}),
            }),
          guardar: (clave, imagen, cuando, id) => guardarFoto(clave, imagen, cuando, id, 'escaneo'),
          fijarId: fijarServerId,
          subir: async (clave, idEscaneo) => {
            const subida = await subirFotoDeTareaGuardada(apiUrl, clave, idEscaneo);
            photoId = subida.photoId;
            return subida.ok;
          },
          // Se ignora la clave que llega —esa es la de la FOTO— y se resuelve la
          // del escaneo del punto, que es de donde cuelga. Releerla acá y no al
          // abrir el panel es lo que evita que una foto tomada sin señal se
          // quede esperando un veredicto que ya pasó.
          idDelEscaneo: () => scanId ?? idDelEscaneo(),
        },
      );
      if (desenlace.clase !== 'subida' || desenlace.subida === false) {
        avisoFoto =
          'La foto quedó guardada en el teléfono y se envía sola. La tarea sale con ella.';
      }
    }

    const siguiente = responderTarea(estado, {
      item,
      value: valor,
      ...(borrador.notes ? { notes: borrador.notes } : {}),
      // Hora del teléfono: queda en la cola local. Cuánto se atrasó lo decide el
      // servidor con la zona del recinto.
      respondidaAt: new Date().toISOString(),
      clientScanId,
      ...(clientPhotoId ? { clientPhotoId } : {}),
      ...(photoId ? { photoId } : {}),
    });

    // Se manda al tiro si hay señal; si no, queda en la cola del teléfono y sale
    // sola después. Ninguna de las dos ramas bloquea al guardia.
    onEstado(await sincronizarTareas(apiUrl, siguiente));
    setGuardando(undefined);
    setAviso(avisoFoto ?? `Tarea "${item.label}" registrada.`);
  }

  return (
    <section className="guardia-tareas-punto" aria-labelledby="guardia-tareas-titulo">
      <h2 id="guardia-tareas-titulo">Tareas de este punto</h2>
      <p className="guardia-nota">
        <strong>{nombrePunto}</strong> tiene {pendientes.length === 1 ? 'una tarea' : `${pendientes.length} tareas`} del
        turno. Si respondes fuera de la hora pedida se envía igual y queda mencionado en el informe.
      </p>

      {pendientes.map((item) => (
        <Tarea
          key={item.id}
          item={item}
          borrador={borradores[item.id]}
          guardando={guardando === item.id}
          onAnotar={(cambio) => anotar(item.id, cambio)}
          onGuardar={() => void guardar(item)}
        />
      ))}

      {aviso ? (
        <p className="guardia-anuncio" role="status" aria-live="polite">
          {aviso}
        </p>
      ) : null}

      <button className="guardia-boton-texto" onClick={onListo} type="button">
        Seguir con la ronda
      </button>
      <p className="guardia-nota">
        Lo que dejes sin responder queda como tarea pendiente del turno y tu supervisor lo ve en el
        informe.
      </p>
    </section>
  );
}

function Tarea({
  item,
  borrador,
  guardando,
  onAnotar,
  onGuardar,
}: {
  item: ItemTarea;
  borrador: Borrador | undefined;
  guardando: boolean;
  onAnotar: (cambio: Partial<Borrador>) => void;
  onGuardar: () => void;
}) {
  const valor = borrador?.value ?? '';
  const esFalla = item.responseType === 'ok_falla' && valor === 'falla';
  const exigeFoto = tareaExigeFoto(item, valor);
  const campo = `tarea-${item.id}`;

  return (
    <div className="guardia-tarea">
      <p className="guardia-tarea-label" id={campo}>
        {item.label}
      </p>
      <span className="guardia-tarea-marcas">
        {item.dueLocalTime ? (
          <span className="guardia-chip hora">Toca a las {item.dueLocalTime.slice(0, 5)}</span>
        ) : null}
        {item.requiresPhoto ? <span className="guardia-chip foto">Exige foto</span> : null}
      </span>

      {item.responseType === 'ok_falla' ? (
        <div className="guardia-ok-falla" role="group" aria-labelledby={campo}>
          <button
            className={`guardia-boton-opcion${valor === 'ok' ? ' elegida' : ''}`}
            onClick={() => onAnotar({ value: 'ok' })}
            type="button"
          >
            OK
          </button>
          <button
            className={`guardia-boton-opcion falla${esFalla ? ' elegida' : ''}`}
            onClick={() => onAnotar({ value: 'falla' })}
            type="button"
          >
            Falla
          </button>
        </div>
      ) : (
        <input
          aria-labelledby={campo}
          className="guardia-entrada"
          inputMode={item.responseType === 'numero' ? 'decimal' : 'text'}
          maxLength={500}
          onChange={(evento) => onAnotar({ value: evento.target.value })}
          type="text"
          value={valor}
        />
      )}

      {esFalla ? (
        <textarea
          aria-label={`Observación de ${item.label}`}
          className="guardia-texto"
          maxLength={500}
          onChange={(evento) => onAnotar({ notes: evento.target.value })}
          placeholder="Qué observaste"
          rows={2}
          value={borrador?.notes ?? ''}
        />
      ) : null}

      {exigeFoto ? (
        <div className="guardia-foto">
          {/* Solo cámara: `capture="environment"` abre la cámara y no el selector
              de archivos. Es la misma regla que la foto del acceso y por la misma
              razón — desde la galería, una foto vieja pasa por evidencia nueva. */}
          <label className="guardia-boton-secundario ancho" htmlFor={`${campo}-foto`}>
            {borrador?.nombreArchivo ? 'Repetir foto' : 'Tomar foto'}
          </label>
          <input
            accept="image/*"
            capture="environment"
            className="guardia-invisible"
            disabled={guardando}
            id={`${campo}-foto`}
            onChange={(evento) => {
              const archivo = evento.target.files?.[0];
              if (!archivo) return;
              onAnotar({ archivo, nombreArchivo: archivo.name });
              evento.target.value = '';
            }}
            type="file"
          />
          {borrador?.archivo ? <p className="guardia-nota">Foto lista para enviar.</p> : null}
        </div>
      ) : null}

      <button
        className="guardia-boton-primario ancho"
        disabled={guardando || !valor.trim() || (exigeFoto && !borrador?.archivo)}
        onClick={onGuardar}
        type="button"
      >
        {guardando ? 'Guardando…' : 'Guardar tarea'}
      </button>
    </div>
  );
}
