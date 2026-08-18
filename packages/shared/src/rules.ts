import { z } from 'zod';

/**
 * Reglas configurables de SentryCore.
 *
 * Las reglas que dio el cliente (umbral de 70%, foto obligatoria fuera de
 * horario) son EL DEFAULT DE UN CLIENTE, no la ley del producto. Esto es un
 * SaaS: el siguiente cliente va a querer 85% y foto siempre. Por eso todo
 * parametro vive aca con un default sensato y se puede sobreescribir sin deploy.
 *
 * Resolucion en cascada, gana el mas especifico:
 *
 *     plataforma  ->  tenant  ->  recinto  ->  punto
 *
 * Ver issue #16 (Motor de reglas y funciones configurables por tenant).
 */
export const patrolRulesSchema = z.object({
  /** Bajo este porcentaje de cumplimiento, el informe va DIRECTO al admin. */
  complianceThreshold: z.number().int().min(0).max(100).default(70),

  /**
   * Fuera del horario habil del recinto, la foto es obligatoria en todo punto.
   *
   * Default `false` por decision de producto (8-ago-2026, ver #13): la foto la
   * exige una TAREA —hoy, el punto critico o el override del punto; manana, el
   * checklist—, no el reloj. Una ronda nocturna de 40 puntos con 40 fotos por
   * vuelta convierte la evidencia en tramite. La regla queda disponible para la
   * empresa que quiera el comportamiento anterior: es cascada, no codigo.
   */
  photoRequiredOutsideHours: z.boolean().default(false),

  /** En accesos, puertas y porterias la foto es obligatoria siempre. */
  photoRequiredOnCritical: z.boolean().default(true),

  /**
   * Recinto SIN horario definido en site_business_hours (#13): true = se
   * considera en horario habil (solo los puntos criticos exigen foto); false =
   * se considera fuera de horario (foto obligatoria en todo punto). El default
   * evita exigir foto en todo al tenant que aun no configura sus horarios.
   */
  businessHoursDefaultOpen: z.boolean().default(true),

  /**
   * OBLIGATORIO vs OPCIONAL. NO es un interruptor de encendido y apagado.
   *
   *   true  = compartir la ubicacion es obligatorio: quien niega el permiso del
   *           telefono no puede iniciar la ronda.
   *   false = es opcional: negarse no impide trabajar, y a quien acepta se le
   *           registra el recorrido IGUAL.
   *
   * El interruptor de "esta empresa no registra la ubicacion de nadie" es
   * gpsTrackingEnabled, que es otra regla y esta mas abajo.
   *
   * Se llamaba gpsSharingRequired y tres personas distintas lo leyeron como
   * interruptor: el aviso de consentimiento le decia al trabajador que no se
   * registraba su ubicacion mientras el servidor si la registraba, el informe en
   * PDF salia sin trayecto y el tablero en vivo escondia guardias que si estaban
   * compartiendo. El dato guardado se movio en la migracion 1725994800000.
   */
  gpsSharingMandatory: z.boolean().default(true),

  /** Radio en metros para aceptar que un escaneo se hizo realmente en el punto. */
  gpsValidationRadiusM: z.number().int().min(5).max(1000).default(50),

  /**
   * Velocidad implicada entre dos escaneos seguidos (distancia entre las
   * coordenadas FIJAS de los puntos sobre el tiempo del servidor) por encima
   * de la cual el segundo escaneo se marca `velocidad_imposible` (#60).
   *
   * Es LA señal del fraude conocido del rubro: el guardia que se lleva las
   * etiquetas a la caseta y las escanea todas juntas. Se mide entre puntos y
   * no entre posiciones GPS a proposito — las etiquetas no se mueven, asi que
   * un GPS impreciso en un subterraneo no puede fabricar la anomalia ni
   * taparla. 15 km/h es trote sostenido: nadie recorre una ronda mas rapido
   * caminando, y el que "recorre" 1 km en 10 segundos esta sentado.
   */
  impossibleSpeedKmh: z.number().int().min(5).max(100).default(15),

  /**
   * Cada cuantos segundos muestrea la posicion la app durante la ronda. Lo lee
   * el dispositivo: el intervalo no se codifica en el cliente. Mas frecuente =
   * traza mas fiel y bateria mas corta.
   */
  gpsTrackIntervalSeconds: z.number().int().min(15).max(900).default(60),

  /**
   * Dias que se conserva la traza del recorrido. Mucho mas corta que la
   * retencion de fotos a proposito: la traza es mas invasiva y mucho mas
   * voluminosa (un punto por minuto son ~480 filas por turno de 8 horas).
   */
  gpsTrackRetentionDays: z.number().int().min(7).max(365).default(90),

  /**
   * Segundos sin una posicion utilizable a partir de los cuales el tramo cuenta
   * como hueco de cobertura de la traza (#134). El servidor nunca lo aplica por
   * debajo de DOS intervalos de muestreo, y el intervalo de referencia es el mas
   * largo que la app puede usar (el de ahorro de bateria): con el umbral pegado
   * al intervalo, cada muestra del modo ahorro seria un hueco.
   */
  gpsTrackGapMinSeconds: z.number().int().min(60).max(3600).default(600),

  /**
   * Segundos dentro del radio a partir de los cuales se declara tiempo detenido
   * (#134). Detenerse es parte del trabajo: el umbral no mide quietud, mide
   * permanencia. Mismo piso de dos intervalos que el hueco.
   */
  gpsTrackStopMinSeconds: z.number().int().min(60).max(3600).default(600),

  /**
   * Radio en metros dentro del cual se considera que el guardia no se movio
   * (#134). Un telefono quieto igual entrega posiciones que bailan varios
   * metros; sin este radio, "detenido" no se detecta nunca.
   */
  gpsTrackStopRadiusM: z.number().int().min(5).max(200).default(25),

  /**
   * Orden aleatorio anti-predictibilidad.
   *
   * En vigilancia una ronda siempre igual es una ronda predecible, y la
   * predictibilidad es exactamente lo que explota quien quiere entrar: sabe que
   * el guardia pasa por la bodega a las 23:40 y vuelve en 45 minutos. Es una
   * funcion de SEGURIDAD, no una preferencia estetica.
   */
  randomizeRouteOrder: z.boolean().default(false),

  /** Enviar el informe automaticamente al escanear el punto de cierre. */
  autoSendReportOnClose: z.boolean().default(true),

  /**
   * Permitir QR como respaldo cuando el NFC falla o el telefono no lo tiene.
   * El escaneo queda marcado con su metodo: un QR se puede fotografiar y reusar,
   * una etiqueta NFC hay que ir a tocarla.
   */
  allowQrFallback: z.boolean().default(true),

  /**
   * Maximo de operaciones por lote de sincronizacion offline (#14). Una ronda
   * completa en un subterraneo son decenas de escaneos y novedades; el limite
   * protege al servidor sin castigar al guardia, que reenvia el resto en el
   * lote siguiente.
   */
  syncMaxBatchSize: z.number().int().min(1).max(1000).default(200),

  /**
   * Criticidades que disparan la cadena de escalamiento (#126). Antes estaba
   * fijo en el codigo; hay empresas que quieren que 'media' despierte al
   * supervisor y otras que no.
   */
  escalationCriticalities: z
    .array(z.enum(['media', 'alta', 'panico']))
    .default(['alta', 'panico']),

  /**
   * Un item de checklist marcado como falla avisa por correo al supervisor
   * del recinto (#129). El aviso en vivo de la bandeja no depende de esto.
   */
  checklistFailureNotify: z.boolean().default(true),

  /**
   * Minutos que espera la cadena antes de subir al nivel siguiente cuando la
   * politica de ese nivel no define un delay propio.
   */
  escalationDefaultDelayMin: z.number().int().min(0).max(1440).default(10),

  /** Minutos tras los cuales una ronda sin cerrar se marca como vencida. */
  maxPatrolDurationMin: z.number().int().min(5).max(1440).default(480),

  /**
   * Correos que reciben ADEMAS del admin cada informe de ronda (#81). Vacio =
   * solo los admin del tenant. Es una lista y no un correo unico porque en la
   * practica el informe lo quiere tambien el jefe de operaciones del cliente
   * final, que no es usuario del sistema.
   *
   * No se puede fijar a nivel plataforma: un destinatario global recibiria los
   * informes de TODAS las empresas. Ver PATROL_RULE_CATALOG.reportRecipients.
   */
  reportRecipients: z.array(z.string().email()).max(10).default([]),

  /** Dias que se conserva la evidencia fotografica. */
  photoRetentionDays: z.number().int().min(30).max(3650).default(365),

  /** Tamaño maximo de cada foto de evidencia, en megabytes (#13). */
  photoMaxSizeMB: z.number().int().min(1).max(50).default(10),
  /**
   * Peso al que el telefono COMPRIME la foto antes de subirla, en kilobytes.
   *
   * Es distinto de photoMaxSizeMB, que es el techo que el servidor acepta. Este
   * es el objetivo del cliente y siempre es menor: comprimir hasta el techo
   * dejaria subidas de megas en un perimetro sin cobertura.
   *
   * Mas alto es mas nitido y mas lento de subir donde hay poca señal; mas bajo
   * sube siempre pero puede no dejar leer el estado de una cerradura. Por eso lo
   * elige el admin y no el codigo: una bodega con fibra y un perimetro rural no
   * quieren lo mismo.
   */
  photoUploadTargetKB: z.number().int().min(100).max(5_000).default(500),

  /** Intentos de login fallidos antes de bloquear temporalmente. */
  /**
   * Interruptor general del seguimiento de recorrido (#77). Apagado, no se
   * guarda ni un punto para NADIE, aunque haya consentido.
   *
   * Es distinto de gpsSharingMandatory, que decide obligatorio vs OPCIONAL:
   * opcional NO es apagado. A quien acepta se le registra el recorrido y a
   * quien no, no, y ninguno queda impedido de trabajar.
   */
  gpsTrackingEnabled: z.boolean().default(true),
  /**
   * Tope de filas por hoja de la exportacion a Excel (#136). Si el periodo trae
   * mas, la planilla sale cortada y lo avisa en la portada: mejor eso que un
   * archivo que el navegador no puede abrir.
   */
  excelExportMaxRows: z.number().int().min(1_000).max(200_000).default(50_000),
  /** Minutos con cosas sin sincronizar antes de avisarle al guardia (#74). */
  syncPendingWarnMin: z.number().int().min(1).max(240).default(15),
  /** Si marcar salida con trabajo sin sincronizar exige confirmar dos veces (#74). */
  syncConfirmShiftEndWithPending: z.boolean().default(true),
  /** Desfase de reloj del telefono que se tolera sin marcar el escaneo (#73). */
  clockSkewToleranceMin: z.number().int().min(1).max(120).default(5),
  /** Minutos tras el cierre en que una marca atrasada aun se acepta (#73). */
  lateScanGraceMin: z.number().int().min(0).max(1440).default(120),
  /** Margen fuera de turno que NO cuenta como rastreo indebido (#78). */
  consentOffShiftToleranceMin: z.number().int().min(0).max(60).default(5),
  /** Si una politica de privacidad nueva obliga a aceptar de nuevo (#78). */
  consentReacceptOnNewPolicy: z.boolean().default(true),
  /** Si el informe de ronda incluye el mapa del recorrido (#79). */
  reportIncludeMap: z.boolean().default(true),
  /** Precision peor que esta descarta el punto del trazo del mapa (#79). */
  mapTrackMaxAccuracyM: z.number().int().min(5).max(500).default(100),
  /** Tope de puntos del trazo: un mapa con miles de puntos no se lee (#79). */
  mapMaxTrackPoints: z.number().int().min(50).max(5000).default(500),

  /* ------------------------------------------------------------------ *
   * Forma del informe de ronda (#308)
   *
   * El informe pasa a leerse como una bitacora cronologica. Que se muestre y
   * que no es decision del CLIENTE, no del producto: uno va a querer el informe
   * sin la palabra Confidencial y otro sin fotos incrustadas porque le pesa el
   * correo. Ninguna de estas cuatro puede quedar como constante en el renderer.
   * ------------------------------------------------------------------ */

  /** Estampa la palabra CONFIDENCIAL en la portada del informe (#308). */
  reportConfidentialLabel: z.boolean().default(true),
  /**
   * Bitacora cronologica en el informe de ronda (#308). Apagada, el informe
   * vuelve a ser la pila de tablas de antes: puntos, tareas e incidentes cada
   * uno en su seccion.
   */
  reportTimeline: z.boolean().default(true),
  /**
   * Las fotos se incrustan dentro de la bitacora, donde ocurrieron (#308).
   * Apagada, la bitacora igual menciona cada evidencia con su hora y su huella,
   * y la imagen sale solo en el anexo.
   */
  reportInlinePhotos: z.boolean().default(true),
  /**
   * Tope de entradas dibujadas en la bitacora (#308). Pasado el tope se corta
   * con una linea que dice cuantas se omitieron; el resto del informe sigue
   * completo. Una ronda de 40 puntos con checklist puede pasar las 300 entradas
   * y un PDF de 60 paginas no lo lee nadie.
   */
  reportTimelineMaxEntries: z.number().int().min(50).max(2000).default(400),

  /**
   * Minutos de anticipacion con que se le avisa al guardia que su ronda esta por
   * comenzar (#43). 0 = la empresa apago el recordatorio, que no es lo mismo que
   * avisar al instante. El techo lo mira tambien el barrido cruza-empresas
   * (AVISO_INICIO_MAX_ANTICIPACION_MIN): si suben este maximo, sube alla tambien.
   */
  patrolStartNoticeMin: z.number().int().min(0).max(120).default(10),
  /** Tope del PDF adjunto al correo; sobre esto se manda enlace (#86). */
  reportMailMaxAttachmentMB: z.number().int().min(1).max(25).default(8),

  /* ------------------------------------------------------------------ *
   * Plan de muestreo del recorrido (#77)
   *
   * Estos siete vivian como default local en apps/api/src/geo/gps-rules.ts.
   * Mientras no estuvieran declarados aca, `patrolRulesSchema.parse()` DESCARTA
   * la clave que no conoce: el admin escribia el override, el panel lo guardaba
   * y el servidor seguia aplicando el default, sin un solo error. Declararlos es
   * lo que hace que esa configuracion llegue a destino.
   * ------------------------------------------------------------------ */

  /**
   * Metros minimos entre dos puntos para que el telefono registre uno nuevo.
   * Es el ahorro de bateria mas grande de todos: el guardia parado en la garita
   * deja de despertar el GPS. 0 desactiva el filtro y se muestrea solo por
   * tiempo.
   */
  gpsTrackMinDistanceM: z.number().int().min(0).max(500).default(15),

  /**
   * Precision peor que esta (en metros) NO suma distancia recorrida. El punto
   * igual se guarda y se devuelve —es evidencia y explica el hueco de la
   * traza—, pero un salto de GPS en un subterraneo no puede agregar kilometros
   * que nadie camino a un informe que ve el cliente.
   *
   * Es la hermana de `mapTrackMaxAccuracyM` (#79), que decide que se DIBUJA en
   * el mapa del informe. Son dos decisiones distintas sobre el mismo punto —una
   * aritmetica y otra visual— y por eso son dos parametros y no uno.
   */
  gpsTrackMaxAccuracyM: z.number().int().min(5).max(500).default(100),

  /**
   * Puntos que junta el telefono antes de subir el lote. Menos envios = menos
   * veces que se enciende la radio, que es el segundo consumo mas grande
   * despues del GPS.
   *
   * El max NO es decorativo: es lo que acepta de una vez el endpoint de traza
   * (`MAX_PUNTOS_POR_LOTE` en apps/api/src/geo/gps-rules.ts). Un valor mayor se
   * recortaria en silencio al armar el plan.
   */
  gpsTrackBatchSize: z.number().int().min(1).max(500).default(60),

  /** Bajo este porcentaje de bateria se pasa a muestreo espaciado. 0 lo desactiva. */
  gpsTrackLowBatteryPct: z.number().int().min(0).max(50).default(15),

  /**
   * Intervalo en modo ahorro. Que la ronda termine con traza gruesa es mejor
   * que un telefono apagado a mitad del turno: un guardia sin telefono no puede
   * pedir ayuda. Nunca muestrea mas seguido que `gpsTrackIntervalSeconds`; si
   * se configura mas bajo, el plan lo iguala.
   */
  gpsTrackLowBatteryIntervalSeconds: z.number().int().min(15).max(3_600).default(300),

  /**
   * Consumo de bateria aceptable para una ronda completa. La referencia de
   * duracion es `maxPatrolDurationMin`, que ya es la ronda mas larga del
   * tenant: asi el criterio "20% en 8 horas" no se repite como numero suelto.
   */
  gpsBatteryBudgetPct: z.number().int().min(1).max(100).default(20),

  /**
   * Minutos que vale el reporte de permiso de ubicacion del telefono. Vencido
   * se trata como "no reportado", y en modo obligatorio eso bloquea el arranque
   * hasta que la app vuelva a confirmar. 720 = un turno.
   */
  gpsPermissionReportMaxAgeMin: z.number().int().min(15).max(10_080).default(720),
});

export type PatrolRules = z.infer<typeof patrolRulesSchema>;

/** Defaults completos. Un tenant nuevo opera sin configurar nada. */
export const DEFAULT_PATROL_RULES: PatrolRules = patrolRulesSchema.parse({});

/**
 * Modulos que se prenden y apagan por tenant o por plan de licencia.
 *
 * Esto es lo que permite vender planes distintos sin mantener versiones
 * distintas del producto. Un modulo apagado DESAPARECE de la interfaz; no queda
 * visible y bloqueado.
 */
export const featureFlagsSchema = z.object({
  map: z.boolean().default(true),
  chartsBySite: z.boolean().default(true),
  photoAppendix: z.boolean().default(true),
  // RETIRADOS (#286): eran módulos MUERTOS — el admin los prendía/apagaba y no
  // pasaba nada, porque su control real vive en otro lado.
  //   - `incidents`: lo que decide quién registra novedades es el PERMISO
  //     `incidents:create` (RBAC), no un flag de plan.
  //   - `gpsTracking`: era un DUPLICADO de la regla `gpsTrackingEnabled` (más
  //     arriba), que es la que geo/geo.service.ts hace cumplir de verdad.
  // Si el modelo de licencias (#106) los quiere como módulos vendibles, se
  // vuelven a agregar cableados a su gate real, no como toggle decorativo.
  /** Crash reporting. Opcional, fuera del corte de 1 mes. */
  crashReporting: z.boolean().default(false),
});

export type FeatureFlags = z.infer<typeof featureFlagsSchema>;
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = featureFlagsSchema.parse({});

/** Niveles de la cascada, del mas general al mas especifico. */
export const RULE_SCOPES = ['platform', 'tenant', 'site', 'checkpoint'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

/** Overrides por nivel, tal como salen de la base (#80). */
export type RuleOverridesByScope = Partial<Record<RuleScope, Partial<PatrolRules>>>;

/** De donde salio cada valor efectivo. 'default' = ningun nivel lo sobreescribio. */
export type RuleSource = RuleScope | 'default';
export type RuleSources = Record<keyof PatrolRules, RuleSource>;

/**
 * Resuelve la configuracion efectiva aplicando la cascada. El nivel mas
 * especifico gana. La app pide el resultado ya resuelto y no reimplementa esto.
 */
export function resolveRules(overrides: RuleOverridesByScope): PatrolRules {
  return resolveRulesWithSource(overrides).rules;
}

/**
 * Igual que resolveRules(), pero ademas dice QUE nivel gano cada parametro.
 *
 * Lo necesita el panel del admin (#83): sin esto, un valor heredado del tenant y
 * uno escrito en el recinto se ven identicos, y el admin no sabe si lo que edita
 * lo esta creando o lo esta pisando.
 */
export function resolveRulesWithSource(overrides: RuleOverridesByScope): {
  rules: PatrolRules;
  sources: RuleSources;
} {
  const acc: Record<string, unknown> = { ...DEFAULT_PATROL_RULES };
  const sources = Object.fromEntries(
    Object.keys(DEFAULT_PATROL_RULES).map((key) => [key, 'default']),
  ) as RuleSources;

  for (const scope of RULE_SCOPES) {
    const layer = overrides[scope];
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      // undefined no es un override: es "este nivel no opina".
      if (value === undefined) continue;
      acc[key] = value;
      sources[key as keyof PatrolRules] = scope;
    }
  }

  return { rules: patrolRulesSchema.parse(acc), sources };
}

/* ------------------------------------------------------------------ *
 * Catalogo de parametros de ronda (#81)
 *
 * Cada parametro declara tipo, rango, unidad, default y descripcion EN LENGUAJE
 * DEL CLIENTE, mas los niveles de la cascada donde tiene sentido configurarlo.
 * El panel del admin (#83) pinta el formulario leyendo esto: si manana entra una
 * regla nueva, aparece sola en la interfaz. Nada de listas de campos en la web.
 * ------------------------------------------------------------------ */

/** Como se edita el parametro. Determina el control que pinta la interfaz. */
export const RULE_VALUE_TYPES = ['boolean', 'integer', 'email-list', 'multi-select'] as const;
export type RuleValueType = (typeof RULE_VALUE_TYPES)[number];

/** Unidad del valor. Clave estable para la API; la etiqueta se muestra. */
export const RULE_UNITS = [
  'percent',
  'meters',
  'seconds',
  'minutes',
  'days',
  'megabytes',
  'kilobytes',
  'attempts',
  'operations',
  'rows',
  'kmh',
] as const;
export type RuleUnit = (typeof RULE_UNITS)[number];

export const RULE_UNIT_LABELS: Record<RuleUnit, string> = {
  percent: '%',
  meters: 'm',
  seconds: 's',
  minutes: 'min',
  days: 'dias',
  megabytes: 'MB',
  kilobytes: 'KB',
  attempts: 'intentos',
  operations: 'operaciones',
  rows: 'filas',
  kmh: 'km/h',
};

/** Agrupacion para la interfaz. No cambia el comportamiento. */
export const RULE_GROUPS = [
  'cumplimiento',
  'evidencia',
  'ubicacion',
  'operacion',
  'avisos',
  'retencion',
  'seguridad',
] as const;
export type RuleGroup = (typeof RULE_GROUPS)[number];

export const RULE_GROUP_LABELS: Record<RuleGroup, string> = {
  cumplimiento: 'Cumplimiento de rondas',
  evidencia: 'Evidencia fotografica',
  ubicacion: 'Ubicacion y GPS',
  operacion: 'Operacion en terreno',
  avisos: 'Avisos y escalamiento',
  retencion: 'Retencion de datos',
  seguridad: 'Seguridad de acceso',
};

/**
 * Un array de solo lectura tambien sirve como default: asi el catalogo puede ser
 * literal sin pelear con el tipo mutable que infiere zod.
 */
type RuleDefault<K extends keyof PatrolRules> = PatrolRules[K] extends ReadonlyArray<infer T>
  ? readonly T[]
  : PatrolRules[K];

export interface RuleParameter<K extends keyof PatrolRules = keyof PatrolRules> {
  key: K;
  /** Nombre corto para el formulario. */
  label: string;
  /** Que hace, en lenguaje del cliente y no tecnico (#81). */
  description: string;
  type: RuleValueType;
  unit: RuleUnit | null;
  /** Solo para type 'integer'. Espejo del rango que valida patrolRulesSchema. */
  min?: number;
  max?: number;
  /** Solo para type 'multi-select'. */
  options?: readonly string[];
  /** Solo para type 'email-list'. */
  maxItems?: number;
  default: RuleDefault<K>;
  /** Niveles donde el parametro se puede sobreescribir, de general a especifico. */
  scopes: readonly RuleScope[];
  group: RuleGroup;
}

export type AnyRuleParameter = RuleParameter<keyof PatrolRules>;

/**
 * El tipo obliga a que TODO parametro de patrolRulesSchema tenga ficha y a que
 * no sobre ninguna: agregar una regla sin describirla no compila. Es la garantia
 * de que la interfaz del admin nunca queda con un campo sin explicacion.
 */
type RuleCatalog = { [K in keyof PatrolRules]: RuleParameter<K> };

const TODOS_LOS_NIVELES = RULE_SCOPES;
const HASTA_RECINTO = ['platform', 'tenant', 'site'] as const;
const SOLO_EMPRESA = ['platform', 'tenant'] as const;

export const PATROL_RULE_CATALOG: RuleCatalog = {
  complianceThreshold: {
    key: 'complianceThreshold',
    label: 'Umbral de cumplimiento',
    description:
      'Si la ronda termina bajo este porcentaje de puntos marcados, el informe llega directo al administrador de la empresa.',
    type: 'integer',
    unit: 'percent',
    min: 0,
    max: 100,
    default: DEFAULT_PATROL_RULES.complianceThreshold,
    // Por punto no tiene sentido: el cumplimiento se mide sobre la ronda completa.
    scopes: HASTA_RECINTO,
    group: 'cumplimiento',
  },
  photoRequiredOutsideHours: {
    key: 'photoRequiredOutsideHours',
    label: 'Foto obligatoria fuera de horario',
    description:
      'Fuera del horario habil del recinto, el guardia debe fotografiar cada punto que marca. ' +
      'Apagada de fabrica: la foto la exigen los accesos criticos y los puntos que la piden, no el reloj.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.photoRequiredOutsideHours,
    scopes: TODOS_LOS_NIVELES,
    group: 'evidencia',
  },
  photoRequiredOnCritical: {
    key: 'photoRequiredOnCritical',
    label: 'Foto obligatoria en accesos criticos',
    description:
      'En accesos, puertas y porterias la foto es obligatoria a cualquier hora, aunque el recinto este abierto.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.photoRequiredOnCritical,
    scopes: TODOS_LOS_NIVELES,
    group: 'evidencia',
  },
  businessHoursDefaultOpen: {
    key: 'businessHoursDefaultOpen',
    label: 'Recinto sin horario cargado cuenta como abierto',
    description:
      'Mientras el recinto no tenga su horario cargado, se asume abierto (solo los accesos criticos piden foto). Apagado, se asume cerrado y se pide foto en todos los puntos.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.businessHoursDefaultOpen,
    // El horario en si vive por recinto en site_business_hours (#13); esto es
    // solo que hacer mientras ese horario no existe.
    scopes: HASTA_RECINTO,
    group: 'evidencia',
  },
  gpsSharingMandatory: {
    key: 'gpsSharingMandatory',
    label: 'Exigir permiso de ubicacion',
    description:
      'Encendido, compartir la ubicacion es obligatorio: quien no acepta el permiso del telefono no puede iniciar la ronda. Apagado, compartir es opcional: negarse no impide trabajar, y a quien acepta se le registra el recorrido igual. No lo confundas con "Registrar el recorrido": esa regla apaga la ubicacion para todos; esta solo decide si es obligatoria o voluntaria.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.gpsSharingMandatory,
    scopes: HASTA_RECINTO,
    group: 'ubicacion',
  },
  gpsValidationRadiusM: {
    key: 'gpsValidationRadiusM',
    label: 'Radio de validacion del escaneo',
    description:
      'Distancia maxima entre el guardia y el punto para dar el escaneo por hecho en el lugar. Subelo en subterraneos y bodegas, donde el GPS se equivoca mas.',
    type: 'integer',
    unit: 'meters',
    min: 5,
    max: 1000,
    default: DEFAULT_PATROL_RULES.gpsValidationRadiusM,
    // Por punto si aplica: el estacionamiento subterraneo necesita mas margen
    // que la porteria de la entrada.
    scopes: TODOS_LOS_NIVELES,
    group: 'ubicacion',
  },
  impossibleSpeedKmh: {
    key: 'impossibleSpeedKmh',
    label: 'Velocidad imposible entre puntos',
    description:
      'Si entre dos escaneos seguidos la velocidad implicada (distancia entre los puntos sobre el tiempo transcurrido) supera este valor, el escaneo queda marcado como velocidad imposible. Es la señal del guardia que escanea etiquetas sueltas sin recorrer. Marca, no rechaza.',
    type: 'integer',
    unit: 'kmh',
    min: 5,
    max: 100,
    default: DEFAULT_PATROL_RULES.impossibleSpeedKmh,
    scopes: HASTA_RECINTO,
    group: 'seguridad',
  },
  gpsTrackIntervalSeconds: {
    key: 'gpsTrackIntervalSeconds',
    label: 'Frecuencia de la traza de recorrido',
    description:
      'Cada cuanto el telefono registra la posicion durante la ronda. Mas seguido = recorrido mas fiel y bateria mas corta.',
    type: 'integer',
    unit: 'seconds',
    min: 15,
    max: 900,
    default: DEFAULT_PATROL_RULES.gpsTrackIntervalSeconds,
    scopes: HASTA_RECINTO,
    group: 'ubicacion',
  },
  gpsTrackRetentionDays: {
    key: 'gpsTrackRetentionDays',
    label: 'Retencion de la traza de recorrido',
    description:
      'Dias que se guarda el recorrido del guardia antes de borrarlo. Es un dato sensible de la persona: mientras menos tiempo se guarde, mejor.',
    type: 'integer',
    unit: 'days',
    min: 7,
    max: 365,
    default: DEFAULT_PATROL_RULES.gpsTrackRetentionDays,
    // La retencion es una politica legal de la empresa completa, no de un recinto.
    scopes: SOLO_EMPRESA,
    group: 'retencion',
  },
  gpsTrackGapMinSeconds: {
    key: 'gpsTrackGapMinSeconds',
    label: 'Hueco de cobertura del recorrido',
    description:
      'Cuanto puede pasar sin que el telefono entregue una posicion utilizable antes de marcar ese tramo como recorrido sin registro. Subelo en recintos con subterraneos o bodegas, donde perder la senal es normal.',
    type: 'integer',
    unit: 'seconds',
    min: 60,
    max: 3600,
    default: DEFAULT_PATROL_RULES.gpsTrackGapMinSeconds,
    scopes: HASTA_RECINTO,
    group: 'ubicacion',
  },
  gpsTrackStopMinSeconds: {
    key: 'gpsTrackStopMinSeconds',
    label: 'Tiempo para contar una detencion',
    description:
      'Cuanto tiene que quedarse el guardia en el mismo lugar para que el informe lo cuente como una detencion. Revisar una puerta toma un minuto; quedarse veinte es otra cosa.',
    type: 'integer',
    unit: 'seconds',
    min: 60,
    max: 3600,
    default: DEFAULT_PATROL_RULES.gpsTrackStopMinSeconds,
    scopes: HASTA_RECINTO,
    group: 'ubicacion',
  },
  gpsTrackStopRadiusM: {
    key: 'gpsTrackStopRadiusM',
    label: 'Radio para considerar que no se movio',
    description:
      'Cuantos metros puede moverse el guardia sin que deje de contarse como detenido. Existe porque un telefono quieto igual reporta posiciones que se mueven solas.',
    type: 'integer',
    unit: 'meters',
    min: 5,
    max: 200,
    default: DEFAULT_PATROL_RULES.gpsTrackStopRadiusM,
    scopes: HASTA_RECINTO,
    group: 'ubicacion',
  },
  randomizeRouteOrder: {
    key: 'randomizeRouteOrder',
    label: 'Orden aleatorio de la ronda',
    description:
      'Presenta los puntos en orden distinto cada vez para que la ronda no sea predecible. Una ronda siempre igual es la que aprovecha quien quiere entrar.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.randomizeRouteOrder,
    scopes: HASTA_RECINTO,
    group: 'operacion',
  },
  autoSendReportOnClose: {
    key: 'autoSendReportOnClose',
    label: 'Enviar el informe al cerrar la ronda',
    description:
      'Al marcar el ultimo punto, el informe se genera y se envia solo, sin que nadie tenga que pedirlo.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.autoSendReportOnClose,
    scopes: HASTA_RECINTO,
    group: 'operacion',
  },
  allowQrFallback: {
    key: 'allowQrFallback',
    label: 'Permitir QR como respaldo',
    description:
      'Deja marcar el punto con QR cuando la etiqueta NFC falla o el telefono no tiene NFC. El escaneo queda marcado como QR: una foto del QR se puede reusar, la etiqueta hay que ir a tocarla.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.allowQrFallback,
    // Por punto: sirve para habilitarlo solo donde la etiqueta esta fallando.
    scopes: TODOS_LOS_NIVELES,
    group: 'operacion',
  },
  syncMaxBatchSize: {
    key: 'syncMaxBatchSize',
    label: 'Tamano maximo de sincronizacion',
    description:
      'Cuantos registros manda el telefono de una vez cuando recupera senal despues de una ronda sin cobertura. El resto viaja en el envio siguiente.',
    type: 'integer',
    unit: 'operations',
    min: 1,
    max: 1000,
    default: DEFAULT_PATROL_RULES.syncMaxBatchSize,
    scopes: SOLO_EMPRESA,
    group: 'operacion',
  },
  escalationCriticalities: {
    key: 'escalationCriticalities',
    label: 'Criticidades que escalan',
    description:
      'Que nivel de novedad despierta la cadena de avisos hasta que alguien acuse recibo.',
    type: 'multi-select',
    unit: null,
    options: ['media', 'alta', 'panico'],
    default: DEFAULT_PATROL_RULES.escalationCriticalities,
    scopes: HASTA_RECINTO,
    group: 'avisos',
  },
  checklistFailureNotify: {
    key: 'checklistFailureNotify',
    label: 'Avisar por correo las fallas de checklist',
    description:
      'Cuando el guardia marca un item de checklist como falla, el supervisor del recinto recibe un correo.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.checklistFailureNotify,
    scopes: HASTA_RECINTO,
    group: 'avisos',
  },
  escalationDefaultDelayMin: {
    key: 'escalationDefaultDelayMin',
    label: 'Espera entre niveles de aviso',
    description:
      'Cuanto espera el sistema a que alguien acuse recibo antes de avisar al nivel siguiente.',
    type: 'integer',
    unit: 'minutes',
    min: 0,
    max: 1440,
    default: DEFAULT_PATROL_RULES.escalationDefaultDelayMin,
    scopes: HASTA_RECINTO,
    group: 'avisos',
  },
  maxPatrolDurationMin: {
    key: 'maxPatrolDurationMin',
    label: 'Duracion maxima de una ronda',
    description:
      'Pasado este tiempo sin cerrarse, la ronda se marca como vencida y deja de aceptar escaneos.',
    type: 'integer',
    unit: 'minutes',
    min: 5,
    max: 1440,
    default: DEFAULT_PATROL_RULES.maxPatrolDurationMin,
    scopes: HASTA_RECINTO,
    group: 'operacion',
  },
  reportRecipients: {
    key: 'reportRecipients',
    label: 'Destinatarios del informe',
    description:
      'Correos que reciben cada informe ademas de los administradores de la empresa. Vacio: solo los administradores.',
    type: 'email-list',
    unit: null,
    maxItems: 10,
    default: DEFAULT_PATROL_RULES.reportRecipients,
    // A proposito SIN 'platform': un destinatario global recibiria los informes
    // de todas las empresas del SaaS. Eso es una fuga cruzada, no una comodidad.
    scopes: ['tenant', 'site'],
    group: 'avisos',
  },
  photoRetentionDays: {
    key: 'photoRetentionDays',
    label: 'Retencion de fotos',
    description:
      'Dias que se guarda la evidencia fotografica antes de borrarla.',
    type: 'integer',
    unit: 'days',
    min: 30,
    max: 3650,
    default: DEFAULT_PATROL_RULES.photoRetentionDays,
    scopes: SOLO_EMPRESA,
    group: 'retencion',
  },
  photoUploadTargetKB: {
    key: 'photoUploadTargetKB',
    label: 'Peso objetivo de la foto al subir',
    description:
      'A que peso comprime el telefono la foto antes de subirla. Mas alto se ve mejor y sube mas lento donde hay poca señal; mas bajo sube siempre pero puede no dejar leer el detalle.',
    type: 'integer',
    unit: 'kilobytes',
    min: 100,
    max: 5000,
    default: DEFAULT_PATROL_RULES.photoUploadTargetKB,
    scopes: HASTA_RECINTO,
    group: 'evidencia',
  },
  photoMaxSizeMB: {
    key: 'photoMaxSizeMB',
    label: 'Peso maximo por foto',
    description:
      'Tamano maximo de cada foto de evidencia. Mas alto es mas nitido y mas lento de subir donde hay poca senal.',
    type: 'integer',
    unit: 'megabytes',
    min: 1,
    max: 50,
    default: DEFAULT_PATROL_RULES.photoMaxSizeMB,
    scopes: SOLO_EMPRESA,
    group: 'evidencia',
  },
  excelExportMaxRows: {
    key: 'excelExportMaxRows',
    label: 'Tope de filas por hoja del Excel',
    description:
      'Cuantas filas como maximo trae cada hoja de la exportacion a Excel. Si el periodo pedido trae mas, la planilla sale cortada y lo avisa en la portada.',
    type: 'integer',
    unit: 'rows',
    min: 1000,
    max: 200000,
    default: DEFAULT_PATROL_RULES.excelExportMaxRows,
    // Por recinto no tiene sentido: una exportacion puede cruzar varios.
    scopes: SOLO_EMPRESA,
    group: 'operacion',
  },
  gpsTrackingEnabled: {
    key: 'gpsTrackingEnabled',
    label: 'Registrar el recorrido',
    description:
      'Apagado, no se guarda ninguna ubicacion de nadie, haya aceptado o no. Es distinto de "Exigir permiso de ubicacion": esa regla solo decide si compartir es obligatorio o voluntario, y en modo opcional se sigue registrando el recorrido de quien acepta.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.gpsTrackingEnabled,
    scopes: SOLO_EMPRESA,
    group: 'ubicacion',
  },
  syncPendingWarnMin: {
    key: 'syncPendingWarnMin',
    label: 'Aviso por trabajo sin sincronizar',
    description:
      'Cuanto puede quedar algo sin subir antes de avisarle al guardia. Un perimetro sin cobertura tolera media hora; una porteria con wifi, no.',
    type: 'integer',
    unit: 'minutes',
    min: 1,
    max: 240,
    default: DEFAULT_PATROL_RULES.syncPendingWarnMin,
    scopes: HASTA_RECINTO,
    group: 'operacion',
  },
  syncConfirmShiftEndWithPending: {
    key: 'syncConfirmShiftEndWithPending',
    label: 'Confirmar la salida si queda algo sin subir',
    description:
      'Pide confirmar dos veces antes de marcar la salida cuando todavia hay escaneos o fotos sin sincronizar.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.syncConfirmShiftEndWithPending,
    scopes: SOLO_EMPRESA,
    group: 'operacion',
  },
  clockSkewToleranceMin: {
    key: 'clockSkewToleranceMin',
    label: 'Desfase de reloj tolerado',
    description:
      'Cuanto puede estar desajustado el reloj del telefono sin que el escaneo quede marcado para revision.',
    type: 'integer',
    unit: 'minutes',
    min: 1,
    max: 120,
    default: DEFAULT_PATROL_RULES.clockSkewToleranceMin,
    scopes: SOLO_EMPRESA,
    group: 'operacion',
  },
  lateScanGraceMin: {
    key: 'lateScanGraceMin',
    label: 'Margen para marcas atrasadas',
    description:
      'Cuanto despues del cierre de la ronda se sigue aceptando un escaneo que llego tarde por falta de senal.',
    type: 'integer',
    unit: 'minutes',
    min: 0,
    max: 1440,
    default: DEFAULT_PATROL_RULES.lateScanGraceMin,
    scopes: HASTA_RECINTO,
    group: 'operacion',
  },
  consentOffShiftToleranceMin: {
    key: 'consentOffShiftToleranceMin',
    label: 'Margen de ubicacion fuera de turno',
    description:
      'Minutos alrededor del turno en que recibir ubicacion no se considera rastreo fuera de horario.',
    type: 'integer',
    unit: 'minutes',
    min: 0,
    max: 60,
    default: DEFAULT_PATROL_RULES.consentOffShiftToleranceMin,
    scopes: SOLO_EMPRESA,
    group: 'ubicacion',
  },
  consentReacceptOnNewPolicy: {
    key: 'consentReacceptOnNewPolicy',
    label: 'Volver a pedir consentimiento al cambiar la politica',
    description:
      'Si al publicar una politica de privacidad nueva cada trabajador debe aceptarla otra vez.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.consentReacceptOnNewPolicy,
    scopes: SOLO_EMPRESA,
    group: 'ubicacion',
  },
  reportIncludeMap: {
    key: 'reportIncludeMap',
    label: 'Incluir el mapa del recorrido en el informe',
    description: 'Agrega al PDF el trazo del recorrido con los puntos escaneados.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.reportIncludeMap,
    scopes: HASTA_RECINTO,
    group: 'ubicacion',
  },
  mapTrackMaxAccuracyM: {
    key: 'mapTrackMaxAccuracyM',
    label: 'Precision minima del trazo',
    description:
      'Los puntos con precision peor que esta no se dibujan: ensucian el mapa sin aportar.',
    type: 'integer',
    unit: 'meters',
    min: 5,
    max: 500,
    default: DEFAULT_PATROL_RULES.mapTrackMaxAccuracyM,
    scopes: HASTA_RECINTO,
    group: 'ubicacion',
  },
  mapMaxTrackPoints: {
    key: 'mapMaxTrackPoints',
    label: 'Puntos maximos del trazo',
    description: 'Tope de puntos dibujados en el mapa del informe. Un trazo de miles no se lee.',
    type: 'integer',
    unit: null,
    min: 50,
    max: 5000,
    default: DEFAULT_PATROL_RULES.mapMaxTrackPoints,
    scopes: SOLO_EMPRESA,
    group: 'ubicacion',
  },
  reportConfidentialLabel: {
    key: 'reportConfidentialLabel',
    label: 'Marcar el informe como confidencial',
    description:
      'Estampa la palabra Confidencial en la portada del informe de ronda. Algunas empresas la exigen y otras la prohiben en documentos que entregan a terceros.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.reportConfidentialLabel,
    scopes: SOLO_EMPRESA,
    group: 'operacion',
  },
  reportTimeline: {
    key: 'reportTimeline',
    label: 'Informe como bitacora cronologica',
    description:
      'El informe cuenta la ronda hora por hora: cada marca, la respuesta de cada tarea y cada novedad en el orden en que ocurrieron. Apagado, el informe vuelve a listar cada cosa en su propia tabla.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.reportTimeline,
    scopes: HASTA_RECINTO,
    group: 'operacion',
  },
  reportInlinePhotos: {
    key: 'reportInlinePhotos',
    label: 'Fotos dentro de la bitacora',
    description:
      'Cada fotografia se muestra en el momento de la ronda en que se tomo, y no solo en el anexo del final. Apagado, la bitacora igual deja constancia de la evidencia con su hora y su huella.',
    type: 'boolean',
    unit: null,
    default: DEFAULT_PATROL_RULES.reportInlinePhotos,
    scopes: HASTA_RECINTO,
    group: 'evidencia',
  },
  reportTimelineMaxEntries: {
    key: 'reportTimelineMaxEntries',
    label: 'Maximo de anotaciones en la bitacora',
    description:
      'Tope de anotaciones que se dibujan en la bitacora del informe. Pasado el tope el informe dice cuantas quedaron fuera; el resto del documento sale completo.',
    type: 'integer',
    unit: null,
    min: 50,
    max: 2000,
    default: DEFAULT_PATROL_RULES.reportTimelineMaxEntries,
    scopes: SOLO_EMPRESA,
    group: 'operacion',
  },
  reportMailMaxAttachmentMB: {
    key: 'reportMailMaxAttachmentMB',
    label: 'Tamano maximo del informe adjunto',
    description:
      'Sobre este tamano el correo lleva un enlace en vez del PDF: los servidores rebotan adjuntos grandes.',
    type: 'integer',
    unit: 'megabytes',
    min: 1,
    max: 25,
    default: DEFAULT_PATROL_RULES.reportMailMaxAttachmentMB,
    scopes: SOLO_EMPRESA,
    group: 'avisos',
  },
  patrolStartNoticeMin: {
    key: 'patrolStartNoticeMin',
    label: 'Aviso de inicio de ronda',
    description:
      'Minutos antes de la hora programada en que le llega al guardia el aviso de que su ronda esta por comenzar. En cero, no se le avisa.',
    type: 'integer',
    unit: 'minutes',
    min: 0,
    max: 120,
    default: DEFAULT_PATROL_RULES.patrolStartNoticeMin,
    // Por recinto si tiene sentido: no es lo mismo un relevo en la porteria que
    // un perimetro donde el guardia camina quince minutos hasta el primer punto.
    // Por punto no: el aviso es de la ronda completa.
    scopes: HASTA_RECINTO,
    group: 'avisos',
  },
  gpsTrackMinDistanceM: {
    key: 'gpsTrackMinDistanceM',
    label: 'Distancia minima entre puntos del recorrido',
    description:
      'Cuanto tiene que moverse el guardia para que el telefono registre otro punto. Es el mayor ahorro de bateria de todos: parado en la garita deja de despertar el GPS. En cero registra solo por tiempo.',
    type: 'integer',
    unit: 'meters',
    min: 0,
    max: 500,
    default: DEFAULT_PATROL_RULES.gpsTrackMinDistanceM,
    // Por recinto si aplica: un perimetro de veinte hectareas y una torre de
    // oficinas no necesitan el mismo paso.
    scopes: HASTA_RECINTO,
    group: 'ubicacion',
  },
  gpsTrackMaxAccuracyM: {
    key: 'gpsTrackMaxAccuracyM',
    label: 'Precision minima para contar distancia',
    description:
      'Los puntos con precision peor que esta no suman distancia recorrida, aunque igual se guardan y se muestran. Es la pareja de la precision minima del trazo: esta manda en los kilometros del informe y la otra en lo que se dibuja en el mapa.',
    type: 'integer',
    unit: 'meters',
    min: 5,
    max: 500,
    default: DEFAULT_PATROL_RULES.gpsTrackMaxAccuracyM,
    // Los mismos niveles que la precision del trazo del mapa: el subterraneo se
    // configura distinto que la porteria, y en la practica se editan juntas.
    scopes: HASTA_RECINTO,
    group: 'ubicacion',
  },
  gpsTrackBatchSize: {
    key: 'gpsTrackBatchSize',
    label: 'Puntos por envio del recorrido',
    description:
      'Cuantos puntos junta el telefono antes de subirlos. Mientras mas junte, menos veces enciende la radio y menos bateria gasta; en contra, el recorrido tarda mas en aparecer en el panel.',
    type: 'integer',
    unit: 'operations',
    min: 1,
    // El tope es lo que acepta el endpoint de traza de una vez, no una
    // preferencia: MAX_PUNTOS_POR_LOTE en apps/api/src/geo/gps-rules.ts, con un
    // test que amarra los dos numeros.
    max: 500,
    default: DEFAULT_PATROL_RULES.gpsTrackBatchSize,
    scopes: SOLO_EMPRESA,
    group: 'ubicacion',
  },
  gpsTrackLowBatteryPct: {
    key: 'gpsTrackLowBatteryPct',
    label: 'Bateria baja del telefono',
    description:
      'Bajo este nivel de bateria el telefono espacia el registro del recorrido para llegar al final del turno. En cero nunca cambia de ritmo.',
    type: 'integer',
    unit: 'percent',
    min: 0,
    max: 50,
    default: DEFAULT_PATROL_RULES.gpsTrackLowBatteryPct,
    scopes: SOLO_EMPRESA,
    group: 'ubicacion',
  },
  gpsTrackLowBatteryIntervalSeconds: {
    key: 'gpsTrackLowBatteryIntervalSeconds',
    label: 'Frecuencia del recorrido con bateria baja',
    description:
      'Cada cuanto registra la posicion mientras la bateria esta baja. Un recorrido menos detallado es mejor que un telefono apagado a media ronda: un guardia sin telefono no puede pedir ayuda.',
    type: 'integer',
    unit: 'seconds',
    min: 15,
    max: 3600,
    default: DEFAULT_PATROL_RULES.gpsTrackLowBatteryIntervalSeconds,
    // Los mismos niveles que la frecuencia normal: son un par, y dejar una por
    // recinto y la otra no haria que el ahorro dependiera de donde se mire.
    scopes: HASTA_RECINTO,
    group: 'ubicacion',
  },
  gpsBatteryBudgetPct: {
    key: 'gpsBatteryBudgetPct',
    label: 'Bateria que puede costar una ronda',
    description:
      'Cuanta bateria se acepta que gaste una ronda completa. El informe de consumo compara contra esto y avisa cuando registrar el recorrido esta saliendo mas caro de lo previsto.',
    type: 'integer',
    unit: 'percent',
    min: 1,
    max: 100,
    default: DEFAULT_PATROL_RULES.gpsBatteryBudgetPct,
    scopes: SOLO_EMPRESA,
    group: 'ubicacion',
  },
  gpsPermissionReportMaxAgeMin: {
    key: 'gpsPermissionReportMaxAgeMin',
    label: 'Vigencia del permiso informado por el telefono',
    description:
      'Cuanto vale la ultima confirmacion de permiso de ubicacion que mando el telefono. Vencida se vuelve a pedir: da lo mismo que hace tres semanas el permiso estuviera activo si hoy nadie lo confirma.',
    type: 'integer',
    unit: 'minutes',
    min: 15,
    max: 10080,
    default: DEFAULT_PATROL_RULES.gpsPermissionReportMaxAgeMin,
    scopes: SOLO_EMPRESA,
    group: 'ubicacion',
  },
  // NOTA (#286): NO agregar `maxLoginAttempts` aca. El bloqueo de cuenta por
  // intentos fallidos NO se controla desde la cascada de reglas, sino desde la
  // tabla `tenant_auth_policies` (columnas max_failed_attempts, window_seconds,
  // base/max_lock_seconds), que el ADMIN edita en `PATCH /admin/security/policy`
  // y que `auth.service.ts` es el unico que lee. Tener aca una regla homonima
  // era un control MUERTO: el admin la movia y no pasaba nada.
};

/** El catalogo como lista, en el orden en que se declaro. */
export const PATROL_RULE_LIST: readonly AnyRuleParameter[] = Object.values(
  PATROL_RULE_CATALOG,
) as AnyRuleParameter[];

export const PATROL_RULE_KEYS = Object.keys(PATROL_RULE_CATALOG) as Array<keyof PatrolRules>;

/** Parametros configurables en un nivel de la cascada. */
export function ruleKeysForScope(scope: RuleScope): Array<keyof PatrolRules> {
  return PATROL_RULE_KEYS.filter((key) => PATROL_RULE_CATALOG[key].scopes.includes(scope));
}

/** Fichas del catalogo configurables en un nivel, para pintar el formulario. */
export function ruleCatalogForScope(scope: RuleScope): readonly AnyRuleParameter[] {
  return PATROL_RULE_LIST.filter((parametro) => parametro.scopes.includes(scope));
}

export function isRuleAllowedAtScope(key: keyof PatrolRules, scope: RuleScope): boolean {
  return PATROL_RULE_CATALOG[key]?.scopes.includes(scope) ?? false;
}

/**
 * Deja solo los parametros que ese nivel puede sobreescribir. Un override de
 * retencion de fotos guardado en un punto de control no se aplica: se ignora.
 */
export function pickRulesForScope(
  scope: RuleScope,
  overrides: Partial<PatrolRules>,
): Partial<PatrolRules> {
  const permitido: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (!isRuleAllowedAtScope(key as keyof PatrolRules, scope)) continue;
    permitido[key] = value;
  }
  return permitido as Partial<PatrolRules>;
}
