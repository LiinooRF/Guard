import type { MailTemplateVariables } from './mail-provider';
import type { ClavePlantilla } from './plantillas-catalogo';

/**
 * Datos de ejemplo para la vista previa del panel (#42).
 *
 * TODO INVENTADO Y QUE SE NOTE. Nada sale de la base: la vista previa no puede
 * mostrar un recinto ni un guardia de verdad, porque la abre un admin para
 * revisar como se ve un correo, no para consultar operacion. El nombre del
 * guardia dice "Guardia de ejemplo" justamente para que nadie confunda la
 * maqueta con un dato real.
 *
 * Las horas van ya escritas como texto, igual que en un correo real: aca no se
 * convierte ninguna zona horaria. Las de verdad las formatea el informe con la
 * zona DEL RECINTO antes de llegar a la plantilla.
 */
const COMUNES: MailTemplateVariables = {
  enlace: 'https://panel.example.cl/#token=ejemplo',
  vigencia: '24 horas',
};

const RONDA: MailTemplateVariables = {
  ruta: 'Ronda nocturna',
  recinto: 'Planta Poniente',
  sucursal: 'Sucursal Norte',
  guardia: 'Guardia de ejemplo',
  cumplimiento: 62,
  umbral: 70,
  esperados: 13,
  escaneados: 8,
  omitidos: 5,
  inicio: '12-08-2025 23:00',
  cierre: '13-08-2025 01:40',
  novedades: 2,
  adjunto: 'Adjunto: informe-ronda.pdf (0,4 MB).',
};

export function variablesDeEjemplo(clave: ClavePlantilla): MailTemplateVariables {
  if (clave === 'invitacion' || clave === 'recuperacion') {
    return clave === 'recuperacion' ? { ...COMUNES, vigencia: '30 minutos' } : COMUNES;
  }
  return RONDA;
}
