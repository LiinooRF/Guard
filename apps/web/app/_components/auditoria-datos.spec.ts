/**
 * Pruebas de la logica pura de la auditoria (#104).
 *
 * Lo que se prueba es lo que se puede equivocar sin que se note: el corte de
 * los dias cuando cambia la hora, el cursor del paginado y la lectura de un
 * codigo de accion que este panel no conoce. Nada de renderizado — el panel es
 * un componente de servidor y aca no hay navegador.
 *
 * Las fechas de cambio de hora se comprueban preguntandole a `Intl` cual es el
 * desfase, no escribiendolo a mano: si manana cambia la regla de Chile, la
 * prueba sigue diciendo la verdad.
 */

import {
  CATALOGO_ACCIONES,
  CLAVES_URL_AUDITORIA,
  TOPE_FILAS_API,
  accionesSinRegistro,
  describirAccion,
  diaEnZona,
  esUuid,
  filasCsv,
  filasPorConsulta,
  finExclusivoDelDia,
  finInclusivoDelDia,
  formatearInstante,
  inicioDelDia,
  instanteDeParedEnZona,
  opcionesDeAccion,
  opcionesDeActor,
  otrosParametrosDeLaPagina,
  paginadoAtascado,
  parametrosDeAuditoria,
  parametrosDeConsulta,
  parametrosDeUrl,
  resolverFiltro,
  resolverReglasAuditoria,
  resolverZona,
  resumirAuditoria,
  siguienteCorte,
  sumarDiasCalendario,
  type FiltroAuditoria,
  type RegistroAuditoria,
} from './auditoria-datos';

const ZONA = 'America/Santiago';
const REGLAS = resolverReglasAuditoria(null);

/** El reloj de pared de un instante en una zona, para afirmar sobre el. */
function pared(instante: Date, zona: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .format(instante)
    .replace(', ', 'T');
}

function registro(parcial: Partial<RegistroAuditoria> & { id: string }): RegistroAuditoria {
  return {
    actorId: '11111111-1111-4111-8111-111111111111',
    actorLabel: 'Ana Pérez',
    action: 'reglas.modificadas',
    entityType: 'tenant_rules',
    entityId: null,
    summary: null,
    createdAt: '2026-08-03T12:00:00.000Z',
    ...parcial,
  };
}

describe('bordes del dia en la zona del recinto', () => {
  it('un dia normal va de medianoche a medianoche', () => {
    const inicio = inicioDelDia('2026-08-03', ZONA);
    const fin = finExclusivoDelDia('2026-08-03', ZONA);

    expect(pared(inicio, ZONA)).toBe('2026-08-03T00:00:00');
    expect(pared(fin, ZONA)).toBe('2026-08-04T00:00:00');
    expect(fin.getTime() - inicio.getTime()).toBe(24 * 3_600_000);
  });

  it('el dia de 23 horas no se lleva una hora del dia siguiente', () => {
    // 2026-09-06 en Santiago dura 23 horas y ni siquiera tiene medianoche: el
    // reloj salta de las 00:00 a las 01:00. El dia empieza en la 01:00.
    const inicio = inicioDelDia('2026-09-06', ZONA);
    const fin = finExclusivoDelDia('2026-09-06', ZONA);

    expect(pared(inicio, ZONA)).toBe('2026-09-06T01:00:00');
    expect(diaEnZona(inicio, ZONA)).toBe('2026-09-06');
    expect(pared(fin, ZONA)).toBe('2026-09-07T00:00:00');
    expect(fin.getTime() - inicio.getTime()).toBe(23 * 3_600_000);

    // Sumarle 24 horas al instante —en vez de sumar el dia al reloj de pared
    // antes de convertir— habria metido una hora del 7 en el listado del 6.
    const ingenuo = new Date(inicio.getTime() + 86_400_000);
    expect(diaEnZona(ingenuo, ZONA)).toBe('2026-09-07');
  });

  it('el dia de 25 horas no pierde su ultima hora', () => {
    // 2026-04-04 en Santiago dura 25 horas: esa madrugada se atrasa el reloj.
    const inicio = inicioDelDia('2026-04-04', ZONA);
    const fin = finExclusivoDelDia('2026-04-04', ZONA);

    expect(pared(inicio, ZONA)).toBe('2026-04-04T00:00:00');
    expect(pared(fin, ZONA)).toBe('2026-04-05T00:00:00');
    expect(fin.getTime() - inicio.getTime()).toBe(25 * 3_600_000);

    // Con la suma ingenua el rango se habria cortado una hora antes, y esa hora
    // es todavia del 4: es justo cuando se cambian las cosas antes de irse.
    const ingenuo = new Date(inicio.getTime() + 86_400_000);
    expect(ingenuo.getTime()).toBeLessThan(fin.getTime());
    expect(diaEnZona(ingenuo, ZONA)).toBe('2026-04-04');
  });

  it('los dias del año calzan sin hueco ni traslape', () => {
    let dia = '2026-01-01';
    while (dia <= '2026-12-31') {
      const siguiente = sumarDiasCalendario(dia, 1);
      const inicio = inicioDelDia(dia, ZONA);
      const fin = finExclusivoDelDia(dia, ZONA);

      // El primer instante del dia es del dia, el ultimo tambien, y el
      // siguiente ya no. Vale igual en los dos dias en que cambia la hora.
      expect(diaEnZona(inicio, ZONA)).toBe(dia);
      expect(diaEnZona(new Date(fin.getTime() - 1), ZONA)).toBe(dia);
      expect(diaEnZona(fin, ZONA)).toBe(siguiente);
      expect(fin.getTime()).toBe(inicioDelDia(siguiente, ZONA).getTime());
      dia = siguiente;
    }
  });

  it('una hora ambigua se resuelve a la primera vez que ocurrio', () => {
    // 23:30 del 4 de abril ocurre dos veces. Se toma la primera: el criterio
    // tiene que ser uno solo y estar escrito, no depender del tanteo.
    const instante = instanteDeParedEnZona('2026-04-04T23:30:00', ZONA);
    expect(pared(instante, ZONA)).toBe('2026-04-04T23:30:00');
    expect(instante.toISOString()).toBe('2026-04-05T02:30:00.000Z');
  });

  it('el fin inclusivo va un milisegundo antes del exclusivo', () => {
    const exclusivo = finExclusivoDelDia('2026-08-03', ZONA);
    const inclusivo = finInclusivoDelDia('2026-08-03', ZONA);
    expect(exclusivo.getTime() - inclusivo.getTime()).toBe(1);
    expect(diaEnZona(inclusivo, ZONA)).toBe('2026-08-03');
  });

  it('el mismo instante cae en dias distintos segun la zona', () => {
    // 03:00 UTC del 4 de agosto todavia es 3 de agosto en Santiago.
    const instante = new Date('2026-08-04T03:00:00.000Z');
    expect(diaEnZona(instante, ZONA)).toBe('2026-08-03');
    expect(diaEnZona(instante, 'UTC')).toBe('2026-08-04');
  });

  it('una zona invalida no tumba el panel', () => {
    expect(resolverZona('Marte/Olympus')).toBe(ZONA);
    expect(resolverZona(undefined)).toBe(ZONA);
    expect(resolverZona('')).toBe(ZONA);
    expect(resolverZona('Europe/Madrid')).toBe('Europe/Madrid');
  });

  it('formatea la hora en la zona del recinto y no en la del servidor', () => {
    expect(formatearInstante('2026-08-04T03:00:00.000Z', ZONA)).toBe('03-08-2026 23:00');
    expect(formatearInstante('2026-08-04T03:00:00.000Z', 'UTC')).toBe('04-08-2026 03:00');
    expect(formatearInstante('no es fecha', ZONA)).toBe('Sin fecha');
  });
});

describe('filtro desde la URL', () => {
  it('abre en el periodo por defecto cuando la URL viene vacia', () => {
    const filtro = resolverFiltro({}, '2026-08-03', REGLAS, ZONA);
    expect(filtro.hasta).toBe('2026-08-03');
    expect(filtro.desde).toBe(sumarDiasCalendario('2026-08-03', -(REGLAS.diasPorDefecto - 1)));
    expect(filtro.ajustado).toBe(false);
  });

  it('corrige en silencio una URL rota y lo deja anotado', () => {
    const filtro = resolverFiltro(
      { desde: 'ayer', hasta: '2027-01-01', usuario: 'pedro', antes: 'nunca' },
      '2026-08-03',
      REGLAS,
      ZONA,
    );
    expect(filtro.hasta).toBe('2026-08-03');
    expect(filtro.actorId).toBe('');
    expect(filtro.corte).toBe('');
    expect(filtro.ajustado).toBe(true);
  });

  it('recorta el periodo al maximo configurado', () => {
    const filtro = resolverFiltro(
      { desde: '2020-01-01', hasta: '2026-08-03' },
      '2026-08-03',
      REGLAS,
      ZONA,
    );
    expect(filtro.desde).toBe(sumarDiasCalendario('2026-08-03', -(REGLAS.diasMaximos - 1)));
    expect(filtro.ajustado).toBe(true);
  });

  it('descarta un cursor que cae fuera del periodo', () => {
    const dentro = resolverFiltro(
      { desde: '2026-08-01', hasta: '2026-08-03', antes: '2026-08-02T15:00:00.000Z' },
      '2026-08-03',
      REGLAS,
      ZONA,
    );
    expect(dentro.corte).toBe('2026-08-02T15:00:00.000Z');

    const fuera = resolverFiltro(
      { desde: '2026-08-01', hasta: '2026-08-03', antes: '2025-01-01T00:00:00.000Z' },
      '2026-08-03',
      REGLAS,
      ZONA,
    );
    expect(fuera.corte).toBe('');
    expect(fuera.ajustado).toBe(true);
  });

  it('acepta el UUID del usuario y nada mas', () => {
    expect(esUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(esUuid('ana.perez@empresa.cl')).toBe(false);
  });
});

describe('parametros que se le mandan a la API', () => {
  const filtro = resolverFiltro(
    { desde: '2026-08-01', hasta: '2026-08-03' },
    '2026-08-03',
    REGLAS,
    ZONA,
  );

  it('manda from y to como instantes de la zona del recinto', () => {
    const parametros = parametrosDeConsulta(filtro, REGLAS, ZONA);
    expect(parametros.get('from')).toBe(inicioDelDia('2026-08-01', ZONA).toISOString());
    expect(parametros.get('to')).toBe(finInclusivoDelDia('2026-08-03', ZONA).toISOString());
    expect(parametros.get('limit')).toBe(String(REGLAS.filasPorPagina));
  });

  it('omite actorId vacio: la API lo valida como UUID y responderia 400', () => {
    const parametros = parametrosDeConsulta(filtro, REGLAS, ZONA);
    expect(parametros.has('actorId')).toBe(false);
    expect(parametros.has('action')).toBe(false);
  });

  it('nunca pide mas filas de las que la API acepta', () => {
    const excedido = resolverReglasAuditoria({ auditPageSize: 9000 });
    const parametros = parametrosDeConsulta(filtro, excedido, ZONA);
    expect(Number(parametros.get('limit'))).toBeLessThanOrEqual(TOPE_FILAS_API);
  });

  it('el cursor reemplaza el borde alto del periodo', () => {
    const conCorte: FiltroAuditoria = { ...filtro, corte: '2026-08-02T15:00:00.000Z' };
    expect(parametrosDeConsulta(conCorte, REGLAS, ZONA).get('to')).toBe(
      '2026-08-02T15:00:00.000Z',
    );
  });

  it('en la URL del panel no viaja ningun dato de personas', () => {
    const conTodo: FiltroAuditoria = {
      ...filtro,
      actorId: '11111111-1111-4111-8111-111111111111',
      accion: 'reglas.modificadas',
    };
    const texto = parametrosDeUrl(conTodo).toString();
    expect(texto).toContain('aud_usuario=11111111-1111-4111-8111-111111111111');
    expect(texto).not.toMatch(/@/);
  });

  it('nunca pide al servidor mas filas de las que dice pedir', () => {
    expect(filasPorConsulta(REGLAS)).toBe(REGLAS.filasPorPagina);
    expect(filasPorConsulta(resolverReglasAuditoria({ auditPageSize: 500 }))).toBe(TOPE_FILAS_API);
    expect(Number(parametrosDeConsulta(filtro, REGLAS, ZONA).get('limit'))).toBe(
      filasPorConsulta(REGLAS),
    );
  });
});

/*
 * La pagina del ADMIN la comparten varios bloques que leen los MISMOS
 * `searchParams`: los informes (#87, ya en staging) usan `desde`, `hasta`,
 * `recinto`, `sucursal` y `agrupacion`. Si este panel usara esos nombres, o si
 * reescribiera la query entera, se pisarian entre ellos. Esto es lo que lo
 * impide, y por eso se prueba.
 */
describe('convivencia con los otros bloques de la pagina', () => {
  const filtro = resolverFiltro(
    { desde: '2026-08-01', hasta: '2026-08-03' },
    '2026-08-03',
    REGLAS,
    ZONA,
  );

  it('todas las claves propias van con prefijo aud_', () => {
    for (const clave of CLAVES_URL_AUDITORIA) {
      expect(clave.startsWith('aud_')).toBe(true);
    }
    // Los nombres del bloque de informes NO son de este panel.
    for (const ajena of ['desde', 'hasta', 'recinto', 'sucursal', 'agrupacion']) {
      expect(CLAVES_URL_AUDITORIA).not.toContain(ajena);
    }
  });

  it('el panel lee sus claves y no las de los informes', () => {
    const leido = parametrosDeAuditoria({
      desde: '2024-01-01',
      hasta: '2026-08-03',
      agrupacion: 'mes',
      aud_desde: '2026-07-01',
      aud_hasta: '2026-07-31',
      aud_usuario: '11111111-1111-4111-8111-111111111111',
    });
    expect(leido.desde).toBe('2026-07-01');
    expect(leido.hasta).toBe('2026-07-31');
    expect(leido.usuario).toBe('11111111-1111-4111-8111-111111111111');
    expect(leido.accion).toBeUndefined();
    expect(leido.antes).toBeUndefined();
  });

  it('un periodo de 2 años en los informes no le ajusta el filtro a la auditoria', () => {
    // El tope de los informes es de 731 dias y el de este panel de 366. Si
    // compartieran `desde`, esto marcaria `ajustado` y saldria el aviso de "el
    // filtro que traia el enlace no servia" sin que nadie tocara la auditoria.
    const filtroDeUnaUrlDeInformes = resolverFiltro(
      parametrosDeAuditoria({ desde: '2024-08-04', hasta: '2026-08-03', agrupacion: 'mes' }),
      '2026-08-03',
      REGLAS,
      ZONA,
    );
    expect(filtroDeUnaUrlDeInformes.ajustado).toBe(false);
    expect(filtroDeUnaUrlDeInformes.desde).toBe(
      sumarDiasCalendario('2026-08-03', -(REGLAS.diasPorDefecto - 1)),
    );
  });

  it('los parametros ajenos se conservan y los propios se descartan', () => {
    const otros = otrosParametrosDeLaPagina({
      desde: '2026-01-01',
      hasta: '2026-08-03',
      agrupacion: 'mes',
      sucursal: ['Norte', 'Sur'],
      vacio: undefined,
      aud_desde: '2026-07-01',
      aud_antes: '2026-07-15T00:00:00.000Z',
    });
    expect(otros.get('desde')).toBe('2026-01-01');
    expect(otros.getAll('sucursal')).toEqual(['Norte', 'Sur']);
    expect(otros.has('vacio')).toBe(false);
    expect(otros.has('aud_desde')).toBe(false);
    expect(otros.has('aud_antes')).toBe(false);
  });

  it('un enlace del panel arrastra el filtro de los informes en vez de borrarlo', () => {
    const otros = otrosParametrosDeLaPagina({
      desde: '2026-01-01',
      hasta: '2026-08-03',
      recinto: '99999999-9999-4999-8999-999999999999',
      agrupacion: 'mes',
    });
    const enlace = parametrosDeUrl(filtro, '2026-08-02T10:00:00.000Z', otros);

    // Lo de los informes, intacto.
    expect(enlace.get('desde')).toBe('2026-01-01');
    expect(enlace.get('hasta')).toBe('2026-08-03');
    expect(enlace.get('recinto')).toBe('99999999-9999-4999-8999-999999999999');
    expect(enlace.get('agrupacion')).toBe('mes');
    // Y lo propio, en sus claves.
    expect(enlace.get('aud_desde')).toBe('2026-08-01');
    expect(enlace.get('aud_hasta')).toBe('2026-08-03');
    expect(enlace.get('aud_antes')).toBe('2026-08-02T10:00:00.000Z');
  });

  it('el enlace de "volver al comienzo" saca el cursor sin tocar lo ajeno', () => {
    const otros = otrosParametrosDeLaPagina({ desde: '2026-01-01', agrupacion: 'semana' });
    const conCorte: FiltroAuditoria = { ...filtro, corte: '2026-08-02T10:00:00.000Z' };
    const enlace = parametrosDeUrl({ ...conCorte, corte: '' }, undefined, otros);

    expect(enlace.has('aud_antes')).toBe(false);
    expect(enlace.get('desde')).toBe('2026-01-01');
    expect(enlace.get('agrupacion')).toBe('semana');
  });

  it('un enlace nuevo no duplica las claves propias que ya venian', () => {
    // `otros` nunca deberia traerlas —`otrosParametrosDeLaPagina` las saca—,
    // pero si alguien arma la base a mano, se reescriben y no se acumulan.
    const sucias = new URLSearchParams('aud_desde=2020-01-01&aud_antes=viejo&desde=2026-01-01');
    const enlace = parametrosDeUrl(filtro, undefined, sucias);
    expect(enlace.getAll('aud_desde')).toEqual(['2026-08-01']);
    expect(enlace.has('aud_antes')).toBe(false);
    expect(enlace.get('desde')).toBe('2026-01-01');
  });
});

describe('paginado por cursor', () => {
  const reglas = resolverReglasAuditoria({ auditPageSize: 20 });
  const filtro = resolverFiltro({}, '2026-08-03', reglas, ZONA);

  it('no ofrece pagina siguiente cuando la pagina viene a medias', () => {
    const filas = [registro({ id: 'a' })];
    expect(siguienteCorte(filas, filtro, reglas)).toBeNull();
    expect(paginadoAtascado(filas, filtro, reglas)).toBe(false);
  });

  it('el cursor es la fecha de la ultima fila, sin restarle nada', () => {
    const filas = Array.from({ length: 20 }, (_, indice) =>
      registro({
        id: `f${indice}`,
        createdAt: new Date(Date.UTC(2026, 6, 20 + Math.floor(indice / 10), 12, indice)).toISOString(),
      }),
    );
    const ultima = filas[filas.length - 1];
    expect(siguienteCorte(filas, filtro, reglas)).toBe(ultima?.createdAt);
  });

  it('no gira sobre si mismo si toda la pagina comparte el mismo instante', () => {
    const filas = Array.from({ length: 20 }, (_, indice) =>
      registro({ id: `f${indice}`, createdAt: '2026-08-02T10:00:00.000Z' }),
    );
    const enCurso: FiltroAuditoria = { ...filtro, corte: '2026-08-02T10:00:00.000Z' };
    expect(siguienteCorte(filas, enCurso, reglas)).toBeNull();
    expect(paginadoAtascado(filas, enCurso, reglas)).toBe(true);
  });
});

describe('acciones', () => {
  it('describe una accion que no conoce en vez de esconderla', () => {
    const ficha = describirAccion('licencia.renovada');
    expect(ficha.etiqueta).toBe('Licencia · renovada');
    expect(ficha.registro).toBe('completo');
  });

  it('el selector junta el catalogo del producto con lo que hay en los datos', () => {
    const opciones = opcionesDeAccion(['licencia.renovada', 'reglas.modificadas']);
    const codigos = opciones.map((ficha) => ficha.codigo);
    expect(codigos).toContain('usuario.creado');
    expect(codigos).toContain('licencia.renovada');
    expect(codigos.filter((codigo) => codigo === 'reglas.modificadas')).toHaveLength(1);
  });

  it('deja anotado que el alta de usuarios todavia no se registra', () => {
    // Es el hueco que hace que el criterio del issue no se cumpla entero, y el
    // panel tiene que decirlo: cero filas no es lo mismo que no paso nada.
    expect(describirAccion('usuario.creado').registro).toBe('ausente');
    expect(describirAccion('reglas.modificadas').registro).toBe('completo');
    expect(describirAccion('etiqueta.registrada').registro).toBe('parcial');
    expect(accionesSinRegistro().length).toBeGreaterThan(0);
    for (const ficha of accionesSinRegistro()) {
      expect(typeof ficha.nota).toBe('string');
    }
  });

  it('toda ficha del catalogo tiene etiqueta y descripcion', () => {
    for (const ficha of CATALOGO_ACCIONES) {
      expect(ficha.etiqueta.length).toBeGreaterThan(0);
      expect(ficha.descripcion.length).toBeGreaterThan(0);
    }
  });
});

describe('resumen y actores', () => {
  it('cuenta personas y acciones distintas del periodo', () => {
    const filas = [
      registro({ id: 'a', createdAt: '2026-08-03T12:00:00.000Z' }),
      registro({
        id: 'b',
        actorId: '22222222-2222-4222-8222-222222222222',
        actorLabel: 'Luis Soto',
        action: 'rondas.generadas',
        createdAt: '2026-08-01T09:00:00.000Z',
      }),
    ];
    const resumen = resumirAuditoria(filas);
    expect(resumen.registros).toBe(2);
    expect(resumen.personas).toBe(2);
    expect(resumen.acciones).toBe(2);
    expect(resumen.masReciente).toBe('2026-08-03T12:00:00.000Z');
    expect(resumen.masAntigua).toBe('2026-08-01T09:00:00.000Z');
  });

  it('un actor sin id se cuenta igual: la cuenta se borro, la accion no', () => {
    const filas = [
      registro({ id: 'a', actorId: null, actorLabel: 'Ana Pérez' }),
      registro({ id: 'b', actorId: null, actorLabel: 'Ana Pérez' }),
      registro({ id: 'c', actorId: null, actorLabel: 'Luis Soto' }),
    ];
    expect(resumirAuditoria(filas).personas).toBe(2);
  });

  it('el selector de usuarios incluye a los que ya no existen', () => {
    const filas = [
      registro({ id: 'a', actorId: '33333333-3333-4333-8333-333333333333', actorLabel: 'Ex Jefe' }),
    ];
    const opciones = opcionesDeActor(filas, [
      { id: '11111111-1111-4111-8111-111111111111', givenName: 'Ana', familyName: 'Pérez' },
    ]);
    expect(opciones).toHaveLength(2);
    expect(opciones.find((opcion) => opcion.id.startsWith('3333'))?.historico).toBe(true);
    expect(opciones.find((opcion) => opcion.id.startsWith('1111'))?.historico).toBe(false);
  });

  it('funciona sin la lista de usuarios, armandola con las propias filas', () => {
    const filas = [registro({ id: 'a' })];
    expect(opcionesDeActor(filas)).toHaveLength(1);
  });
});

describe('exportacion', () => {
  it('lleva el codigo de accion ademas de la etiqueta y la zona de la hora', () => {
    const filas = filasCsv([registro({ id: 'a', summary: 'tenant: 2 regla(s)' })], ZONA);
    expect(filas[0]).toEqual([
      '03-08-2026 08:00:00',
      ZONA,
      'Ana Pérez',
      'Cambio de reglas',
      'reglas.modificadas',
      'Reglas de la empresa',
      '',
      'tenant: 2 regla(s)',
    ]);
  });
});

describe('reglas del panel', () => {
  it('usa el ultimo recurso mientras la API no responda las reglas nuevas', () => {
    const reglas = resolverReglasAuditoria({});
    expect(reglas.diasPorDefecto).toBeGreaterThan(0);
    expect(reglas.filasPorPagina).toBeLessThanOrEqual(TOPE_FILAS_API);
  });

  it('ignora valores fuera de rango en vez de confiar en ellos', () => {
    const reglas = resolverReglasAuditoria({
      auditDefaultRangeDays: 0,
      auditMaxRangeDays: 99_999,
      auditPageSize: 1.5,
    });
    expect(reglas).toEqual(resolverReglasAuditoria(null));
  });

  it('respeta lo que si viene bien', () => {
    const reglas = resolverReglasAuditoria({ auditDefaultRangeDays: 7, auditPageSize: 250 });
    expect(reglas.diasPorDefecto).toBe(7);
    expect(reglas.filasPorPagina).toBe(250);
  });
});
