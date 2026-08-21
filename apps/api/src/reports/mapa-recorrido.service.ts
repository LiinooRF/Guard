import { Injectable, NotFoundException } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import {
  ajustarACaja,
  construirMapaRecorrido,
  expandirAProporcion,
  recuadroGeograficoDe,
  type CoordenadaPuntoRow,
  type EscaneoGpsRow,
  type MapaRecorrido,
  type TrazaRow,
} from './mapa-recorrido.model';
import type { FilaPunto } from './patrol-report.model';
import { obtenerFondo, type FondoCartografico } from './mapa-tiles';

/**
 * Medidas de la caja del plano en el PDF, en puntos, y su margen interior.
 * Copiadas del renderer: si dejan de coincidir, el fondo queda corrido respecto
 * de las marcas — que es exactamente el defecto que se corrigio aca.
 */
const CAJA_ANCHO_PT = 515;
const CAJA_ALTO_PT = 250;
const PADDING_PT = 10;

/**
 * Datos del mapa del recorrido para el informe de ronda (#79).
 *
 * Se separa de PatrolReportService por la misma razon por la que ese servicio
 * existe: el informe se genera tanto desde la descarga del panel como desde el
 * worker de BullMQ que lo manda al cerrar la ronda (#86). Todo lo que el mapa
 * necesita se resuelve aca, antes de escribir un solo byte del PDF.
 *
 * Los puntos NO se vuelven a consultar ni a clasificar: llegan ya resueltos
 * desde el informe (FilaPunto, que sale de computeCompliance). Si el mapa
 * contara sus propios omitidos, tarde o temprano el circulo del plano y la
 * tabla de la pagina anterior dirian cosas distintas de la misma ronda.
 */

export interface OpcionesMapa {
  /**
   * Quien pide el informe. `null` = contexto de sistema (la cola de #86), que
   * ya corre dentro del tenant correcto y no tiene usuario.
   */
  readonly requester?: Pick<AuthenticatedUser, 'sub' | 'role'> | null;
}

interface RondaRow {
  site_id: string;
  site_latitude: string | null;
  site_longitude: string | null;
}

@Injectable()
export class MapaRecorridoService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly supervisor: SupervisorService,
  ) {}

  /**
   * Devuelve el mapa listo para dibujar, o `null` cuando el tenant apago el
   * mapa en el informe (`reportIncludeMap`).
   *
   * `null` y "mapa vacio" son cosas distintas a proposito: `null` = el cliente
   * no quiere la seccion; mapa con `hayDatos` en false = la quiere y hay que
   * explicarle por que no se pudo dibujar.
   */
  async construir(
    patrolId: string,
    puntos: readonly FilaPunto[],
    opciones: OpcionesMapa = {},
  ): Promise<MapaRecorrido | null> {
    const { requester = null } = opciones;

    // Se resuelve el recinto desde la propia ronda y no se confia en el que
    // mande el llamador: es lo unico que hace que la verificacion de alcance de
    // mas abajo signifique algo.
    const rondas = await this.tenantContext.manager.query<RondaRow[]>(
      `
        SELECT p.site_id,
               s.latitude AS site_latitude,
               s.longitude AS site_longitude
        FROM patrols p
        JOIN sites s ON s.tenant_id = p.tenant_id AND s.id = p.site_id
        WHERE p.id = $1
      `,
      [patrolId],
    );
    const ronda = rondas[0];
    if (!ronda) throw new NotFoundException('La ronda no existe');

    // El SUPERVISOR esta limitado a SUS recintos asignados: el permiso
    // reports:read no alcanza por si solo (ver roles.ts y CLAUDE.md). Se reusa
    // ensureAssignedSite en vez de repetir la consulta — duplicar un control de
    // acceso es como se terminan teniendo dos, y uno desactualizado.
    if (requester !== null && requester.role === 'SUPERVISOR') {
      await this.supervisor.ensureAssignedSite(ronda.site_id, requester.sub);
    }

    // Reglas resueltas EN EL RECINTO de la ronda: un tenant puede querer el
    // mapa en sus condominios y no en la planta industrial.
    const reglas = await this.rules.effective({ siteId: ronda.site_id });
    if (!reglas.reportIncludeMap) return null;

    const coordenadas = await this.coordenadasDePuntos(puntos);
    const traza = await this.tenantContext.manager.query<TrazaRow[]>(
      `
        SELECT recorded_at_device, latitude, longitude, accuracy_m
        FROM patrol_tracks
        WHERE patrol_id = $1
        ORDER BY recorded_at_device
      `,
      [patrolId],
    );
    const escaneos = await this.tenantContext.manager.query<EscaneoGpsRow[]>(
      `
        SELECT checkpoint_id, scanned_at_server, latitude, longitude, accuracy_m, anomalies
        FROM scans
        WHERE patrol_id = $1
        ORDER BY scanned_at_server
      `,
      [patrolId],
    );

    return construirMapaRecorrido({
      puntos,
      coordenadas,
      traza,
      escaneos,
      recinto: { latitude: ronda.site_latitude, longitude: ronda.site_longitude },
      maxErrorTrazaM: reglas.mapTrackMaxAccuracyM,
      maxPuntosTraza: reglas.mapMaxTrackPoints,
      // gpsTrackingEnabled y no gpsSharingMandatory: con GPS opcional el PDF
      // salia sin trayecto aunque el guardia hubiera aceptado y hubiera puntos.
      trazaActivada: reglas.gpsTrackingEnabled,
    });
  }

  /**
   * Cartografia de fondo del plano, o null si no se puede.
   *
   * El proveedor sale de `MAP_TILE_URL`, la MISMA variable que ya usa el panel
   * web: dos configuraciones distintas para el mismo mapa terminarian mostrando
   * cartografias que no coinciden entre pantalla e informe.
   */
  async fondoDe(mapa: MapaRecorrido): Promise<FondoCartografico | null> {
    if (!mapa.origen) return null;
    // Los tiles se piden con el tamaño del RECTANGULO QUE OCUPA EL PLANO, no
    // con el de la caja: el encuadre es cuadrado y la caja apaisada, asi que el
    // plano se dibuja centrado y mas chico. Pedirlos del tamaño de la caja
    // dejaba las calles corridas respecto del recorrido.
    const interior = {
      x: 0,
      y: 0,
      ancho: CAJA_ANCHO_PT - PADDING_PT * 2,
      alto: CAJA_ALTO_PT - PADDING_PT * 2,
    };
    // Mismo encuadre expandido que usa el renderer: si difiere, el fondo se corre.
    const encuadre = expandirAProporcion(mapa.encuadre, interior);
    const ajuste = ajustarACaja(encuadre, interior);
    const recuadro = recuadroGeograficoDe({ ...mapa, encuadre });
    if (!recuadro) return null;
    return obtenerFondo(
      recuadro,
      { ancho: ajuste.anchoPx, alto: ajuste.altoPx },
      process.env.MAP_TILE_URL,
    );
  }

  /**
   * Coordenadas de los puntos esperados de la ronda.
   *
   * Se piden por lista de ids y no por recinto: un punto desactivado o movido a
   * otra ruta despues de la ronda igual tiene que aparecer en el informe de esa
   * noche. RLS ya encierra la consulta en el tenant.
   */
  private async coordenadasDePuntos(
    puntos: readonly FilaPunto[],
  ): Promise<CoordenadaPuntoRow[]> {
    if (puntos.length === 0) return [];
    return this.tenantContext.manager.query<CoordenadaPuntoRow[]>(
      `
        SELECT id, latitude, longitude
        FROM checkpoints
        WHERE id = ANY($1::uuid[])
      `,
      [puntos.map((punto) => punto.checkpointId)],
    );
  }
}
