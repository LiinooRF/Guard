import { Injectable } from '@nestjs/common';

import { SupervisorService } from '../supervisor/supervisor.service';
import { AdminService, type ContextoEscritura } from './admin.service';
import type {
  CrearPuntoSupervisorDto,
  EditarPuntoSupervisorDto,
  ImportarPuntoSupervisorRowDto,
  VincularEtiquetaSupervisorDto,
} from './dto/punto-supervisor.dto';

/**
 * Puntos de control y etiquetas NFC, del lado del SUPERVISOR (#309).
 *
 * Existe separado de `AdminService` por una sola razon, y es de acceso: aquel
 * servicio no sabe quien pide, opera sobre el tenant entero y es el que usa el
 * ADMIN. El SUPERVISOR **no** puede operar sobre el tenant entero — esta
 * limitado a sus recintos asignados (`supervisor_sites`), y eso se verifica
 * aparte del permiso, en CADA metodo. Es la regla del repo para ese rol: el rol
 * no basta.
 *
 * **Por que la comprobacion va DOS veces, y por que ninguna de las dos sobra:**
 *
 * 1. El pre-chequeo (`ensureAssignedSite`) existe para elegir el CODIGO HTTP.
 *    Resolver primero el recinto del punto permite responder 404 cuando el punto
 *    no existe —o es de otra empresa, que RLS ya tapo antes de llegar aca— y 403
 *    cuando existe en mi empresa pero su recinto no es mio. Al reves filtraria
 *    que ids existen.
 * 2. El `EXISTS (SELECT 1 FROM supervisor_sites ...)` pegado a la sentencia que
 *    escribe (dentro de AdminService, alimentado por `supervisorId`) es el
 *    CONTROL DE ACCESO. Cierra la ventana entre comprobar y escribir, y hace que
 *    un llamador futuro que se saltee el paso 1 falle cerrado en vez de escribir.
 *
 * Si alguien "simplifica" quitando uno, que sepa cual esta quitando.
 *
 * La escritura se DELEGA en AdminService en vez de reimplementarse: dos caminos
 * con el mismo INSERT se separan con el tiempo, y ahi es donde uno de los dos se
 * queda sin la validacion de UID, sin el reemplazo con historial o sin la linea
 * de auditoria.
 *
 * Lo que este servicio NO deja hacer, a proposito:
 *
 * · **Crear, editar o dar de baja RECINTOS**, ni sus horarios habiles ni sus
 *   feriados: eso es `tenant:sites:manage`, del ADMIN, y no se toca.
 * · **El override de foto** (`PATCH /admin/checkpoints/:id/photo`) y **cambiar
 *   `kind` al editar**. Los dos gobiernan `isPhotoRequired()`: con ellos el
 *   supervisor apagaria la evidencia fotografica de un acceso critico sin pasar
 *   por ninguna pantalla de reglas. El DTO no los declara y
 *   `forbidNonWhitelisted` los convierte en 400.
 * · **`GET /admin/tags/resolve`**: contesta a que punto pertenece un UID en TODO
 *   el tenant, o sea un mapa de recintos que no son suyos. Si la pantalla de
 *   instalacion lo necesita, la version del supervisor tiene que hacer JOIN con
 *   supervisor_sites — no filtrar en el cliente.
 * · **Auto-asignarse un recinto**: `PATCH /admin/users/:userId/sites/:siteId`
 *   pide `tenant:users:manage` Y `tenant:sites:manage`, y el SUPERVISOR no tiene
 *   ninguno de los dos. Es la puerta que convertiria este permiso en acceso a la
 *   empresa entera, y por eso tiene test propio aunque "obviamente" este cerrada.
 */
@Injectable()
export class PuntosSupervisorService {
  constructor(
    private readonly admin: AdminService,
    private readonly supervisor: SupervisorService,
  ) {}

  async listCheckpoints(siteId: string, supervisorId: string) {
    await this.supervisor.ensureAssignedSite(siteId, supervisorId);
    return this.admin.listCheckpoints(siteId);
  }

  /**
   * El recinto sale de la URL —la que se comprobo— y se le impone al servicio.
   * `CrearPuntoSupervisorDto` no tiene `siteId`, asi que no hay un segundo
   * recinto en el cuerpo que pudiera ganarle a este.
   */
  async createCheckpoint(
    siteId: string,
    supervisorId: string,
    input: CrearPuntoSupervisorDto,
  ) {
    await this.supervisor.ensureAssignedSite(siteId, supervisorId);
    return this.admin.createCheckpoint(siteId, input, this.contexto(supervisorId));
  }

  async importCheckpoints(
    siteId: string,
    supervisorId: string,
    checkpoints: ImportarPuntoSupervisorRowDto[],
  ) {
    await this.supervisor.ensureAssignedSite(siteId, supervisorId);
    return this.admin.importCheckpoints(siteId, checkpoints, this.contexto(supervisorId));
  }

  async updateCheckpoint(
    checkpointId: string,
    supervisorId: string,
    input: EditarPuntoSupervisorDto,
  ) {
    await this.asegurarPuntoDelSupervisor(checkpointId, supervisorId);
    return this.admin.updateCheckpoint(checkpointId, input, this.contexto(supervisorId));
  }

  async setCheckpointActive(checkpointId: string, supervisorId: string, isActive: boolean) {
    await this.asegurarPuntoDelSupervisor(checkpointId, supervisorId);
    return this.admin.setCheckpointActive(checkpointId, isActive, this.contexto(supervisorId));
  }

  async listTags(checkpointId: string, supervisorId: string) {
    await this.asegurarPuntoDelSupervisor(checkpointId, supervisorId);
    return this.admin.listTags(checkpointId);
  }

  /**
   * El supervisor vincula etiquetas **NFC y solo NFC**.
   *
   * La tecnologia se fija aca y no se toma de la entrada, aunque el DTO de la
   * ruta ya no la acepte: son dos cerraduras a proposito, porque lo que hay
   * detras es el antifraude entero. El QR de respaldo lleva un UID de 16 bytes
   * ALEATORIOS justamente para que nadie pueda imprimir el codigo de un punto
   * sin ir al recinto; si el llamador eligiera el UID de un QR, un supervisor se
   * emite el codigo, lo pega en la garita, y sus guardias marcan la ronda entera
   * sin caminar.
   *
   * El alta de QR sigue siendo del ADMIN, que ademas pasa por la regla
   * `allowQrFallback` del tenant.
   */
  async registerTag(
    checkpointId: string,
    supervisorId: string,
    input: VincularEtiquetaSupervisorDto,
  ) {
    await this.asegurarPuntoDelSupervisor(checkpointId, supervisorId);
    return this.admin.registerTag(
      checkpointId,
      { uid: input.uid, tech: 'nfc' },
      this.contexto(supervisorId),
    );
  }

  /** Dos saltos para resolver el recinto: etiqueta -> punto -> recinto. */
  async retireTag(tagId: string, supervisorId: string) {
    const etiqueta = await this.admin.ensureTag(tagId);
    await this.supervisor.ensureAssignedSite(etiqueta.site_id, supervisorId);
    return this.admin.retireTag(tagId, this.contexto(supervisorId));
  }

  /**
   * 404 si el punto no existe (o es de otra empresa: eso lo tapa RLS antes),
   * 403 si existe pero su recinto no es de este supervisor.
   */
  private async asegurarPuntoDelSupervisor(checkpointId: string, supervisorId: string) {
    const punto = await this.admin.ensureCheckpoint(checkpointId);
    await this.supervisor.ensureAssignedSite(punto.site_id, supervisorId);
  }

  /**
   * El actor y el alcance son el MISMO usuario y salen del token. Que
   * `supervisorId` viaje al servicio es lo que ata la sentencia de escritura a
   * `supervisor_sites`; sin el, la escritura seria la del ADMIN.
   */
  private contexto(supervisorId: string): ContextoEscritura {
    return { actorId: supervisorId, supervisorId };
  }
}
