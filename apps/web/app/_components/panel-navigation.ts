export type PanelRole = 'ADMIN' | 'SUPERVISOR' | 'SUPERADMIN';

export interface PanelNavigationItem {
  view: string;
  icon: string;
  label: string;
}

export interface PanelNavigationGroup {
  label: string;
  items: PanelNavigationItem[];
}

export const PANEL_NAVIGATION: Record<PanelRole, PanelNavigationGroup[]> = {
  ADMIN: [
    { label: 'Inicio', items: [{ view: 'resumen', icon: '⌂', label: 'Resumen' }] },
    {
      label: 'Operación',
      items: [
        { view: 'informes', icon: '▤', label: 'Informes' },
        { view: 'envios', icon: '✉', label: 'Envíos de correo' },
      ],
    },
    {
      label: 'Organización',
      items: [
        { view: 'personas', icon: '♙', label: 'Personas y acceso' },
        { view: 'recintos', icon: '▦', label: 'Recintos' },
      ],
    },
    {
      label: 'Configuración',
      items: [
        { view: 'reglas', icon: '⚙', label: 'Reglas' },
        { view: 'marca', icon: '◆', label: 'Marca' },
      ],
    },
    {
      label: 'Control',
      items: [
        { view: 'cumplimiento', icon: '⚖', label: 'Cumplimiento legal' },
        { view: 'sesiones', icon: '◉', label: 'Sesiones' },
      ],
    },
  ],
  SUPERVISOR: [
    { label: 'Inicio', items: [{ view: 'resumen', icon: '⌂', label: 'Resumen' }] },
    {
      label: 'Operación',
      items: [
        { view: 'planificacion', icon: '⌁', label: 'Planificación' },
        { view: 'monitoreo', icon: '●', label: 'Monitoreo en vivo' },
        { view: 'informes', icon: '▤', label: 'Informes' },
      ],
    },
    {
      label: 'Cuenta',
      items: [
        { view: 'consentimiento', icon: '⌖', label: 'Mi ubicación' },
        { view: 'sesiones', icon: '◉', label: 'Sesiones' },
      ],
    },
  ],
  SUPERADMIN: [
    {
      label: 'Plataforma',
      items: [
        { view: 'resumen', icon: '⌂', label: 'Empresas y licencias' },
        { view: 'sesiones', icon: '◉', label: 'Sesiones' },
      ],
    },
  ],
};

export function resolvePanelView(role: PanelRole, requested: string | undefined): string {
  const views = PANEL_NAVIGATION[role].flatMap((group) => group.items.map((item) => item.view));
  return requested && views.includes(requested) ? requested : 'resumen';
}

export function panelViewCopy(role: PanelRole, view: string): { title: string; subtitle: string } {
  const copy: Record<PanelRole, Record<string, { title: string; subtitle: string }>> = {
    ADMIN: {
      resumen: { title: 'Resumen de la empresa', subtitle: 'Lo que requiere atención en la operación actual.' },
      informes: { title: 'Informes de operación', subtitle: 'Cumplimiento, tendencias y evidencia de las rondas.' },
      envios: { title: 'Envíos de correo', subtitle: 'Confirma qué comunicaciones salieron y si llegaron.' },
      personas: { title: 'Personas y acceso', subtitle: 'Administra usuarios, roles y protección de ingreso.' },
      recintos: { title: 'Recintos', subtitle: 'Organiza instalaciones y sus puntos de control.' },
      reglas: { title: 'Reglas de operación', subtitle: 'Define cómo trabaja la empresa y qué evidencia exige.' },
      marca: { title: 'Marca de la empresa', subtitle: 'Controla la identidad que ve tu equipo y reciben tus clientes.' },
      cumplimiento: { title: 'Cumplimiento legal', subtitle: 'Gestiona el consentimiento y audita el uso de ubicación.' },
      sesiones: { title: 'Sesiones activas', subtitle: 'Revisa y revoca dispositivos con acceso a tu cuenta.' },
    },
    SUPERVISOR: {
      resumen: { title: 'Mis recintos', subtitle: 'Estado actual de los recintos que tienes asignados.' },
      planificacion: { title: 'Planificación', subtitle: 'Programa turnos, recorridos y tareas de terreno.' },
      monitoreo: { title: 'Monitoreo en vivo', subtitle: 'Sigue las rondas activas de tus recintos asignados.' },
      informes: { title: 'Informes', subtitle: 'Analiza cumplimiento y revisa rondas por recinto.' },
      consentimiento: { title: 'Mi ubicación', subtitle: 'Revisa el aviso aplicable al trabajo en terreno.' },
      sesiones: { title: 'Sesiones activas', subtitle: 'Revisa y revoca dispositivos con acceso a tu cuenta.' },
    },
    SUPERADMIN: {
      resumen: { title: 'Administración de la plataforma', subtitle: 'Empresas, licencias y acceso a la plataforma.' },
      sesiones: { title: 'Sesiones activas', subtitle: 'Revisa y revoca dispositivos con acceso a tu cuenta.' },
    },
  };
  return copy[role][view] ?? copy[role].resumen!;
}
