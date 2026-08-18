'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

import { CoordinateMap } from './coordinate-map';
import { marcasDePuntos } from './puntos-marcas';
import { avisoSinCoordenadas } from './site-gps-aviso';

interface RecintoAsignado {
  id: string;
  name: string;
  branchName?: string;
  address?: string;
}

interface Punto {
  id: string;
  name: string;
  description: string | null;
  suggestedOrder: number;
  kind: 'normal' | 'acceso_critico';
  latitude: number | null;
  longitude: number | null;
  requiresPhoto: boolean | null;
  instructions: string | null;
  isActive: boolean;
}

interface Etiqueta {
  id: string;
  tech: 'nfc' | 'qr';
  uid: string;
  active: boolean;
  installedAt: string;
  replacedAt: string | null;
}

type Coordenadas = [number | null, number | null];

/**
 * Puntos de control y etiquetas NFC para el SUPERVISOR (#309).
 *
 * Componente hermano de `SiteManagement` y no una version parametrizada de ese:
 * aquel monta ademas el alta y la baja de RECINTOS, el horario habil y los
 * feriados —todo `tenant:sites:manage`, del ADMIN— y para el supervisor esos
 * formularios tendrian que apagarse uno por uno. Un componente que se apaga por
 * rol es exactamente donde vuelve a encenderse el dia que alguien "arregla una
 * asimetria" de la interfaz.
 *
 * ATENCION, y no es una sugerencia: **que aca no haya control de foto ni de
 * criticidad al editar NO es lo que impide cambiarlos.** Lo impide el servidor:
 * `CrearPuntoSupervisorDto` no declara `requiresPhoto`, `EditarPuntoSupervisorDto`
 * no declara `kind`, y `forbidNonWhitelisted` los convierte en 400. Los dos
 * campos gobiernan `isPhotoRequired()`, o sea la evidencia fotografica de un
 * acceso critico. Si alguien los repone en este formulario, no va a "desbloquear"
 * nada: va a mostrar controles que el servidor rechaza. Y si ademas los agrega
 * al DTO, apaga la evidencia — que es lo que este recorte existe para evitar.
 *
 * Los recintos salen de `GET /supervisor/sites`, que ya devuelve SOLO los
 * asignados; `GET /admin/sites` no se puede usar y no es una limitacion de la
 * pantalla sino del permiso.
 */
export function PuntosSupervisor({
  apiUrl,
  mapTileUrl,
  mapAttribution,
}: {
  apiUrl: string;
  mapTileUrl: string | null;
  mapAttribution: string;
}) {
  const [recintos, setRecintos] = useState<RecintoAsignado[]>([]);
  const [seleccionado, setSeleccionado] = useState<string | null>(null);
  const [puntos, setPuntos] = useState<Punto[]>([]);
  const [etiquetas, setEtiquetas] = useState<Record<string, Etiqueta[]>>({});
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [coordenadas, setCoordenadas] = useState<Coordenadas>([null, null]);

  useEffect(() => {
    void (async () => {
      const respuesta = await fetch(`${apiUrl}/supervisor/sites`, opciones());
      if (!respuesta.ok) {
        setMensaje('No pudimos cargar tus recintos. Revisa tu sesión e intenta nuevamente.');
        setCargando(false);
        return;
      }
      const datos = (await respuesta.json()) as RecintoAsignado[];
      setRecintos(datos);
      setSeleccionado((actual) => actual ?? datos[0]?.id ?? null);
      setCargando(false);
    })();
  }, [apiUrl]);

  const cargarPuntos = useCallback(
    async (siteId: string) => {
      const respuesta = await fetch(
        `${apiUrl}/checkpoints/supervisor/sites/${siteId}/checkpoints`,
        opciones(),
      );
      if (!respuesta.ok) return setMensaje(await textoDeError(respuesta));
      setPuntos((await respuesta.json()) as Punto[]);
      setEtiquetas({});
    },
    [apiUrl],
  );

  useEffect(() => {
    if (seleccionado) void cargarPuntos(seleccionado);
  }, [seleccionado, cargarPuntos]);

  async function crearPunto(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!seleccionado) return;
    const form = evento.currentTarget;
    const datos = new FormData(form);
    if ((coordenadas[0] === null) !== (coordenadas[1] === null)) {
      return setMensaje('Completa latitud y longitud, o deja ambas vacías.');
    }
    const respuesta = await enviar(
      `${apiUrl}/checkpoints/supervisor/sites/${seleccionado}/checkpoints`,
      'POST',
      {
        name: datos.get('name'),
        description: datos.get('description') || undefined,
        kind: datos.get('kind'),
        suggestedOrder: Number(datos.get('suggestedOrder')),
        latitude: coordenadas[0] ?? undefined,
        longitude: coordenadas[1] ?? undefined,
        instructions: datos.get('instructions') || undefined,
        tagUid: datos.get('tagUid') || undefined,
      },
    );
    if (!respuesta.ok) return setMensaje(await textoDeError(respuesta));
    form.reset();
    setCoordenadas([null, null]);
    setMensaje('Punto creado. Queda registrado a tu nombre en la auditoría de la empresa.');
    await cargarPuntos(seleccionado);
  }

  async function editarPunto(evento: FormEvent<HTMLFormElement>, punto: Punto) {
    evento.preventDefault();
    const datos = new FormData(evento.currentTarget);
    const respuesta = await enviar(
      `${apiUrl}/checkpoints/supervisor/checkpoints/${punto.id}`,
      'PATCH',
      {
        name: datos.get('name'),
        description: datos.get('description') || '',
        suggestedOrder: Number(datos.get('suggestedOrder')),
        latitude: datos.get('latitude') ? Number(datos.get('latitude')) : undefined,
        longitude: datos.get('longitude') ? Number(datos.get('longitude')) : undefined,
        instructions: datos.get('instructions') || '',
      },
    );
    if (!respuesta.ok) return setMensaje(await textoDeError(respuesta));
    setMensaje('Punto actualizado.');
    if (seleccionado) await cargarPuntos(seleccionado);
  }

  async function alternarPunto(punto: Punto) {
    const respuesta = await enviar(
      `${apiUrl}/checkpoints/supervisor/checkpoints/${punto.id}/active`,
      'PATCH',
      { isActive: !punto.isActive },
    );
    if (!respuesta.ok) return setMensaje(await textoDeError(respuesta));
    setMensaje(
      punto.isActive
        ? 'Punto dado de baja: deja de contar para el cumplimiento de las rondas.'
        : 'Punto reactivado.',
    );
    if (seleccionado) await cargarPuntos(seleccionado);
  }

  async function verEtiquetas(punto: Punto) {
    const respuesta = await fetch(
      `${apiUrl}/checkpoints/supervisor/checkpoints/${punto.id}/tags`,
      opciones(),
    );
    if (!respuesta.ok) return setMensaje(await textoDeError(respuesta));
    const lista = (await respuesta.json()) as Etiqueta[];
    setEtiquetas((actual) => ({ ...actual, [punto.id]: lista }));
  }

  async function vincularEtiqueta(evento: FormEvent<HTMLFormElement>, punto: Punto) {
    evento.preventDefault();
    const form = evento.currentTarget;
    const uid = new FormData(form).get('uid');
    const respuesta = await enviar(
      `${apiUrl}/checkpoints/supervisor/checkpoints/${punto.id}/tags`,
      'POST',
      { uid, tech: 'nfc' },
    );
    if (!respuesta.ok) return setMensaje(await textoDeError(respuesta));
    form.reset();
    setMensaje(
      `Etiqueta vinculada a ${punto.name}. Si reemplazó a otra, el cambio queda anotado con tu nombre.`,
    );
    await verEtiquetas(punto);
  }

  async function retirarEtiqueta(punto: Punto, etiqueta: Etiqueta) {
    const respuesta = await enviar(
      `${apiUrl}/checkpoints/supervisor/tags/${etiqueta.id}`,
      'DELETE',
    );
    if (!respuesta.ok) return setMensaje(await textoDeError(respuesta));
    setMensaje('Etiqueta retirada.');
    await verEtiquetas(punto);
  }

  if (cargando) return <p className="dashboard-empty">Cargando tus recintos…</p>;

  if (!recintos.length) {
    return (
      <section className="activity-card">
        <div className="card-heading">
          <div><span className="eyebrow">Terreno</span><h2>Puntos y etiquetas</h2></div>
        </div>
        <div className="dashboard-empty">
          <strong>No tienes recintos asignados</strong>
          <span>Solicita a un administrador de tu empresa que te asigne al menos uno.</span>
        </div>
      </section>
    );
  }

  const recinto = recintos.find((sitio) => sitio.id === seleccionado) ?? null;

  return (
    <section className="sites-management" id="terreno">
      {mensaje ? <p className="management-message sticky-message" role="status">{mensaje}</p> : null}
      <div className="card-heading">
        <div><span className="eyebrow">Terreno</span><h2>Puntos de control y etiquetas</h2></div>
        <span className="status-pill">{recintos.length} recintos asignados</span>
      </div>

      <section className="management-card management-wide">
        <div className="card-heading">
          <div><span className="eyebrow">Recinto</span><h3>Dónde estás trabajando</h3></div>
        </div>
        <label>
          Recinto
          <select
            value={seleccionado ?? ''}
            onChange={(evento) => setSeleccionado(evento.target.value)}
          >
            {recintos.map((sitio) => (
              <option key={sitio.id} value={sitio.id}>
                {sitio.branchName ? `${sitio.branchName} · ` : ''}{sitio.name}
              </option>
            ))}
          </select>
        </label>
        <p className="form-note">
          Solo aparecen los recintos que tienes asignados. Los recintos, sus horarios y la
          exigencia de foto los administra el administrador de la empresa.
        </p>
      </section>

      {recinto ? (
        <>
          <div className="management-grid checkpoint-create-grid">
            <section className="management-card">
              <div className="card-heading">
                <div><span className="eyebrow">Puntos</span><h3>Nuevo punto en {recinto.name}</h3></div>
              </div>
              <form className="management-form" onSubmit={crearPunto}>
                <label>Nombre<input name="name" required minLength={2} maxLength={120} /></label>
                <label>Descripción<input name="description" maxLength={300} /></label>
                <label>
                  Criticidad
                  <select name="kind" defaultValue="normal">
                    <option value="normal">Normal</option>
                    <option value="acceso_critico">Acceso crítico</option>
                  </select>
                </label>
                <label>
                  Orden sugerido
                  <input name="suggestedOrder" type="number" min={0} defaultValue={puntos.length + 1} required />
                </label>
                <label>Instrucciones<textarea name="instructions" rows={2} maxLength={500} /></label>
                <label>UID etiqueta NFC<input name="tagUid" minLength={4} maxLength={64} placeholder="Opcional: vincula en el alta" /></label>
                <div className="coordinate-fields">
                  <label>Latitud<input type="number" step="0.000001" min={-90} max={90} value={coordenadas[0] ?? ''} onChange={(e) => setCoordenadas([e.target.value === '' ? null : Number(e.target.value), coordenadas[1]])} /></label>
                  <label>Longitud<input type="number" step="0.000001" min={-180} max={180} value={coordenadas[1] ?? ''} onChange={(e) => setCoordenadas([coordenadas[0], e.target.value === '' ? null : Number(e.target.value)])} /></label>
                </div>
                <p className="form-note">
                  La exigencia de foto la resuelven las reglas de la empresa: un acceso crítico
                  la hereda. El detalle por punto lo cambia el administrador.
                </p>
                <button className="primary-button">Crear punto</button>
              </form>
            </section>
            <CoordinateMap
              latitude={coordenadas[0]}
              longitude={coordenadas[1]}
              tileUrl={mapTileUrl}
              attribution={mapAttribution}
              onPick={(lat, lng) => setCoordenadas([redondear(lat), redondear(lng)])}
              markers={marcasDePuntos(puntos)}
            />
          </div>

          <section className="management-card management-wide">
            <div className="card-heading">
              <div><span className="eyebrow">Inventario</span><h3>Puntos de {recinto.name}</h3></div>
              <span className="status-pill">{puntos.length}</span>
            </div>
            {avisoSinCoordenadas(puntos) ? (
              <p className="form-note" role="alert">{avisoSinCoordenadas(puntos)}</p>
            ) : null}
            <div className="checkpoint-admin-list">
              {puntos.map((punto) => (
                <details key={punto.id} onToggle={() => { if (!etiquetas[punto.id]) void verEtiquetas(punto); }}>
                  <summary>
                    <span>
                      <strong>{punto.suggestedOrder}. {punto.name}</strong>
                      <small>
                        {punto.kind === 'acceso_critico' ? 'Acceso crítico' : 'Normal'} ·{' '}
                        {punto.latitude === null ? 'Sin ubicación' : `${punto.latitude}, ${punto.longitude}`}
                      </small>
                    </span>
                    <span className={`state-chip ${punto.isActive ? 'active' : 'suspended'}`}>
                      {punto.isActive ? 'Activo' : 'Inactivo'}
                    </span>
                  </summary>
                  <form className="management-form checkpoint-edit-form" onSubmit={(evento) => editarPunto(evento, punto)}>
                    <label>Nombre<input name="name" defaultValue={punto.name} required /></label>
                    <label>Descripción<input name="description" defaultValue={punto.description ?? ''} /></label>
                    <label>Orden<input name="suggestedOrder" type="number" min={0} defaultValue={punto.suggestedOrder} /></label>
                    <label>Latitud<input name="latitude" type="number" step="0.000001" defaultValue={punto.latitude ?? ''} /></label>
                    <label>Longitud<input name="longitude" type="number" step="0.000001" defaultValue={punto.longitude ?? ''} /></label>
                    <label>Instrucciones<input name="instructions" defaultValue={punto.instructions ?? ''} /></label>
                    <div className="row-actions">
                      <button className="primary-button">Guardar punto</button>
                      <button className="secondary-button" type="button" onClick={() => void alternarPunto(punto)}>
                        {punto.isActive ? 'Dar de baja' : 'Reactivar'}
                      </button>
                    </div>
                  </form>

                  <div className="tag-list">
                    {(etiquetas[punto.id] ?? []).filter((etiqueta) => etiqueta.active).map((etiqueta) => (
                      <div className="management-row" key={etiqueta.id}>
                        <div><strong>{etiqueta.uid}</strong><small>{etiqueta.tech.toUpperCase()}</small></div>
                        <button className="secondary-button" type="button" onClick={() => void retirarEtiqueta(punto, etiqueta)}>
                          Retirar
                        </button>
                      </div>
                    ))}
                  </div>
                  <form className="tag-bind-form" onSubmit={(evento) => vincularEtiqueta(evento, punto)}>
                    <label>
                      Vincular/reemplazar NFC
                      <input name="uid" required minLength={4} maxLength={64} placeholder="UID leído por el instalador" />
                    </label>
                    <button className="secondary-button">Vincular etiqueta</button>
                  </form>
                </details>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}

function opciones(): RequestInit {
  return { credentials: 'include', cache: 'no-store' };
}

function enviar(url: string, method: string, body?: object) {
  return fetch(url, {
    method,
    credentials: 'include',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

function redondear(valor: number) {
  return Math.round(valor * 1_000_000) / 1_000_000;
}


async function textoDeError(respuesta: Response) {
  if (respuesta.status === 403) {
    return 'Ese recinto no está entre los que tienes asignados.';
  }
  try {
    const datos = (await respuesta.json()) as { message?: string | string[] };
    return Array.isArray(datos.message)
      ? datos.message.join('. ')
      : datos.message ?? 'No fue posible completar la operación.';
  } catch {
    return 'No fue posible completar la operación.';
  }
}
