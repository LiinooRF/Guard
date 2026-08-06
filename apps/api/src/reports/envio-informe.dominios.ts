/**
 * COMPATIBILIDAD. El filtro de dominios se MUDO a `mail/mail-dominios.ts` (#86).
 *
 * Vivia aca cuando solo protegia el informe de ronda. Hoy la supresion esta en
 * `MailQueueService.enqueue`, que es el unico cuello por donde pasa todo el
 * correo del producto —informes, invitaciones, recuperacion de contrasena,
 * escalamiento y checklists—, y la lista la resuelve `MailModule` una sola vez.
 *
 * Este archivo existe para que el carril del informe siga compilando sin
 * tocarlo: `envio-informe.service.ts` importa `DOMINIOS_NO_DESPACHABLES` y
 * `separarPorDominio` desde aca. Sigue necesitandolos, y no por duplicar la
 * proteccion: tiene que decidir ANTES de escribir en `report_deliveries`, o
 * anotaria como enviado un correo que la cola va a descartar.
 *
 * NO agregues nada aca. Si tocas la lista o las reglas, se toca
 * `mail/mail-dominios.ts` — dos copias de una lista de bloqueo son dos
 * verdades, y la que se aplica de verdad es la de la cola.
 *
 * Cuando `envio-informe.service.ts` importe directo desde `../mail/mail-dominios`,
 * este archivo se borra.
 */
export * from '../mail/mail-dominios';
