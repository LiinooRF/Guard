'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  borradorDesdeApi,
  cuerpoDePlantilla,
  fueraDelTurno,
  mensajeDeRespuesta,
  resumenDeTarea,
  revisarBorrador,
  tareaVacia,
  TIPOS_DE_RESPUESTA,
  type PlantillaDeLaApi,
  type RecintoDelEditor,
  type TareaBorrador,
  type TipoRespuesta,
} from './tareas-turno-modelo';

/**
 * Editor de tareas del turno, panel del SUPERVISOR (#265).
 *
 * Lo que arma: "ir A LAS 11, a CIERTO PUNTO, y tomar una IMAGEN al
 * refrigerador". Cada tarea lleva texto, tipo de respuesta, punto opcional, hora
 * opcional y si exige foto.
 *
 * Tres decisiones de pantalla que no son obvias:
 *
 * 1. **El catalogo viene de `/checklists/supervisor/sites`**, no de
 *    `/supervisor/route-editor/sites`: ese ultimo no trae `timezone`, y una hora
 *    sin zona no significa nada. Ademas exigiria `routes:manage`, que es el
 *    permiso de otra pantalla.
 * 2. **Editar una plantilla ya respondida no se intenta a ciegas.** El servidor
 *    responde 409 y aca se traduce a lo que hay que hacer —desactivar y crear
 *    otra— en vez de mostrar el error crudo. Cambiar "11:00" por "12:00" en una
 *    plantilla que una ronda ya contesto no es editar: es otra plantilla.
 * 3. **Fuera de horario es aviso amarillo, no bloqueo.** El producto pide que la
 *    tarea se pueda enviar igual y que se mencione. Ver el modelo puro.
 *
 * Ocultar el editor no seria control de acceso: el alcance por recinto lo
 * verifica el servidor en cada llamada (`supervisor_sites`). Esta pantalla solo
 * evita pedir lo que se sabe que va a dar 403.
 */

interface Estado {
  readonly texto: string;
  readonly tono: 'ok' | 'aviso';
}

export function TareasTurnoEditor({ apiUrl }: { apiUrl: string }) {
  const [recintos, setRecintos] = useState<RecintoDelEditor[]>([]);
  const [cargando, setCargando] = useState(true);
  const [siteId, setSiteId] = useState('');
  const [plantillas, setPlantillas] = useState<PlantillaDeLaApi[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [nombre, setNombre] = useState('');
  const [turnoId, setTurnoId] = useState('');
  const [tareas, setTareas] = useState<TareaBorrador[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [estado, setEstado] = useState<Estado | null>(null);

  const recinto = recintos.find((item) => item.id === siteId) ?? null;
  const turno = recinto?.shifts.find((item) => item.id === turnoId) ?? null;
  const plantilla = plantillas.find((item) => item.id === templateId) ?? null;
  const revision = useMemo(
    () => revisarBorrador(nombre, tareas, { recinto, turno }),
    [nombre, tareas, recinto, turno],
  );

  useEffect(() => {
    let vivo = true;
    void fetch(`${apiUrl}/checklists/supervisor/sites`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (respuesta) => {
        if (!respuesta.ok) throw new Error();
        const datos = (await respuesta.json()) as RecintoDelEditor[];
        if (!vivo) return;
        setRecintos(datos);
        setSiteId(datos[0]?.id ?? '');
      })
      .catch(() => {
        if (vivo) setEstado({ texto: 'No pudimos cargar tus recintos.', tono: 'aviso' });
      })
      .finally(() => {
        if (vivo) setCargando(false);
      });
    return () => {
      vivo = false;
    };
  }, [apiUrl]);

  useEffect(() => {
    if (!siteId) return;
    let vivo = true;
    nuevaPlantilla();
    void fetch(`${apiUrl}/checklists/supervisor/sites/${siteId}/templates`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (respuesta) => {
        if (!respuesta.ok) throw new Error();
        if (vivo) setPlantillas((await respuesta.json()) as PlantillaDeLaApi[]);
      })
      .catch(() => {
        if (vivo) {
          setEstado({ texto: 'No pudimos cargar las tareas del recinto.', tono: 'aviso' });
        }
      });
    return () => {
      vivo = false;
    };
  }, [apiUrl, siteId]);

  function nuevaPlantilla() {
    setTemplateId('');
    setNombre('');
    setTurnoId('');
    setTareas([]);
    setEstado(null);
  }

  function elegirPlantilla(id: string) {
    setEstado(null);
    setTemplateId(id);
    const elegida = plantillas.find((item) => item.id === id);
    if (!elegida) {
      nuevaPlantilla();
      return;
    }
    setNombre(elegida.name);
    setTurnoId(elegida.shiftId ?? '');
    setTareas(elegida.items.map(borradorDesdeApi));
  }

  function agregarTarea() {
    setTareas((actuales) => [...actuales, tareaVacia(`nueva-${Date.now()}-${actuales.length}`)]);
  }

  function cambiarTarea(clave: string, cambio: Partial<TareaBorrador>) {
    setTareas((actuales) =>
      actuales.map((tarea) => (tarea.clave === clave ? { ...tarea, ...cambio } : tarea)),
    );
  }

  function quitarTarea(clave: string) {
    setTareas((actuales) => actuales.filter((tarea) => tarea.clave !== clave));
  }

  function mover(clave: string, destino: number) {
    setTareas((actuales) => {
      const desde = actuales.findIndex((tarea) => tarea.clave === clave);
      if (desde < 0 || destino < 0 || destino >= actuales.length) return actuales;
      const siguiente = [...actuales];
      const [tarea] = siguiente.splice(desde, 1);
      siguiente.splice(destino, 0, tarea!);
      return siguiente;
    });
  }

  async function guardar() {
    if (!recinto || revision.errores.length) {
      setEstado({ texto: 'Corrige lo marcado antes de guardar.', tono: 'aviso' });
      return;
    }
    setGuardando(true);
    setEstado(null);
    // Al editar NO se manda el alcance: el servidor no lo acepta y el recinto de
    // una plantilla no se mueve. Solo el nombre y las tareas.
    const cuerpo = cuerpoDePlantilla(nombre, tareas, templateId ? null : turnoId || null);
    if (templateId) delete cuerpo.shiftId;
    try {
      const respuesta = await fetch(
        templateId
          ? `${apiUrl}/checklists/supervisor/templates/${templateId}`
          : `${apiUrl}/checklists/supervisor/sites/${recinto.id}/templates`,
        {
          method: templateId ? 'PUT' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cuerpo),
        },
      );
      if (!respuesta.ok) {
        setEstado({ texto: mensajeDeRespuesta(respuesta.status), tono: 'aviso' });
        return;
      }
      setEstado({
        texto: templateId ? 'Tareas actualizadas.' : 'Tareas guardadas para este recinto.',
        tono: 'ok',
      });
      await recargar();
    } catch {
      setEstado({ texto: mensajeDeRespuesta(0), tono: 'aviso' });
    } finally {
      setGuardando(false);
    }
  }

  async function cambiarVigencia(isActive: boolean) {
    if (!templateId) return;
    setGuardando(true);
    try {
      const respuesta = await fetch(
        `${apiUrl}/checklists/supervisor/templates/${templateId}/active`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ isActive }),
        },
      );
      if (!respuesta.ok) {
        setEstado({ texto: mensajeDeRespuesta(respuesta.status), tono: 'aviso' });
        return;
      }
      setEstado({
        texto: isActive ? 'Plantilla vigente otra vez.' : 'Plantilla desactivada.',
        tono: 'ok',
      });
      await recargar();
    } catch {
      setEstado({ texto: mensajeDeRespuesta(0), tono: 'aviso' });
    } finally {
      setGuardando(false);
    }
  }

  async function recargar() {
    const respuesta = await fetch(
      `${apiUrl}/checklists/supervisor/sites/${siteId}/templates`,
      { credentials: 'include', cache: 'no-store' },
    );
    if (respuesta.ok) setPlantillas((await respuesta.json()) as PlantillaDeLaApi[]);
  }

  if (cargando) return null;

  return (
    <section className="activity-card tareas-turno" id="editor-tareas">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Tareas del turno</span>
          <h2>Qué tiene que hacer el guardia</h2>
        </div>
        <span className="status-pill">{tareas.length} tareas</span>
      </div>

      {!recintos.length ? (
        <div className="dashboard-empty">
          <strong>Sin recintos asignados</strong>
          <span>Un administrador debe asignarte al menos un recinto.</span>
        </div>
      ) : (
        <>
          <div className="tareas-turno-toolbar">
            <label>
              Recinto
              <select value={siteId} onChange={(evento) => setSiteId(evento.target.value)}>
                {recintos.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.branchName} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Plantilla
              <select
                value={templateId}
                onChange={(evento) => elegirPlantilla(evento.target.value)}
              >
                <option value="">Nueva plantilla</option>
                {plantillas.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.isActive ? '' : ' (inactiva)'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Nombre
              <input
                maxLength={120}
                onChange={(evento) => setNombre(evento.target.value)}
                placeholder="Tareas del turno de noche"
                value={nombre}
              />
            </label>
            <label>
              Turno
              <select
                disabled={Boolean(templateId)}
                onChange={(evento) => setTurnoId(evento.target.value)}
                value={turnoId}
              >
                <option value="">Cualquier turno</option>
                {(recinto?.shifts ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.startsAt}–{item.endsAt})
                  </option>
                ))}
              </select>
            </label>
          </div>

          {recinto ? (
            <p className="tareas-turno-zona">
              Las horas son locales de <strong>{recinto.name}</strong> ({recinto.timezone}). No se
              convierten a la hora de tu computador.
            </p>
          ) : null}
          {templateId ? (
            <p className="stats-estado">
              El recinto y el turno de una plantilla guardada no se cambian. Para moverla,
              desactívala y crea una nueva.
            </p>
          ) : null}

          <ol className="tareas-turno-lista">
            {tareas.map((tarea, indice) => (
              <li key={tarea.clave}>
                <div className="tareas-turno-fila">
                  <b>{indice + 1}</b>
                  <label className="tareas-turno-texto">
                    Qué hay que hacer
                    <input
                      maxLength={200}
                      onChange={(evento) => cambiarTarea(tarea.clave, { label: evento.target.value })}
                      placeholder="Fotografiar el refrigerador"
                      value={tarea.label}
                    />
                  </label>
                  <label>
                    Respuesta
                    <select
                      onChange={(evento) =>
                        cambiarTarea(tarea.clave, {
                          responseType: evento.target.value as TipoRespuesta,
                        })
                      }
                      value={tarea.responseType}
                    >
                      {TIPOS_DE_RESPUESTA.map((tipo) => (
                        <option key={tipo.valor} value={tipo.valor}>
                          {tipo.etiqueta}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Punto de control
                    <select
                      onChange={(evento) =>
                        cambiarTarea(tarea.clave, { checkpointId: evento.target.value || null })
                      }
                      value={tarea.checkpointId ?? ''}
                    >
                      <option value="">En cualquier punto</option>
                      {(recinto?.checkpoints ?? []).map((punto) => (
                        <option key={punto.id} value={punto.id}>
                          {punto.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Hora
                    <input
                      onChange={(evento) =>
                        cambiarTarea(tarea.clave, { dueLocalTime: evento.target.value || null })
                      }
                      step={60}
                      type="time"
                      value={tarea.dueLocalTime ?? ''}
                    />
                  </label>
                  <div className="tareas-turno-botones">
                    <button
                      aria-label={`Subir tarea ${indice + 1}`}
                      disabled={!indice}
                      onClick={() => mover(tarea.clave, indice - 1)}
                      type="button"
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`Bajar tarea ${indice + 1}`}
                      disabled={indice === tareas.length - 1}
                      onClick={() => mover(tarea.clave, indice + 1)}
                      type="button"
                    >
                      ↓
                    </button>
                    <button
                      aria-label={`Quitar tarea ${indice + 1}`}
                      onClick={() => quitarTarea(tarea.clave)}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="tareas-turno-fotos">
                  <label>
                    <input
                      checked={tarea.requiresPhoto}
                      onChange={(evento) =>
                        cambiarTarea(tarea.clave, { requiresPhoto: evento.target.checked })
                      }
                      type="checkbox"
                    />{' '}
                    Foto siempre
                  </label>
                  <label>
                    <input
                      checked={tarea.requiresPhotoOnFail}
                      onChange={(evento) =>
                        cambiarTarea(tarea.clave, { requiresPhotoOnFail: evento.target.checked })
                      }
                      type="checkbox"
                    />{' '}
                    Foto solo si marca falla
                  </label>
                  <small>{resumenDeTarea(tarea, recinto?.checkpoints ?? [])}</small>
                  {fueraDelTurno(tarea.dueLocalTime, turno) ? (
                    <em className="tareas-turno-tarde">Fuera del horario del turno</em>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>

          <div className="tareas-turno-acciones">
            <button className="stats-boton" onClick={agregarTarea} type="button">
              + Agregar tarea
            </button>
            <button
              className="stats-boton"
              disabled={guardando || revision.errores.length > 0}
              onClick={() => void guardar()}
              type="button"
            >
              {guardando ? 'Guardando…' : templateId ? 'Actualizar tareas' : 'Guardar tareas'}
            </button>
            {plantilla ? (
              <button
                className="stats-boton"
                disabled={guardando}
                onClick={() => void cambiarVigencia(!plantilla.isActive)}
                type="button"
              >
                {plantilla.isActive ? 'Desactivar plantilla' : 'Reactivar plantilla'}
              </button>
            ) : null}
          </div>

          {revision.errores.map((error) => (
            <p className="stats-estado aviso" key={error} role="alert">
              {error}
            </p>
          ))}
          {revision.avisos.map((aviso) => (
            <p className="stats-estado" key={aviso}>
              {aviso}
            </p>
          ))}
          {estado ? (
            <p className={estado.tono === 'ok' ? 'stats-estado' : 'stats-estado aviso'} role="status">
              {estado.texto}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
