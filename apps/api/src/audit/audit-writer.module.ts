import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { AuditService } from './audit.service';

/**
 * Nucleo de escritura de auditoria, separado de AuditModule para evitar el
 * ciclo AuditModule -> RulesModule -> AuditModule. Los modulos que solo
 * registran acciones sensibles deben importar este modulo pequeno.
 */
@Module({
  imports: [DatabaseModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditWriterModule {}
