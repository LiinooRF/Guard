import { z } from 'zod';

/**
 * Lo que el ADMIN puede configurar del remitente de su empresa (#42).
 *
 * `fromAddressVerifiedAt` NO esta en el DTO y no es un olvido: la verificacion
 * del dominio la acredita la plataforma, no el tenant. Si estuviera aca,
 * cualquier empresa del SaaS podria declararse dueña de un dominio ajeno y
 * mandar correo diciendo ser otra. La base ademas lo impide con un grant por
 * columna, asi que ni escribiendo SQL a mano desde la API se puede.
 */

const MENSAJE_CORREO = 'Escribe una dirección de correo válida, por ejemplo contacto@tuempresa.cl';

/** Misma forma que el CHECK de la migracion 1725559200000. */
const FORMA_CORREO = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,24}$/;

const direccionCorreo = z
  .string()
  .max(254, 'La dirección de correo no puede pasar de 254 caracteres')
  .transform((valor) => valor.trim().toLowerCase())
  .refine((valor) => FORMA_CORREO.test(valor), MENSAJE_CORREO);

export const remitenteTenantSchema = z
  .object({
    /**
     * A donde le contesta el cliente cuando aprieta "responder". Es el campo
     * que hace que el correo deje de devolverse al revendedor.
     */
    replyTo: direccionCorreo.nullable().default(null),

    /**
     * La direccion desde la que la empresa QUIERE mandar. Se guarda desde el
     * primer dia porque es el dato que la plataforma necesita para verificar el
     * dominio, pero no se usa en el From hasta que esa verificacion exista.
     */
    fromAddress: direccionCorreo.nullable().default(null),
  })
  .strict();

export type RemitenteTenantInput = z.infer<typeof remitenteTenantSchema>;
