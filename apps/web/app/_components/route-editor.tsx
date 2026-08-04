'use client';

import { useEffect, useMemo, useState } from 'react';

import { estimatedRouteMinutes, routeDistanceMeters } from './route-editor-math';
import { RouteMap } from './route-map';

export interface RouteEditorCheckpoint {
  id: string; name: string; latitude: number | null; longitude: number | null;
  requiresPhoto: boolean | null; suggestedOrder: number;
}
export interface RouteEditorSite {
  id: string; name: string; branchName: string; address: string;
  latitude: number | null; longitude: number | null; checkpoints: RouteEditorCheckpoint[];
}
interface RouteTemplate {
  id: string; name: string; estimatedDurationMin: number; toleranceMin: number; version: number;
  orderMode: 'fijo' | 'aleatorio' | 'aleatorio_con_anclas';
  checkpoints: Array<RouteEditorCheckpoint & { isClosingPoint: boolean; isAnchor: boolean }>;
}
interface SelectedPoint extends RouteEditorCheckpoint { isClosingPoint: boolean; isAnchor: boolean }

export function RouteEditor({ sites, apiUrl, mapTileUrl, mapAttribution }: {
  sites: RouteEditorSite[]; apiUrl: string; mapTileUrl: string | null; mapAttribution: string;
}) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [templates, setTemplates] = useState<RouteTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [points, setPoints] = useState<SelectedPoint[]>([]);
  const [duration, setDuration] = useState(1);
  const [durationEdited, setDurationEdited] = useState(false);
  const [tolerance, setTolerance] = useState(15);
  const [orderMode, setOrderMode] = useState<RouteTemplate['orderMode']>('fijo');
  const [dragged, setDragged] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const site = sites.find((item) => item.id === siteId) ?? null;
  const distance = useMemo(() => routeDistanceMeters(points), [points]);
  const suggestion = estimatedRouteMinutes(distance, points.length);

  useEffect(() => {
    if (!siteId) return;
    let alive = true;
    setTemplateId(''); setPoints([]); setName(''); setStatus(null);
    void fetch(`${apiUrl}/supervisor/sites/${siteId}/routes`, {
      credentials: 'include', cache: 'no-store',
    }).then(async (response) => {
      if (!response.ok) throw new Error();
      if (alive) setTemplates((await response.json()) as RouteTemplate[]);
    }).catch(() => { if (alive) setStatus('No pudimos cargar las plantillas del recinto.'); });
    return () => { alive = false; };
  }, [apiUrl, siteId]);

  useEffect(() => { if (!durationEdited) setDuration(suggestion); }, [durationEdited, suggestion]);

  function selectTemplate(id: string) {
    setTemplateId(id);
    const template = templates.find((item) => item.id === id);
    if (!template) {
      setName(''); setPoints([]); setDurationEdited(false); setTolerance(15); setOrderMode('fijo');
      return;
    }
    setName(template.name); setPoints(template.checkpoints); setDuration(template.estimatedDurationMin);
    setDurationEdited(true); setTolerance(template.toleranceMin); setOrderMode(template.orderMode);
  }

  function addPoint(checkpoint: RouteEditorCheckpoint) {
    if (points.some((point) => point.id === checkpoint.id)) return;
    setPoints((current) => [...current, { ...checkpoint, isAnchor: false, isClosingPoint: current.length === 0 }]
      .map((point, index, all) => ({ ...point, isClosingPoint: index === all.length - 1 })));
  }

  function removePoint(id: string) {
    setPoints((current) => current.filter((point) => point.id !== id)
      .map((point, index, all) => ({ ...point, isClosingPoint: index === all.length - 1 })));
  }

  function move(id: string, targetIndex: number) {
    setPoints((current) => {
      const from = current.findIndex((point) => point.id === id);
      if (from < 0 || targetIndex < 0 || targetIndex >= current.length || from === targetIndex) return current;
      const next = [...current]; const [point] = next.splice(from, 1); next.splice(targetIndex, 0, point!);
      return closingLast(next);
    });
  }

  function markClosing(id: string) {
    setPoints((current) => closingLast(current.map((point) => ({
      ...point, isClosingPoint: point.id === id,
    }))));
  }

  async function save() {
    if (!site || name.trim().length < 2 || points.length < 2) {
      setStatus('La plantilla necesita nombre y al menos dos puntos.'); return;
    }
    setSaving(true); setStatus(null);
    const body = {
      name: name.trim(), estimatedDurationMin: duration, toleranceMin: tolerance, orderMode,
      checkpoints: points.map((point) => ({ checkpointId: point.id,
        isClosingPoint: point.isClosingPoint, isAnchor: point.isAnchor,
        ...(point.requiresPhoto === null ? {} : { requiresPhoto: point.requiresPhoto }) })),
    };
    try {
      const response = await fetch(templateId
        ? `${apiUrl}/supervisor/routes/${templateId}`
        : `${apiUrl}/supervisor/sites/${site.id}/routes`, {
        method: templateId ? 'PUT' : 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error();
      setStatus(templateId ? 'Plantilla actualizada.' : 'Plantilla guardada y lista para reutilizar.');
      const refreshed = await fetch(`${apiUrl}/supervisor/sites/${site.id}/routes`, {
        credentials: 'include', cache: 'no-store',
      });
      if (refreshed.ok) setTemplates((await refreshed.json()) as RouteTemplate[]);
    } catch { setStatus('No pudimos guardar la plantilla. Revisa los datos e intenta nuevamente.'); }
    finally { setSaving(false); }
  }

  const available = site?.checkpoints.filter((checkpoint) => !points.some((point) => point.id === checkpoint.id)) ?? [];
  const missingCoordinates = points.filter((point) => point.latitude === null || point.longitude === null).length;
  return <section className="activity-card route-editor" id="editor-rutas">
    <div className="card-heading"><div><span className="eyebrow">Planificación visual</span><h2>Editor de rutas</h2></div><span className="status-pill">{points.length} puntos</span></div>
    <div className="route-editor-toolbar">
      <label>Recinto<select value={siteId} onChange={(event) => setSiteId(event.target.value)}>
        {sites.map((item) => <option value={item.id} key={item.id}>{item.branchName} · {item.name}</option>)}
      </select></label>
      <label>Plantilla<select value={templateId} onChange={(event) => selectTemplate(event.target.value)}>
        <option value="">Nueva plantilla</option>{templates.map((item) => <option value={item.id} key={item.id}>{item.name} · v{item.version}</option>)}
      </select></label>
      <label>Nombre<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Ronda perimetral" /></label>
    </div>
    {!sites.length ? <div className="dashboard-empty"><strong>Sin recintos asignados</strong><span>Un administrador debe asignarte al menos un recinto.</span></div> : <>
      <RouteMap points={points} siteCenter={site?.latitude !== null && site?.longitude !== null && site
        ? [site.latitude!, site.longitude!] : null} tileUrl={mapTileUrl} attribution={mapAttribution} />
      <div className="route-editor-metrics"><strong>{distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${distance} m`}</strong><span>Distancia trazada</span><strong>{suggestion} min</strong><span>Tiempo sugerido</span></div>
      {missingCoordinates ? <p className="stats-estado aviso">{missingCoordinates} punto(s) no tienen coordenadas; esos tramos no entran en la distancia.</p> : null}
      <div className="route-editor-columns">
        <div><h3>Puntos disponibles</h3><div className="route-available">{available.map((checkpoint) =>
          <button type="button" key={checkpoint.id} onClick={() => addPoint(checkpoint)}>+ {checkpoint.name}</button>)}</div></div>
        <div><h3>Secuencia de recorrido</h3><ol className="route-sequence">
          {points.map((point, index) => <li key={point.id} draggable onDragStart={() => setDragged(point.id)}
            onDragOver={(event) => event.preventDefault()} onDrop={() => { if (dragged) move(dragged, index); setDragged(null); }}>
            <span className="route-grip" aria-hidden="true">⠿</span><b>{index + 1}</b><strong>{point.name}</strong>
            <label title="Este punto cierra la ronda"><input type="radio" name="closing-point" checked={point.isClosingPoint} onChange={() => markClosing(point.id)} /> Cierre</label>
            <label><input type="checkbox" checked={Boolean(point.requiresPhoto)} onChange={(event) => setPoints((current) => current.map((item) => item.id === point.id ? { ...item, requiresPhoto: event.target.checked } : item))} /> Foto</label>
            <div className="route-order-buttons"><button type="button" disabled={!index} onClick={() => move(point.id, index - 1)} aria-label={`Subir ${point.name}`}>↑</button><button type="button" disabled={index === points.length - 1} onClick={() => move(point.id, index + 1)} aria-label={`Bajar ${point.name}`}>↓</button><button type="button" onClick={() => removePoint(point.id)} aria-label={`Quitar ${point.name}`}>×</button></div>
          </li>)}</ol></div>
      </div>
      <div className="route-editor-settings">
        <label>Duración estimada (min)<input type="number" min={1} value={duration} onChange={(event) => { setDurationEdited(true); setDuration(Number(event.target.value)); }} /></label>
        <label>Tolerancia (min)<input type="number" min={0} value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} /></label>
        <label>Orden de ejecución<select value={orderMode} onChange={(event) => setOrderMode(event.target.value as RouteTemplate['orderMode'])}><option value="fijo">Fijo</option><option value="aleatorio">Aleatorio</option><option value="aleatorio_con_anclas">Aleatorio con anclas</option></select></label>
        <button className="stats-boton" disabled={saving} type="button" onClick={() => void save()}>{saving ? 'Guardando…' : templateId ? 'Actualizar plantilla' : 'Guardar plantilla'}</button>
      </div>
      {status ? <p className="stats-estado" role="status">{status}</p> : null}
    </>}
  </section>;
}

function closingLast(points: SelectedPoint[]) {
  return [...points.filter((point) => !point.isClosingPoint),
    ...points.filter((point) => point.isClosingPoint)];
}
