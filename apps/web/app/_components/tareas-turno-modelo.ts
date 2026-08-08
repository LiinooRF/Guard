/**
 * Editor de tareas del turno (#265) — el modelo puro.
 *
 * Aca no hay React ni fetch a proposito: es lo unico de esta pantalla que se
 * puede probar con Jest sin navegador ni base de datos. El componente solo
 * dibuja lo que esto devuelve y manda lo que esto arma.
 *
 * El requisito, textual del dueño del producto (8-ago-2026):
 *
 *   "tengo asignada una tarea de ir A LAS 11, a CIERTO PUNTO, y tomar una
 *    IMAGEN al refrigerador ... si la tarea queda fuera del horario de la ronda,
 *    que se envie igual, se puede trabajar todo igual, pero que se mencione en
 *    el informe y en todo en general"
 *
 * De ahi salen las dos reglas que gobiernan este archivo:
 *
 * 1. **Fuera de horario se AVISA, no se bloquea.** `fueraDelTurno()` devuelve un
 *    aviso y `validar()` nunca lo convierte en error. Es la misma politica que
 *    el resto del sistema: marca y avisa, no rechaza. Si el editor impidiera
 *    guardar una tarea a las 11 en un turno de noche, el supervisor no tendria
 *    como pedirla — y el producto dice explicitamente que si se puede.
 * 2. **La hora es del RECINTO.** Nunca se convierte a la zona del navegador. El
 *    supervisor escribe "11:00" y el servidor la guarda como hora local del
 *    recinto (`due_local_time` + `sites.timezone`). Convertirla aca haria que un
 *    supervisor en otra zona pidiera la tarea a otra hora sin enterarse.
 */

export type TipoRespuesta = 'ok_falla' | 'texto' | 'numero';

export interface PuntoDelRecinto {
  readonly id: string;
  readonly name: string;
}

export interface TurnoDelRecinto {
  readonly id: string;
  readonly name: string;
  /** `HH:MM` local del recinto. */
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface RecintoDelEditor {
  readonly id: string;
  readonly name: string;
  readonly branchName: string;
  readonly timezone: string;
  readonly checkpoints: readonly PuntoDelRecinto[];
  readonly shifts: readonly TurnoDelRecinto[];
}

/** Un item tal como lo devuelve la API. */
export interface TareaDeLaApi {
  readonly id: string;
  readonly position: number;
  readonly label: string;
  readonly responseType: TipoRespuesta;
  readonly requiresPhotoOnFail: boolean;
  readonly checkpointId: string | null;
  readonly dueLocalTime: string | null;
  readonly requiresPhoto: boolean;
}

export interface PlantillaDeLaApi {
  readonly id: string;
  readonly name: string;
  readonly siteId: string | null;
  readonly shiftId: string | null;
  readonly isActive: boolean;
  readonly items: readonly TareaDeLaApi[];
}

/** Lo que el formulario edita. `clave` es solo el identificador de React. */
export interface TareaBorrador {
  readonly clave: string;
  readonly label: string;
  readonly responseType: TipoRespuesta;
  readonly checkpointId: string | null;
  readonly dueLocalTime: string | null;
  readonly requiresPhoto: boolean;
  readonly requiresPhotoOnFail: boolean;
}

export const TIPOS_DE_RESPUESTA: ReadonlyArray<{ valor: TipoRespuesta; etiqueta: string }> = [
  { valor: 'ok_falla', etiqueta: 'OK / Falla' },
  { valor: 'texto', etiqueta: 'Texto libre' },
  { valor: 'numero', etiqueta: 'Número' },
];

const PATRON_HORA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function horaValida(valor: string): boolean {
  return PATRON_HORA.test(valor);
}

/**
 * La API devuelve `due_local_time` tal como lo guarda PostgreSQL: `HH:MM:SS`.
 * El editor trabaja en `HH:MM`, que es lo que valida el DTO al volver.
 *
 * Sin este recorte el viaje de ida y vuelta se rompe en el borde mas tonto
 * posible: se lee "11:00:00", se reenvia igual, y el servidor responde 400 por
 * una tarea que el supervisor ni siquiera toco.
 */
export function horaDelServidor(valor: string | null): string | null {
  if (valor === null) return null;
  const recortada = valor.slice(0, 5);
  return horaValida(recortada) ? recortada : null;
}

export function tareaVacia(clave: string): TareaBorrador {
  return {
    clave,
    label: '',
    responseType: 'ok_falla',
    checkpointId: null,
    dueLocalTime: null,
    requiresPhoto: false,
    requiresPhotoOnFail: false,
  };
}

export function borradorDesdeApi(item: TareaDeLaApi): TareaBorrador {
  return {
    clave: item.id,
    label: item.label,
    responseType: item.responseType,
    checkpointId: item.checkpointId,
    dueLocalTime: horaDelServidor(item.dueLocalTime),
    requiresPhoto: item.requiresPhoto,
    requiresPhotoOnFail: item.requiresPhotoOnFail,
  };
}

/**
 * El cuerpo del POST/PUT.
 *
 * Las claves opcionales se OMITEN cuando estan vacias, y la cadena vacia jamas
 * viaja. `@IsOptional()` del servidor trata `null` como ausente, asi que un
 * `checkpointId: null` no reventaria la validacion — pero `checkpointId: ''` si:
 * cae en `@IsUUID()` y vuelve como 400. Entre las tres formas de decir "esta
 * tarea no tiene punto", omitir la clave es la unica que no depende de como
 * interprete el vacio quien reciba, y es la que el servidor recibe con la misma
 * lectura que este editor le da.
 *
 * `shiftId` es distinto y por eso se omite igual: el alcance de una plantilla no
 * se edita, y en el PUT esa clave ni siquiera esta en el DTO. Con
 * `forbidNonWhitelisted` activado, mandarla de mas es un 400.
 */
export function cuerpoDePlantilla(
  nombre: string,
  tareas: readonly TareaBorrador[],
  turnoId: string | null,
): Record<string, unknown> {
  return {
    name: nombre.trim(),
    ...(turnoId ? { shiftId: turnoId } : {}),
    items: tareas.map((tarea) => ({
      label: tarea.label.trim(),
      responseType: tarea.responseType,
      requiresPhotoOnFail: tarea.requiresPhotoOnFail,
      requiresPhoto: tarea.requiresPhoto,
      ...(tarea.checkpointId ? { checkpointId: tarea.checkpointId } : {}),
      ...(tarea.dueLocalTime ? { dueLocalTime: tarea.dueLocalTime } : {}),
    })),
  };
}

/**
 * ¿La hora pedida cae fuera de la ventana del turno?
 *
 * El turno NOCTURNO es el caso que importa y el que se equivoca solo: empieza a
 * las 22:00 y termina a las 06:00, o sea cruza la medianoche. Comparado como un
 * intervalo normal ("¿esta 23:00 entre 22:00 y 06:00?") el resultado es que
 * TODA tarea del turno de noche sale marcada como fuera de horario, y el aviso
 * deja de significar nada. Con la ventana invertida la pertenencia tambien se
 * invierte: adentro es `>= inicio` **o** `<= fin`.
 *
 * Los extremos cuentan como dentro: una tarea a las 22:00 en un turno que
 * empieza a las 22:00 esta en horario.
 */
export function fueraDelTurno(hora: string | null, turno: TurnoDelRecinto | null): boolean {
  if (hora === null || turno === null) return false;
  if (!horaValida(hora) || !horaValida(turno.startsAt) || !horaValida(turno.endsAt)) return false;
  if (turno.startsAt === turno.endsAt) return false; // 24 horas: nada queda afuera

  const cruzaMedianoche = turno.startsAt > turno.endsAt;
  const dentro = cruzaMedianoche
    ? hora >= turno.startsAt || hora <= turno.endsAt
    : hora >= turno.startsAt && hora <= turno.endsAt;
  return !dentro;
}

export interface RevisionDelBorrador {
  /** Impiden guardar. */
  readonly errores: readonly string[];
  /** Se guardan igual; el supervisor tiene que enterarse. */
  readonly avisos: readonly string[];
}

/**
 * Lo que impide guardar y lo que solo hay que decir en pantalla.
 *
 * La separacion es el punto entero de esta funcion: una tarea fuera del horario
 * del turno es un AVISO, porque el producto pide expresamente que se pueda
 * pedir igual y que se mencione. Convertirlo en error seria decidir por el
 * dueño del producto.
 */
export function revisarBorrador(
  nombre: string,
  tareas: readonly TareaBorrador[],
  contexto: { readonly recinto: RecintoDelEditor | null; readonly turno: TurnoDelRecinto | null },
): RevisionDelBorrador {
  const errores: string[] = [];
  const avisos: string[] = [];

  if (nombre.trim().length < 2) errores.push('La plantilla necesita un nombre de al menos 2 letras.');
  if (!tareas.length) errores.push('Agrega al menos una tarea.');

  const puntosDelRecinto = new Set(contexto.recinto?.checkpoints.map((punto) => punto.id) ?? []);

  tareas.forEach((tarea, indice) => {
    const numero = indice + 1;
    if (tarea.label.trim().length < 2) {
      errores.push(`Tarea ${numero}: escribe qué hay que hacer (mínimo 2 letras).`);
    }
    if (tarea.label.trim().length > 200) {
      errores.push(`Tarea ${numero}: el texto no puede pasar de 200 caracteres.`);
    }
    if (tarea.dueLocalTime !== null && !horaValida(tarea.dueLocalTime)) {
      errores.push(`Tarea ${numero}: la hora va en formato HH:MM de 24 horas.`);
    }
    // El servidor lo rechaza igual (400); decirlo aca evita el viaje y explica
    // el motivo, que desde la API llega como un mensaje suelto.
    if (tarea.checkpointId !== null && !puntosDelRecinto.has(tarea.checkpointId)) {
      errores.push(`Tarea ${numero}: ese punto de control no es de este recinto.`);
    }
    if (fueraDelTurno(tarea.dueLocalTime, contexto.turno)) {
      avisos.push(
        `Tarea ${numero}: las ${tarea.dueLocalTime} quedan fuera del turno ` +
          `${contexto.turno?.name} (${contexto.turno?.startsAt}–${contexto.turno?.endsAt}). ` +
          'Se pide igual y queda marcada como fuera de horario en el informe.',
      );
    }
    if (tarea.requiresPhoto) {
      avisos.push(
        `Tarea ${numero}: exige foto siempre. La pantalla del guardia todavía no adjunta fotos ` +
          'de tareas, así que hoy se responde con observación escrita.',
      );
    }
  });

  return { errores, avisos };
}

/**
 * El mensaje de la respuesta del servidor, ya traducido a lo que el supervisor
 * tiene que HACER.
 *
 * El 409 es el que mas importa: el servidor responde "ya tiene respuestas
 * registradas" cuando se intenta cambiar los items de una plantilla que alguna
 * ronda ya contesto. Eso no es un error del supervisor ni un fallo transitorio
 * que se arregle reintentando — es que editar ahi reescribiria la pregunta que
 * contesto una ronda cerrada. El camino es desactivar y crear otra, y la
 * pantalla lo tiene que decir con esas palabras.
 */
export function mensajeDeRespuesta(estado: number): string {
  if (estado === 409) {
    return (
      'Esta plantilla ya tiene respuestas de rondas cerradas, así que sus tareas no se pueden ' +
      'cambiar: cambiarlas reescribiría lo que ya se respondió. Desactívala y crea una nueva ' +
      'con los cambios.'
    );
  }
  if (estado === 403) return 'Este recinto no está entre los que tienes asignados.';
  if (estado === 404) return 'La plantilla ya no existe. Vuelve a cargar la pantalla.';
  if (estado === 400) return 'Revisa los datos: hay una tarea con un punto o una hora que no calzan.';
  return 'No pudimos guardar la plantilla. Revisa la conexión e intenta nuevamente.';
}

/** Una linea corta para la lista: "11:00 · Cocina · foto". */
export function resumenDeTarea(
  tarea: TareaBorrador,
  puntos: readonly PuntoDelRecinto[],
): string {
  const partes: string[] = [];
  if (tarea.dueLocalTime) partes.push(tarea.dueLocalTime);
  if (tarea.checkpointId) {
    const punto = puntos.find((candidato) => candidato.id === tarea.checkpointId);
    partes.push(punto ? punto.name : 'punto desconocido');
  } else {
    partes.push('en cualquier punto');
  }
  if (tarea.requiresPhoto) partes.push('foto obligatoria');
  else if (tarea.requiresPhotoOnFail) partes.push('foto si falla');
  return partes.join(' · ');
}
