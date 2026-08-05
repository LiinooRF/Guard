'use client';

import { FormEvent, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { HorarioHabilPanel } from './horario-habil-panel';
import type { TenantSite } from './role-management';
import { CoordinateMap } from './coordinate-map';
import {
  CHECKPOINT_CSV_TEMPLATE,
  parseCheckpointCsv,
  type CsvResult,
} from './checkpoint-csv';

interface Checkpoint {
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



type Coordinates = [number | null, number | null];


export function SiteManagement({
  sites,
  apiUrl,
  mapTileUrl,
  mapAttribution,
}: {
  sites: TenantSite[];
  apiUrl: string;
  mapTileUrl: string | null;
  mapAttribution: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [siteCoordinates, setSiteCoordinates] = useState<Coordinates>([null, null]);
  const [siteEditCoordinates, setSiteEditCoordinates] = useState<Coordinates>([null, null]);
  const [checkpointCoordinates, setCheckpointCoordinates] = useState<Coordinates>([null, null]);
  const [csv, setCsv] = useState<CsvResult | null>(null);
  const selected = sites.find((site) => site.id === selectedId) ?? null;
  const branches = useMemo(() => groupByBranch(sites), [sites]);

  async function createSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!coordinatesComplete(siteCoordinates)) {
      return setMessage('Completa latitud y longitud, o deja ambas vacías.');
    }
    const response = await jsonRequest(`${apiUrl}/admin/sites`, 'POST', {
      branchName: data.get('branchName'),
      name: data.get('name'),
      address: data.get('address'),
      timezone: data.get('timezone'),
      latitude: siteCoordinates[0] ?? undefined,
      longitude: siteCoordinates[1] ?? undefined,
    });
    if (!response.ok) return setMessage(await responseMessage(response));
    form.reset();
    setSiteCoordinates([null, null]);
    setMessage('Recinto creado. Ya puedes cargar sus puntos y horarios.');
    startTransition(() => router.refresh());
  }

  async function selectSite(site: TenantSite) {
    setSelectedId(site.id);
    setLoadingDetail(true);
    setMessage(null);
    setCheckpointCoordinates(
      [site.latitude, site.longitude],
    );
    setSiteEditCoordinates(
      [site.latitude, site.longitude],
    );
    const [pointResponse] = await Promise.all([
      fetch(`${apiUrl}/admin/sites/${site.id}/checkpoints`, requestOptions()),
    ]);
    if (!pointResponse.ok) {
      setMessage('No pudimos cargar todos los datos del recinto. Revisa tus permisos e intenta nuevamente.');
      setLoadingDetail(false);
      return;
    }
    setCheckpoints((await pointResponse.json()) as Checkpoint[]);
    setLoadingDetail(false);
  }

  async function updateSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    if (!coordinatesComplete(siteEditCoordinates)) {
      return setMessage('Completa latitud y longitud, o deja ambas vacías.');
    }
    const response = await jsonRequest(`${apiUrl}/admin/sites/${selected.id}`, 'PATCH', {
      branchName: data.get('branchName'),
      name: data.get('name'),
      address: data.get('address'),
      timezone: data.get('timezone'),
      latitude: siteEditCoordinates[0],
      longitude: siteEditCoordinates[1],
    });
    if (!response.ok) return setMessage(await responseMessage(response));
    setMessage('Datos del recinto actualizados.');
    startTransition(() => router.refresh());
  }

  async function toggleSite(site: TenantSite) {
    const response = await jsonRequest(`${apiUrl}/admin/sites/${site.id}/active`, 'PATCH', {
      isActive: !site.isActive,
    });
    if (!response.ok) return setMessage(await responseMessage(response));
    setMessage(site.isActive ? 'Recinto dado de baja.' : 'Recinto reactivado.');
    startTransition(() => router.refresh());
  }

  async function createCheckpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const photo = String(data.get('requiresPhoto') ?? 'inherit');
    if (!coordinatesComplete(checkpointCoordinates)) {
      return setMessage('Completa latitud y longitud, o deja ambas vacías.');
    }
    const body: Record<string, unknown> = {
      name: data.get('name'),
      description: data.get('description') || undefined,
      kind: data.get('kind'),
      suggestedOrder: Number(data.get('suggestedOrder')),
      latitude: checkpointCoordinates[0] ?? undefined,
      longitude: checkpointCoordinates[1] ?? undefined,
      instructions: data.get('instructions') || undefined,
      tagUid: data.get('tagUid') || undefined,
    };
    if (photo !== 'inherit') body.requiresPhoto = photo === 'yes';
    const response = await jsonRequest(
      `${apiUrl}/admin/sites/${selected.id}/checkpoints`,
      'POST',
      body,
    );
    if (!response.ok) return setMessage(await responseMessage(response));
    form.reset();
    setMessage('Punto creado y etiqueta vinculada.');
    await selectSite(selected);
  }

  async function updateCheckpoint(event: FormEvent<HTMLFormElement>, checkpoint: Checkpoint) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await jsonRequest(`${apiUrl}/admin/checkpoints/${checkpoint.id}`, 'PATCH', {
      name: data.get('name'),
      description: data.get('description') || '',
      kind: data.get('kind'),
      suggestedOrder: Number(data.get('suggestedOrder')),
      latitude: data.get('latitude') ? Number(data.get('latitude')) : undefined,
      longitude: data.get('longitude') ? Number(data.get('longitude')) : undefined,
      instructions: data.get('instructions') || '',
    });
    if (!response.ok) return setMessage(await responseMessage(response));
    setMessage('Punto actualizado.');
    if (selected) await selectSite(selected);
  }

  async function toggleCheckpoint(checkpoint: Checkpoint) {
    const response = await jsonRequest(
      `${apiUrl}/admin/checkpoints/${checkpoint.id}/active`,
      'PATCH',
      { isActive: !checkpoint.isActive },
    );
    if (!response.ok) return setMessage(await responseMessage(response));
    if (selected) await selectSite(selected);
  }

  async function bindTag(event: FormEvent<HTMLFormElement>, checkpoint: Checkpoint) {
    event.preventDefault();
    const form = event.currentTarget;
    const uid = new FormData(form).get('uid');
    const response = await jsonRequest(`${apiUrl}/admin/checkpoints/${checkpoint.id}/tags`, 'POST', {
      uid,
      tech: 'nfc',
    });
    if (!response.ok) return setMessage(await responseMessage(response));
    form.reset();
    setMessage(`Etiqueta vinculada a ${checkpoint.name}.`);
  }



  async function importCsv() {
    if (!selected || !csv || csv.errors.length || !csv.checkpoints.length) return;
    const response = await jsonRequest(
      `${apiUrl}/admin/sites/${selected.id}/checkpoints/import`,
      'POST',
      { checkpoints: csv.checkpoints },
    );
    if (!response.ok) return setMessage(await responseMessage(response));
    const result = (await response.json()) as { imported: number };
    setCsv(null);
    setMessage(`${result.imported} puntos importados correctamente.`);
    await selectSite(selected);
  }

  return (
    <section className="sites-management" id="recintos">
      {message ? <p className="management-message sticky-message" role="status">{message}</p> : null}
      <div className="card-heading">
        <div><span className="eyebrow">Infraestructura</span><h2>Recintos y puntos de control</h2></div>
        <span className="status-pill">{sites.length} recintos</span>
      </div>

      <div className="management-grid site-create-grid">
        <section className="management-card">
          <div className="card-heading"><div><span className="eyebrow">Alta</span><h3>Nuevo recinto</h3></div></div>
          <form className="management-form" onSubmit={createSite}>
            <label>Sucursal<input name="branchName" required minLength={2} /></label>
            <label>Nombre<input name="name" required minLength={2} /></label>
            <label>Dirección<input name="address" required minLength={3} /></label>
            <label>Zona horaria<input name="timezone" defaultValue="America/Santiago" required /></label>
            <CoordinateFields value={siteCoordinates} onChange={setSiteCoordinates} />
            <button className="primary-button" disabled={pending}>Crear recinto</button>
          </form>
        </section>
        <CoordinateMap
          latitude={siteCoordinates[0]}
          longitude={siteCoordinates[1]}
          tileUrl={mapTileUrl}
          attribution={mapAttribution}
          onPick={(lat, lng) => setSiteCoordinates([roundCoordinate(lat), roundCoordinate(lng)])}
        />
      </div>

      <section className="management-card management-wide">
        <div className="card-heading"><div><span className="eyebrow">Catálogo</span><h3>Agrupados por sucursal</h3></div></div>
        <div className="branch-list">
          {branches.map(([branch, branchSites]) => (
            <section className="branch-group" key={branch}>
              <h4>{branch}<span>{branchSites.length}</span></h4>
              {branchSites.map((site) => (
                <article className={`management-row${selectedId === site.id ? ' selected-row' : ''}`} key={site.id}>
                  <div><strong>{site.name}</strong><small>{site.address}</small><small>{site.checkpointCount} puntos · {site.timezone}</small></div>
                  <span className={`state-chip ${site.isActive ? 'active' : 'suspended'}`}>{site.isActive ? 'Activo' : 'Inactivo'}</span>
                  <div className="row-actions">
                    <button className="secondary-button" onClick={() => void selectSite(site)}>Administrar</button>
                    <button className="secondary-button" onClick={() => void toggleSite(site)}>{site.isActive ? 'Dar de baja' : 'Reactivar'}</button>
                  </div>
                </article>
              ))}
            </section>
          ))}
        </div>
      </section>

      {selected ? (
        <div className="site-detail">
          <div className="card-heading"><div><span className="eyebrow">Recinto seleccionado</span><h2>{selected.name}</h2></div><button className="secondary-button" onClick={() => setSelectedId(null)}>Cerrar</button></div>
          {loadingDetail ? <p className="dashboard-empty">Cargando recinto…</p> : (
            <>
              <div className="management-grid">
                <SiteGeneralForm
                  site={selected}
                  pending={pending}
                  coordinates={siteEditCoordinates}
                  setCoordinates={setSiteEditCoordinates}
                  onSubmit={updateSite}
                />
              </div>
              {/* Horario habil y feriados del recinto (#68). El panel carga,
                  guarda y comprueba por su cuenta: no necesita estado del
                  padre. Reemplaza a HoursEditor y HolidayEditor, que eran la
                  version minima de esto mismo. */}
              <HorarioHabilPanel
                apiUrl={apiUrl}
                siteId={selected.id}
                siteName={selected.name}
                timezone={selected.timezone}
              />
              <div className="management-grid checkpoint-create-grid">
                <CheckpointCreateForm
                  nextOrder={checkpoints.length + 1}
                  coordinates={checkpointCoordinates}
                  setCoordinates={setCheckpointCoordinates}
                  onSubmit={createCheckpoint}
                />
                <CoordinateMap
                  latitude={checkpointCoordinates[0]}
                  longitude={checkpointCoordinates[1]}
                  tileUrl={mapTileUrl}
                  attribution={mapAttribution}
                  onPick={(lat, lng) => setCheckpointCoordinates([roundCoordinate(lat), roundCoordinate(lng)])}
                />
              </div>
              <CsvImporter value={csv} setValue={setCsv} onImport={() => void importCsv()} />
              <CheckpointList
                checkpoints={checkpoints}
                onUpdate={updateCheckpoint}
                onToggle={(checkpoint) => void toggleCheckpoint(checkpoint)}
                onBind={bindTag}
              />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function SiteGeneralForm({ site, pending, coordinates, setCoordinates, onSubmit }: { site: TenantSite; pending: boolean; coordinates: Coordinates; setCoordinates: (value: Coordinates) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <section className="management-card"><div className="card-heading"><div><span className="eyebrow">Datos</span><h3>Información general</h3></div></div>
      <form className="management-form" onSubmit={onSubmit}>
        <label>Sucursal<input name="branchName" defaultValue={site.branchName} required /></label>
        <label>Nombre<input name="name" defaultValue={site.name} required /></label>
        <label>Dirección<input name="address" defaultValue={site.address} required /></label>
        <label>Zona horaria<input name="timezone" defaultValue={site.timezone} required /></label>
        <CoordinateFields value={coordinates} onChange={setCoordinates} />
        <button className="primary-button" disabled={pending}>Guardar datos</button>
      </form>
    </section>
  );
}



function CheckpointCreateForm({ nextOrder, coordinates, setCoordinates, onSubmit }: { nextOrder: number; coordinates: Coordinates; setCoordinates: (value: Coordinates) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <section className="management-card"><div className="card-heading"><div><span className="eyebrow">Puntos</span><h3>Nuevo punto de control</h3></div></div>
      <form className="management-form" onSubmit={onSubmit}>
        <label>Nombre<input name="name" required minLength={2} /></label><label>Descripción<input name="description" /></label>
        <label>Criticidad<select name="kind"><option value="normal">Normal</option><option value="acceso_critico">Acceso crítico</option></select></label>
        <label>Orden sugerido<input name="suggestedOrder" type="number" min={0} defaultValue={nextOrder} required /></label>
        <label>Foto<select name="requiresPhoto"><option value="inherit">Heredar reglas</option><option value="yes">Siempre</option><option value="no">Nunca</option></select></label>
        <label>Instrucciones<textarea name="instructions" rows={2} /></label><label>UID etiqueta NFC<input name="tagUid" minLength={4} maxLength={64} /></label>
        <CoordinateFields value={coordinates} onChange={setCoordinates} />
        <button className="primary-button">Crear punto</button>
      </form>
    </section>
  );
}

function CoordinateFields({ value, onChange }: { value: Coordinates; onChange: (value: Coordinates) => void }) {
  return <div className="coordinate-fields"><label>Latitud<input type="number" step="0.000001" min={-90} max={90} value={value[0] ?? ''} onChange={(event) => onChange([event.target.value === '' ? null : Number(event.target.value), value[1]])} /></label><label>Longitud<input type="number" step="0.000001" min={-180} max={180} value={value[1] ?? ''} onChange={(event) => onChange([value[0], event.target.value === '' ? null : Number(event.target.value)])} /></label></div>;
}

function CsvImporter({ value, setValue, onImport }: { value: CsvResult | null; setValue: (value: CsvResult | null) => void; onImport: () => void }) {
  function template() { const url = URL.createObjectURL(new Blob([CHECKPOINT_CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'plantilla-puntos.csv'; link.click(); URL.revokeObjectURL(url); }
  return <section className="management-card management-wide csv-importer"><div className="card-heading"><div><span className="eyebrow">Carga masiva</span><h3>Importar puntos desde CSV</h3></div><button className="secondary-button" type="button" onClick={template}>Descargar plantilla</button></div><p className="form-note">La importación es atómica: si una fila o etiqueta falla, no se guarda ninguna. Admite coma o punto y coma.</p><input type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then((text) => setValue(parseCheckpointCsv(text))); }} />{value ? <div className={value.errors.length ? 'csv-result error' : 'csv-result'}>{value.errors.length ? <ul>{value.errors.slice(0, 12).map((error) => <li key={error}>{error}</li>)}</ul> : <strong>{value.checkpoints.length} puntos listos para importar</strong>}</div> : null}<button className="primary-button" disabled={!value || Boolean(value.errors.length) || !value.checkpoints.length} onClick={onImport}>Importar puntos</button></section>;
}

function CheckpointList({ checkpoints, onUpdate, onToggle, onBind }: { checkpoints: Checkpoint[]; onUpdate: (event: FormEvent<HTMLFormElement>, checkpoint: Checkpoint) => void; onToggle: (checkpoint: Checkpoint) => void; onBind: (event: FormEvent<HTMLFormElement>, checkpoint: Checkpoint) => void }) {
  return <section className="management-card management-wide"><div className="card-heading"><div><span className="eyebrow">Inventario</span><h3>Puntos de control</h3></div><span className="status-pill">{checkpoints.length}</span></div><div className="checkpoint-admin-list">{checkpoints.map((checkpoint) => <details key={checkpoint.id}><summary><span><strong>{checkpoint.suggestedOrder}. {checkpoint.name}</strong><small>{checkpoint.kind === 'acceso_critico' ? 'Acceso crítico' : 'Normal'} · {checkpoint.latitude === null ? 'Sin ubicación' : `${checkpoint.latitude}, ${checkpoint.longitude}`}</small></span><span className={`state-chip ${checkpoint.isActive ? 'active' : 'suspended'}`}>{checkpoint.isActive ? 'Activo' : 'Inactivo'}</span></summary><form className="management-form checkpoint-edit-form" onSubmit={(event) => onUpdate(event, checkpoint)}><label>Nombre<input name="name" defaultValue={checkpoint.name} required /></label><label>Descripción<input name="description" defaultValue={checkpoint.description ?? ''} /></label><label>Tipo<select name="kind" defaultValue={checkpoint.kind}><option value="normal">Normal</option><option value="acceso_critico">Acceso crítico</option></select></label><label>Orden<input name="suggestedOrder" type="number" min={0} defaultValue={checkpoint.suggestedOrder} /></label><label>Latitud<input name="latitude" type="number" step="0.000001" defaultValue={checkpoint.latitude ?? ''} /></label><label>Longitud<input name="longitude" type="number" step="0.000001" defaultValue={checkpoint.longitude ?? ''} /></label><label>Instrucciones<input name="instructions" defaultValue={checkpoint.instructions ?? ''} /></label><div className="row-actions"><button className="primary-button">Guardar punto</button><button className="secondary-button" type="button" onClick={() => onToggle(checkpoint)}>{checkpoint.isActive ? 'Dar de baja' : 'Reactivar'}</button></div></form><form className="tag-bind-form" onSubmit={(event) => onBind(event, checkpoint)}><label>Vincular/reemplazar NFC<input name="uid" required minLength={4} maxLength={64} placeholder="UID leído por el instalador" /></label><button className="secondary-button">Vincular etiqueta</button></form></details>)}</div></section>;
}

function groupByBranch(sites: TenantSite[]): Array<[string, TenantSite[]]> { const groups = new Map<string, TenantSite[]>(); for (const site of sites) groups.set(site.branchName, [...(groups.get(site.branchName) ?? []), site]); return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'es')); }
function roundCoordinate(value: number) { return Math.round(value * 1_000_000) / 1_000_000; }
function coordinatesComplete(value: Coordinates) { return (value[0] === null) === (value[1] === null); }
function requestOptions(): RequestInit { return { credentials: 'include', cache: 'no-store' }; }
function jsonRequest(url: string, method: string, body: object) { return fetch(url, { method, credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
async function responseMessage(response: Response) { try { const data = (await response.json()) as { message?: string | string[] }; return Array.isArray(data.message) ? data.message.join('. ') : data.message ?? 'No fue posible completar la operación.'; } catch { return 'No fue posible completar la operación.'; } }
