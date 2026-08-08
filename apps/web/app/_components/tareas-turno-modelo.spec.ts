import {
  borradorDesdeApi,
  cuerpoDePlantilla,
  fueraDelTurno,
  horaDelServidor,
  mensajeDeRespuesta,
  resumenDeTarea,
  revisarBorrador,
  tareaVacia,
  type RecintoDelEditor,
  type TareaBorrador,
  type TurnoDelRecinto,
} from './tareas-turno-modelo';

const NOCTURNO: TurnoDelRecinto = {
  id: 'turno-noche',
  name: 'Noche',
  startsAt: '22:00',
  endsAt: '06:00',
};

const DIURNO: TurnoDelRecinto = {
  id: 'turno-dia',
  name: 'Día',
  startsAt: '08:00',
  endsAt: '18:00',
};

const RECINTO: RecintoDelEditor = {
  id: 'site-1',
  name: 'Planta Sur',
  branchName: 'Sucursal Maipú',
  timezone: 'America/Santiago',
  checkpoints: [
    { id: 'punto-cocina', name: 'Cocina' },
    { id: 'punto-porton', name: 'Portón norte' },
  ],
  shifts: [NOCTURNO, DIURNO],
};

function tarea(cambios: Partial<TareaBorrador> = {}): TareaBorrador {
  return { ...tareaVacia('t1'), label: 'Fotografiar el refrigerador', ...cambios };
}

describe('tareas del turno — la hora que viene de la base (#265)', () => {
  it('recorta el HH:MM:SS de PostgreSQL a HH:MM, que es lo que el DTO acepta de vuelta', () => {
    expect(horaDelServidor('11:00:00')).toBe('11:00');
    expect(horaDelServidor('23:59:00')).toBe('23:59');
  });

  it('sin hora sigue sin hora, y una hora ilegible no se inventa', () => {
    expect(horaDelServidor(null)).toBeNull();
    expect(horaDelServidor('a las once')).toBeNull();
    expect(horaDelServidor('25:00:00')).toBeNull();
  });

  it('el borrador que se carga desde la API ya trae la hora recortada', () => {
    const borrador = borradorDesdeApi({
      id: 'item-1',
      position: 1,
      label: 'Fotografiar el refrigerador',
      responseType: 'ok_falla',
      requiresPhotoOnFail: false,
      checkpointId: 'punto-cocina',
      dueLocalTime: '11:00:00',
      requiresPhoto: true,
    });

    expect(borrador.dueLocalTime).toBe('11:00');
    expect(borrador.checkpointId).toBe('punto-cocina');
    expect(borrador.requiresPhoto).toBe(true);
  });
});

describe('tareas del turno — lo que viaja en el POST (#265)', () => {
  it('la tarea del requisito viaja completa: punto, hora y foto', () => {
    const cuerpo = cuerpoDePlantilla(
      '  Tareas del turno  ',
      [tarea({ checkpointId: 'punto-cocina', dueLocalTime: '11:00', requiresPhoto: true })],
      'turno-noche',
    );

    expect(cuerpo).toEqual({
      name: 'Tareas del turno',
      shiftId: 'turno-noche',
      items: [
        {
          label: 'Fotografiar el refrigerador',
          responseType: 'ok_falla',
          requiresPhotoOnFail: false,
          requiresPhoto: true,
          checkpointId: 'punto-cocina',
          dueLocalTime: '11:00',
        },
      ],
    });
  });

  /**
   * El `<select>` vacio y el `<input type="time">` vacio devuelven `''`, y `''`
   * NO es "ausente" para el servidor: cae en `@IsUUID()` / `@Matches()` y vuelve
   * como 400 por una tarea que el supervisor dejo bien. Omitir la clave es la
   * unica forma de "sin punto" que no depende de como interprete el vacio quien
   * reciba.
   */
  it('una tarea sin punto ni hora OMITE esas claves en vez de mandarlas en null', () => {
    const cuerpo = cuerpoDePlantilla('Tareas', [tarea()], null);
    const item = (cuerpo.items as Array<Record<string, unknown>>)[0]!;

    expect(Object.keys(item).sort()).toEqual(
      ['label', 'requiresPhoto', 'requiresPhotoOnFail', 'responseType'].sort(),
    );
    expect(Object.keys(cuerpo)).not.toContain('shiftId');
  });

  it('la clave de React no se cuela en el cuerpo', () => {
    const cuerpo = cuerpoDePlantilla('Tareas', [tarea()], null);
    const item = (cuerpo.items as Array<Record<string, unknown>>)[0]!;
    expect(item).not.toHaveProperty('clave');
  });
});

describe('tareas del turno — fuera del horario del turno (#265)', () => {
  it('en el turno de dia, las 11 estan dentro y las 22 fuera', () => {
    expect(fueraDelTurno('11:00', DIURNO)).toBe(false);
    expect(fueraDelTurno('22:00', DIURNO)).toBe(true);
  });

  /**
   * El turno nocturno cruza la medianoche, y comparado como un intervalo normal
   * TODA su franja sale "fuera de horario": las 23:00 no estan entre 22:00 y
   * 06:00 si se lee de izquierda a derecha. Un aviso que se enciende siempre es
   * un aviso que se aprende a ignorar.
   */
  it('en el turno nocturno, 23:00 y 05:00 estan DENTRO aunque la ventana cruce la medianoche', () => {
    expect(fueraDelTurno('23:00', NOCTURNO)).toBe(false);
    expect(fueraDelTurno('05:00', NOCTURNO)).toBe(false);
    expect(fueraDelTurno('00:30', NOCTURNO)).toBe(false);
  });

  it('la tarea de las 11 SI queda fuera del turno de noche: es el caso del requisito', () => {
    expect(fueraDelTurno('11:00', NOCTURNO)).toBe(true);
  });

  it('los extremos cuentan como dentro', () => {
    expect(fueraDelTurno('22:00', NOCTURNO)).toBe(false);
    expect(fueraDelTurno('06:00', NOCTURNO)).toBe(false);
    expect(fueraDelTurno('08:00', DIURNO)).toBe(false);
    expect(fueraDelTurno('18:00', DIURNO)).toBe(false);
  });

  it('sin hora o sin turno elegido no hay nada que avisar', () => {
    expect(fueraDelTurno(null, NOCTURNO)).toBe(false);
    expect(fueraDelTurno('11:00', null)).toBe(false);
  });
});

describe('tareas del turno — revision del borrador (#265)', () => {
  it('la tarea fuera de horario es AVISO, nunca error: el producto pide que se envie igual', () => {
    const revision = revisarBorrador(
      'Tareas del turno',
      [tarea({ dueLocalTime: '11:00' })],
      { recinto: RECINTO, turno: NOCTURNO },
    );

    expect(revision.errores).toEqual([]);
    expect(revision.avisos.join(' ')).toContain('fuera del turno');
    expect(revision.avisos.join(' ')).toContain('fuera de horario en el informe');
  });

  it('un punto que no es del recinto si es error, y se dice antes de ir al servidor', () => {
    const revision = revisarBorrador(
      'Tareas del turno',
      [tarea({ checkpointId: 'punto-de-otra-sucursal' })],
      { recinto: RECINTO, turno: null },
    );

    expect(revision.errores).toEqual(['Tarea 1: ese punto de control no es de este recinto.']);
  });

  it('un punto del propio recinto pasa sin ruido', () => {
    const revision = revisarBorrador(
      'Tareas del turno',
      [tarea({ checkpointId: 'punto-cocina' })],
      { recinto: RECINTO, turno: null },
    );

    expect(revision.errores).toEqual([]);
  });

  it('una tarea sin texto y una plantilla sin nombre no se guardan', () => {
    const revision = revisarBorrador('T', [tarea({ label: ' ' })], {
      recinto: RECINTO,
      turno: null,
    });

    expect(revision.errores).toHaveLength(2);
  });

  it('sin tareas no hay plantilla que guardar', () => {
    const revision = revisarBorrador('Tareas del turno', [], { recinto: RECINTO, turno: null });
    expect(revision.errores).toContain('Agrega al menos una tarea.');
  });

  it('una hora mal escrita es error, con el formato en el mensaje', () => {
    const revision = revisarBorrador('Tareas del turno', [tarea({ dueLocalTime: '11:60' })], {
      recinto: RECINTO,
      turno: null,
    });

    expect(revision.errores).toEqual(['Tarea 1: la hora va en formato HH:MM de 24 horas.']);
  });

  it('la foto obligatoria avisa que el guardia todavia no puede adjuntarla', () => {
    const revision = revisarBorrador('Tareas del turno', [tarea({ requiresPhoto: true })], {
      recinto: RECINTO,
      turno: null,
    });

    expect(revision.errores).toEqual([]);
    expect(revision.avisos.join(' ')).toContain('todavía no adjunta fotos');
  });
});

describe('tareas del turno — lo que dice la pantalla (#265)', () => {
  it('el 409 explica que hay que desactivar y crear otra, no que reintente', () => {
    const mensaje = mensajeDeRespuesta(409);
    expect(mensaje).toContain('Desactívala y crea una nueva');
    expect(mensaje).not.toContain('intenta nuevamente');
  });

  it('el 403 nombra el alcance por recinto, que es el motivo real', () => {
    expect(mensajeDeRespuesta(403)).toContain('los que tienes asignados');
  });

  it('el resumen de la tarea del requisito se lee de un vistazo', () => {
    expect(
      resumenDeTarea(
        tarea({ dueLocalTime: '11:00', checkpointId: 'punto-cocina', requiresPhoto: true }),
        RECINTO.checkpoints,
      ),
    ).toBe('11:00 · Cocina · foto obligatoria');
  });

  it('una tarea general del turno lo dice en vez de dejar el hueco', () => {
    expect(resumenDeTarea(tarea(), RECINTO.checkpoints)).toBe('en cualquier punto');
  });
});
