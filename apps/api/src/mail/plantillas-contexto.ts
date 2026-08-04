import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';

/**
 * Abre contexto de tenant donde el interceptor no llega (#42).
 *
 * EL CASO REAL, Y ES UNO SOLO: la recuperacion de contraseña. Ese endpoint es
 * PUBLICO —cualquiera puede pedirla desde la pantalla de ingreso— asi que corre
 * con @SkipTenantContext y sin transaccion. Consecuencia: sin esto, el correo de
 * recuperacion es el unico del producto que sale con la marca de la plataforma
 * en vez de la de la empresa, que es exactamente lo que el issue viene a
 * arreglar.
 *
 * El tenant sale de `lookup_recovery_identity`, que ya lo devuelve hoy: no se
 * confia en nada que venga del cuerpo del request. Si esa consulta no encontro
 * a nadie, no hay tenant y no hay correo que mandar tampoco.
 *
 * `set_config(..., true)` y NUNCA `SET`: el tercer parametro en true es lo mismo
 * que SET LOCAL, y muere con la transaccion. Con `SET` la variable se queda
 * pegada a la conexion del pool y el siguiente request hereda el tenant
 * anterior, que en un producto multi-tenant es una fuga cruzada.
 *
 * NO es un bypass de RLS: abre exactamente el mismo contexto que abriria el
 * interceptor para un request autenticado de ese tenant, ni mas ni menos.
 */
@Injectable()
export class PlantillasContextoService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  async conTenant<T>(
    tenantId: string,
    userId: string | null,
    operacion: () => Promise<T>,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.user_id', $2, true),
          set_config('app.support_access_id', '', true)`,
        [tenantId, userId ?? ''],
      );
      const resultado = await this.tenantContext.run(queryRunner, operacion);
      await queryRunner.commitTransaction();
      return resultado;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
