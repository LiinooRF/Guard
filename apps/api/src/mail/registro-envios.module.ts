import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RegistroEnviosProveedorController } from './registro-envios-proveedor.controller';
import { RegistroEnviosController } from './registro-envios.controller';
import {
  RegistroCorrelacionService,
  registroCorrelacionRedisProvider,
} from './registro-envios.correlacion';
import { RegistroEnviosService } from './registro-envios.service';

/**
 * Registro de envios de correo y estado por notificacion (#44).
 *
 * VA APARTE DE MailModule aunque viva en la misma carpeta. MailModule es el
 * carril de MANDAR correo (proveedor, cola, worker); este es el de saber que
 * paso con cada uno. Separados, MailModule sigue arrancando aunque este registro
 * se apague, y sobre todo: MailModule importa a este y no al reves, asi que no
 * hay ciclo de dependencias entre los dos.
 *
 * DatabaseModule es obligatorio: el servicio inyecta el DataSource para abrir sus
 * propias transacciones (el processor de BullMQ no tiene request) y
 * TenantContextService para las consultas de la vista de soporte.
 *
 * NO registra la conexion raiz de BullMQ: este modulo no encola nada. El cliente
 * Redis que si necesita es el del indice de correlacion, y es propio —mismo
 * criterio que AUTH_REDIS— para no depender del ciclo de vida de las colas.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [RegistroEnviosController, RegistroEnviosProveedorController],
  providers: [
    registroCorrelacionRedisProvider,
    RegistroCorrelacionService,
    RegistroEnviosService,
  ],
  // Se exporta porque quien escribe el registro es otro: MailQueueService al
  // encolar y MailProcessor al enviar o fallar.
  exports: [RegistroEnviosService],
})
export class RegistroEnviosModule {}
