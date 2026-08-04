import { Injectable } from '@nestjs/common';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { PlantillasMarcaService } from './plantillas-marca';
import type { RemitenteTenantInput } from './plantillas-remitente.dto';
import { construirSobre } from './plantillas-sobre';

/**
 * Lectura y escritura del remitente de la empresa (#42).
 *
 * Devuelve siempre el remitente EFECTIVO ademas del configurado: el admin tiene
 * que poder ver la linea exacta que va a leer su cliente, no adivinarla a
 * partir de tres campos y una regla de verificacion.
 */

interface FilaRemitente {
  reply_to: string | null;
  from_address: string | null;
  from_address_verified_at: Date | null;
}

export interface RemitenteResuelto {
  readonly replyTo: string | null;
  readonly fromAddress: string | null;
  readonly fromAddressVerified: boolean;
  readonly fromAddressVerifiedAt: string | null;
  /** Las cabeceras tal cual saldran. */
  readonly efectivo: { readonly from: string; readonly replyTo: string | null };
  /** Que le falta a esta configuracion, en lenguaje del cliente. */
  readonly avisos: readonly string[];
}

@Injectable()
export class PlantillasRemitenteService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly marca: PlantillasMarcaService,
  ) {}

  async actual(logoMaxKB: number): Promise<RemitenteResuelto> {
    const filas = await this.tenantContext.manager.query<FilaRemitente[]>(
      `SELECT reply_to, from_address, from_address_verified_at
       FROM tenant_mail_sender
       WHERE tenant_id = app_tenant_id()`,
    );
    return this.resolver(filas[0] ?? null, logoMaxKB);
  }

  async guardar(input: RemitenteTenantInput, logoMaxKB: number): Promise<RemitenteResuelto> {
    // INSERT ... ON CONFLICT ... RETURNING devuelve las filas PLANAS. Es
    // distinto de un UPDATE o un DELETE sueltos, que en PostgreSQL devuelven
    // [filas, cantidad]: leerlos como si fueran un arreglo de filas deja el
    // test verde y la respuesta rota.
    //
    // No se escribe from_address_verified_at ni se intenta: el rol de la
    // aplicacion no tiene el privilegio de esa columna, y si la direccion
    // cambia, el trigger de la tabla borra la verificacion anterior.
    const filas = await this.tenantContext.manager.query<FilaRemitente[]>(
      `INSERT INTO tenant_mail_sender (tenant_id, reply_to, from_address)
       VALUES (app_tenant_id(), $1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET
         reply_to = EXCLUDED.reply_to,
         from_address = EXCLUDED.from_address,
         updated_at = now()
       RETURNING reply_to, from_address, from_address_verified_at`,
      [input.replyTo, input.fromAddress],
    );
    return this.resolver(filas[0] ?? null, logoMaxKB);
  }

  private async resolver(
    fila: FilaRemitente | null,
    logoMaxKB: number,
  ): Promise<RemitenteResuelto> {
    const marca = await this.marca.resolver(logoMaxKB);
    const sobre = construirSobre(marca, this.marca.remitenteDeLaPlataforma());
    const verificada = fila?.from_address_verified_at ?? null;
    const avisos: string[] = [];

    if (fila?.from_address && verificada === null) {
      avisos.push(
        `La dirección ${fila.from_address} quedó guardada, pero el correo todavía sale desde ` +
          'la dirección de la plataforma. Usarla exige que el dominio tenga SPF, DKIM y DMARC ' +
          'apuntando a nuestro servidor, y esa verificación la hace el equipo de la plataforma. ' +
          'Mientras tanto tu cliente ya ve el nombre de tu empresa y te responde a ti.',
      );
    }
    if (marca.replyTo === null) {
      avisos.push(
        'No hay dirección de respuesta configurada: si tu cliente contesta el correo, la ' +
          'respuesta no le llega a tu empresa.',
      );
    }
    if (marca.esDeLaPlataforma) {
      avisos.push(
        'No fue posible resolver la marca de la empresa, así que este correo saldría con la ' +
          'marca de la plataforma.',
      );
    }

    return {
      replyTo: fila?.reply_to ?? null,
      fromAddress: fila?.from_address ?? null,
      fromAddressVerified: verificada !== null,
      // new Date() alrededor a proposito: segun como este configurado el driver,
      // un timestamptz puede llegar como Date o como texto, y .toISOString()
      // sobre un texto revienta en runtime con el test en verde.
      fromAddressVerifiedAt: verificada === null ? null : new Date(verificada).toISOString(),
      efectivo: { from: sobre.from, replyTo: sobre.replyTo ?? null },
      avisos,
    };
  }
}
