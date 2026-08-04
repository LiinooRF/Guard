import { ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { DataSource } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { firmarEnlace, verificarEnlace } from './photo-links';

interface FilaFoto {
  storage_path: string;
  mime_type: string;
  sha256: string;
}

/**
 * Entrega de la evidencia fotografica (#69).
 *
 * Hasta ahora las fotos se guardaban y no habia como verlas: el anexo del
 * informe listaba metadatos y nada mas. Aca estan las dos mitades — emitir el
 * enlace firmado (con sesion) y servir los bytes (con la firma).
 */
@Injectable()
export class PhotoServingService {
  private readonly evidencePath: string;
  private readonly jwtSecret: string;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.evidencePath = config.getOrThrow<string>('EVIDENCE_PATH');
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  /**
   * Emite el enlace para una foto del tenant en curso. Este es el punto donde
   * se aplica el control de acceso de verdad: corre con sesion, permiso y
   * contexto de tenant, asi que RLS ya deja fuera lo que no es suyo y una foto
   * de otra empresa simplemente no aparece.
   */
  async issueLink(photoId: string) {
    const filas = await this.tenantContext.manager.query<Array<{ tenant_id: string }>>(
      `SELECT tenant_id FROM scan_photos WHERE id = $1
       UNION ALL
       SELECT tenant_id FROM event_photos WHERE id = $1`,
      [photoId],
    );
    const fila = filas[0];
    if (!fila) throw new NotFoundException('La foto no existe');

    const enlace = firmarEnlace(this.jwtSecret, photoId, fila.tenant_id);
    return { photoId, url: enlace.path, expiresAt: enlace.expiresAt };
  }

  /**
   * Sirve los bytes contra un enlace firmado. NO hay sesion aca: la firma es la
   * autorizacion, y por eso dura poco.
   *
   * El contexto de tenant se pone desde el tenant QUE VIENE FIRMADO, nunca
   * desde un parametro suelto: si se tomara del query string sin verificar,
   * cambiar un UUID en la barra de direcciones seria una fuga entre empresas.
   */
  async serveSigned(photoId: string, tenantId: string, exp: string, sig: string) {
    const veredicto = verificarEnlace(this.jwtSecret, photoId, tenantId, exp, sig);
    if (!veredicto.valido) {
      if (veredicto.motivo === 'vencido') {
        throw new GoneException('El enlace de la foto caduco: pide uno nuevo');
      }
      throw new ForbiddenException('Enlace de foto invalido');
    }

    const runner = this.dataSource.createQueryRunner();
    let fila: FilaFoto | undefined;
    try {
      await runner.connect();
      await runner.startTransaction();
      // El tercer parametro en true es SET LOCAL: muere con la transaccion y no
      // queda pegado a la conexion del pool para el siguiente request.
      await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [veredicto.tenantId]);
      // QueryRunner.query no acepta parametro de tipo (a diferencia del
      // EntityManager), de ahi el cast.
      const filas = (await runner.query(
        `SELECT storage_path, mime_type, sha256 FROM scan_photos WHERE id = $1
         UNION ALL
         SELECT storage_path, mime_type, sha256 FROM event_photos WHERE id = $1`,
        [photoId],
      )) as FilaFoto[];
      fila = filas[0];
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }

    if (!fila) throw new NotFoundException('La foto no existe');

    const ruta = join(this.evidencePath, fila.storage_path);
    // storage_path lo escribe la API, no el cliente; aun asi se comprueba que
    // no se salga del volumen. Una ruta con .. dentro de una fila —por un bug
    // futuro o por una restauracion manipulada— leeria archivos del servidor.
    if (!normalize(ruta).startsWith(normalize(this.evidencePath) + sep)) {
      throw new NotFoundException('La foto no existe');
    }

    return { buffer: await readFile(ruta), mimeType: fila.mime_type, sha256: fila.sha256 };
  }

  /**
   * Recalcula el hash del archivo y lo compara con el que se guardo al subirlo.
   *
   * Es lo que convierte el sha256 de un dato mas en una prueba: sin recalcularlo
   * nunca, la columna solo dice lo que la imagen media al entrar, no que siga
   * siendo la misma. Si alguien reemplaza el archivo en el volumen —o una
   * restauracion sale mal— esto lo delata.
   */
  async verifyIntegrity(photoId: string) {
    const filas = await this.tenantContext.manager.query<
      Array<{ storage_path: string; sha256: string }>
    >(
      `SELECT storage_path, sha256 FROM scan_photos WHERE id = $1
       UNION ALL
       SELECT storage_path, sha256 FROM event_photos WHERE id = $1`,
      [photoId],
    );
    const fila = filas[0];
    if (!fila) throw new NotFoundException('La foto no existe');

    let actual: string;
    try {
      const bytes = await readFile(join(this.evidencePath, fila.storage_path));
      actual = createHash('sha256').update(bytes).digest('hex');
    } catch {
      // El archivo ya no esta. No es lo mismo que "fue alterado", y la
      // respuesta tiene que distinguirlo: uno es perdida, el otro es
      // manipulacion, y se investigan distinto.
      return { photoId, estado: 'ausente' as const, esperado: fila.sha256, actual: null };
    }

    return {
      photoId,
      estado: actual === fila.sha256 ? ('intacta' as const) : ('alterada' as const),
      esperado: fila.sha256,
      actual,
    };
  }
}
