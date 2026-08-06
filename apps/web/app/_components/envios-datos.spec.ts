/**
 * Pruebas de la logica pura de la vista de envios (#221).
 *
 * Se prueba lo que se puede equivocar sin que se note en pantalla:
 *
 *  1. LA TRADUCCION DEL REBOTE, que es el corazon del issue. Un `550 5.1.1` mal
 *     leido manda a soporte a revisar la red cuando lo que pasa es que el correo
 *     esta mal escrito en la ficha del cliente.
 *  2. EL FILTRO, que tiene una regla que no se ve: mandar fechas sin recinto
 *     hace que la API responda 400 (el periodo se interpreta en la zona horaria
 *     del recinto). El panel las descarta antes y lo dice.
 *  3. EL CONTRATO DUPLICADO. Los estados de esta pantalla son una copia de
 *     `ESTADOS_ENVIO` de la API y del CHECK de la migracion, porque el panel no
 *     puede importar de `apps/api`. La copia se compara con su origen leyendo
 *     los dos archivos: si alguien agrega un estado alla, esta prueba se cae
 *     aca, que es exactamente cuando hay que enterarse.
 *
 * Nada de renderizado: el panel es un componente de servidor y aca no hay
 * navegador, igual que en `auditoria-datos.spec.ts`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CATALOGO_ESTADOS,
  CATALOGO_PLANTILLAS,
  CLAVE_URL,
  ESTADOS_ENVIO,
  FILAS_POR_DEFECTO,
  describirEstado,
  describirPlantilla,
  esEstadoConocido,
  esUuid,
  etiquetaDeRonda,
  explicarMotivo,
  faltaConfirmacionDeEntrega,
  opcionesDePlantilla,
  parametrosAjenos,
  parametrosDeConsulta,
  parametrosDeUrl,
  plantillasPresentes,
  puedeHaberMas,
  recintoPedido,
  referenciaCorta,
  resolverFiltro,
  resumirEnvios,
  rondasPresentes,
  siguienteTamano,
  zonaDelRecinto,
  type EnvioRegistrado,
  type FiltroEnvios,
} from './envios-datos';

const HOY = '2026-08-05';
const RONDA = '3f1c2a44-9b2e-4c1a-8f77-5b0d1e2a3c44';
const RECINTO = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function envio(parcial: Partial<EnvioRegistrado> = {}): EnvioRegistrado {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    plantilla: 'report-dispatch:informe',
    destinatario: 'jefe@cliente.cl',
    destinatarioUsuarioId: null,
    patrolId: null,
    estado: 'enviado',
    intentos: 1,
    ultimoError: null,
    encoladoEn: '2026-08-05T12:00:00.000Z',
    enviadoEn: '2026-08-05T12:00:03.000Z',
    entregadoEn: null,
    falladoEn: null,
    ...parcial,
  };
}

/* ------------------------------------------------------------------ */
/* 1. Traduccion del rebote                                            */
/* ------------------------------------------------------------------ */

describe('explicarMotivo', () => {
  it('lee «550 5.1.1 ... User unknown» como una direccion que no existe', () => {
    const motivo = explicarMotivo(
      'rebotado',
      '550 5.1.1 <jefe@cliente.cl>: Recipient address rejected: User unknown in virtual mailbox table',
    );

    expect(motivo).not.toBeNull();
    expect(motivo?.causa).toBe('direccion');
    expect(motivo?.titulo).toBe('La dirección no existe');
    expect(motivo?.transitorio).toBe(false);
    // El titulo es para el jefe de operaciones: sin codigos ni siglas.
    expect(motivo?.titulo).not.toMatch(/5\.1\.1|SMTP/i);
    // El texto crudo no se pierde: se guarda para escalarlo.
    expect(motivo?.tecnico).toContain('550 5.1.1');
  });

  it('el codigo ampliado manda sobre el texto y la clase 4 solo marca «temporal»', () => {
    const greylist = explicarMotivo('rebotado', '451 4.7.1 Greylisted, try again later');

    // 7.1 es rechazo por politica; el 4 del principio dice que es temporal. Son
    // dos datos distintos del mismo codigo y se leen por separado.
    expect(greylist?.causa).toBe('rechazo');
    expect(greylist?.transitorio).toBe(true);
  });

  it('un 4.2.2 es casilla llena, no «vuelve a intentar mas tarde»', () => {
    const motivo = explicarMotivo('rebotado', '452 4.2.2 Mailbox full');

    expect(motivo?.causa).toBe('casilla-llena');
    expect(motivo?.transitorio).toBe(true);
    // Lo que hay que hacer es del lado del cliente, no esperar.
    expect(motivo?.queHacer).toMatch(/espacio/i);
  });

  it('el texto del servidor le gana al numero suelto de un puerto', () => {
    // `587` calza con el patron de codigo clasico de tres digitos; si el codigo
    // se leyera antes que el texto, esto se explicaria como otra cosa.
    const motivo = explicarMotivo('fallido', 'Error: connect ETIMEDOUT 10.0.0.5:587');

    expect(motivo?.causa).toBe('conexion');
  });

  it('distingue un problema NUESTRO de uno del cliente', () => {
    const nuestro = explicarMotivo(
      'fallido',
      'Invalid login: 535-5.7.8 Username and Password not accepted',
    );

    expect(nuestro?.causa).toBe('configuracion');
    expect(nuestro?.queHacer).toMatch(/equipo técnico/i);
    expect(nuestro?.queHacer).not.toMatch(/pídele al cliente/i);
  });

  it('reconoce el dominio que no existe aunque no venga codigo', () => {
    const motivo = explicarMotivo('fallido', 'Error: getaddrinfo ENOTFOUND smtp.clientte.cl');

    expect(motivo?.causa).toBe('dominio');
  });

  it('no inventa una causa cuando el servidor no explico nada', () => {
    const conTexto = explicarMotivo('rebotado', 'Se cayó el mundo');
    expect(conTexto?.causa).toBe('desconocida');
    expect(conTexto?.tecnico).toBe('Se cayó el mundo');

    const sinTexto = explicarMotivo('rebotado', null);
    expect(sinTexto?.causa).toBe('desconocida');
    expect(sinTexto?.tecnico).toBeNull();

    // Un motivo en blanco es lo mismo que no tener motivo.
    expect(explicarMotivo('fallido', '   ')?.tecnico).toBeNull();
  });

  it('no muestra el tropiezo viejo de un correo que llego', () => {
    expect(explicarMotivo('entregado', '451 4.7.1 Greylisted')).toBeNull();
    expect(explicarMotivo('enviado', null)).toBeNull();
    expect(explicarMotivo('encolado', null)).toBeNull();
  });

  it('el reclamo de spam no se lee como una falla de envio', () => {
    const motivo = explicarMotivo('reclamo', null);

    expect(motivo?.causa).toBe('reclamo');
    expect(motivo?.titulo).toMatch(/no deseado/i);
    // Llego. Decir lo contrario mandaria a soporte a reenviar algo que si esta.
    expect(motivo?.queHacer).toMatch(/llegó/i);
  });

  it('un estado que esta pantalla no conoce no revienta ni se pinta de bueno', () => {
    const ficha = describirEstado('diferido');

    expect(ficha.etiqueta).toBe('diferido');
    expect(ficha.tono).toBe('alerta');
    expect(ficha.llego).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 2. Contrato duplicado contra la API y la migracion                  */
/* ------------------------------------------------------------------ */

describe('los estados son los mismos que en la API', () => {
  const MAIL = join(__dirname, '../../../api/src/mail');
  const MIGRACIONES = join(__dirname, '../../../api/src/database/migrations');

  /** La migracion se busca por nombre: su sello ya cambio una vez. */
  function leerMigracionDeEnvios(): string {
    const archivo = readdirSync(MIGRACIONES).find((nombre) =>
      nombre.endsWith('-CreateMailDeliveries.ts'),
    );
    if (!archivo) throw new Error('No esta la migracion de mail_deliveries');
    return readFileSync(join(MIGRACIONES, archivo), 'utf8');
  }

  it('la lista copiada calza con ESTADOS_ENVIO de registro-envios.types.ts', () => {
    const tipos = readFileSync(join(MAIL, 'registro-envios.types.ts'), 'utf8');
    const bloque = /export const ESTADOS_ENVIO = \[([^\]]+)\]/.exec(tipos);
    expect(bloque).not.toBeNull();

    const declarados = [...(bloque?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((par) => par[1]);
    expect(declarados).toEqual([...ESTADOS_ENVIO]);
  });

  it('la lista copiada calza con el CHECK de la migracion', () => {
    const migracion = leerMigracionDeEnvios();
    const check = /CHECK \(status IN \(([^)]+)\)\)/.exec(migracion);
    expect(check).not.toBeNull();

    const enLaBase = [...(check?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((par) => par[1]);
    expect(enLaBase.sort()).toEqual([...ESTADOS_ENVIO].sort());
  });

  it('cada estado tiene ficha, y solo «entregado» y «reclamo» afirman que llego', () => {
    for (const estado of ESTADOS_ENVIO) {
      expect(CATALOGO_ESTADOS[estado].clave).toBe(estado);
      expect(CATALOGO_ESTADOS[estado].explicacion.length).toBeGreaterThan(0);
    }

    const llegaron = ESTADOS_ENVIO.filter((estado) => CATALOGO_ESTADOS[estado].llego === true);
    expect(llegaron).toEqual(['entregado', 'reclamo']);

    // 'enviado' es «no se sabe», no «llego». Es la confusion que este panel
    // existe para no repetir.
    expect(CATALOGO_ESTADOS.enviado.llego).toBeNull();
    expect(CATALOGO_ESTADOS.enviado.salio).toBe(true);
  });

  it('la clave de plantilla que acepta el filtro es la que admite la columna', () => {
    const migracion = leerMigracionDeEnvios();
    // El CHECK de template_key en la migracion, tal cual.
    expect(migracion).toContain("template_key ~ '^[a-z][a-z0-9:_-]{0,79}$'");

    // Y el filtro no deja pasar nada que ese CHECK rechazaria.
    for (const ficha of CATALOGO_PLANTILLAS) {
      expect(ficha.clave).toMatch(/^[a-z][a-z0-9:_-]{0,79}$/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Filtro                                                           */
/* ------------------------------------------------------------------ */

describe('resolverFiltro', () => {
  it('sin parametros abre con lo ultimo enviado y sin avisos', () => {
    const filtro = resolverFiltro({}, HOY);

    expect(filtro).toMatchObject({
      recinto: '',
      estado: '',
      plantilla: '',
      desde: '',
      hasta: '',
      ronda: '',
      filas: FILAS_POR_DEFECTO,
      ajustado: false,
      fechasIgnoradas: false,
    });
  });

  it('descarta las fechas cuando no hay recinto, y lo dice', () => {
    const filtro = resolverFiltro(
      { [CLAVE_URL.desde]: '2026-08-01', [CLAVE_URL.hasta]: '2026-08-04' },
      HOY,
    );

    // La API responde 400 si llegan fechas sin siteId: el periodo se interpreta
    // en la zona horaria del recinto.
    expect(filtro.desde).toBe('');
    expect(filtro.hasta).toBe('');
    expect(filtro.fechasIgnoradas).toBe(true);
  });

  it('con recinto conserva el periodo', () => {
    const filtro = resolverFiltro(
      {
        [CLAVE_URL.recinto]: RECINTO,
        [CLAVE_URL.desde]: '2026-08-01',
        [CLAVE_URL.hasta]: '2026-08-04',
      },
      HOY,
    );

    expect(filtro).toMatchObject({
      recinto: RECINTO,
      desde: '2026-08-01',
      hasta: '2026-08-04',
      fechasIgnoradas: false,
      ajustado: false,
    });
  });

  it('endereza un periodo al reves y no deja pedir dias que no ocurrieron', () => {
    const alReves = resolverFiltro(
      {
        [CLAVE_URL.recinto]: RECINTO,
        [CLAVE_URL.desde]: '2026-08-04',
        [CLAVE_URL.hasta]: '2026-08-01',
      },
      HOY,
    );
    expect(alReves.hasta).toBe('');
    expect(alReves.ajustado).toBe(true);

    const futuro = resolverFiltro(
      {
        [CLAVE_URL.recinto]: RECINTO,
        [CLAVE_URL.desde]: '2026-08-01',
        [CLAVE_URL.hasta]: '2027-01-01',
      },
      HOY,
    );
    expect(futuro.hasta).toBe(HOY);
    expect(futuro.ajustado).toBe(true);
  });

  it('ignora lo que la API rechazaria y avisa que ajusto', () => {
    const filtro = resolverFiltro(
      {
        [CLAVE_URL.recinto]: 'no-es-uuid',
        [CLAVE_URL.estado]: 'inventado',
        [CLAVE_URL.plantilla]: 'con espacio!',
        [CLAVE_URL.filas]: '75',
      },
      HOY,
    );

    expect(filtro).toMatchObject({
      recinto: '',
      estado: '',
      plantilla: '',
      filas: FILAS_POR_DEFECTO,
      ajustado: true,
    });
  });

  it('acepta los valores buenos, normaliza la plantilla y toma el primero de una clave repetida', () => {
    const filtro = resolverFiltro(
      {
        [CLAVE_URL.estado]: ['rebotado', 'fallido'],
        [CLAVE_URL.plantilla]: 'Informe-Ronda',
        [CLAVE_URL.filas]: '200',
      },
      HOY,
    );

    expect(filtro.estado).toBe('rebotado');
    expect(filtro.plantilla).toBe('informe-ronda');
    expect(filtro.filas).toBe(200);
    expect(filtro.ajustado).toBe(false);
  });

  it('la ronda manda sobre todo lo demas', () => {
    const filtro = resolverFiltro(
      {
        [CLAVE_URL.ronda]: RONDA,
        [CLAVE_URL.recinto]: RECINTO,
        [CLAVE_URL.estado]: 'rebotado',
        [CLAVE_URL.desde]: '2026-08-01',
        [CLAVE_URL.filas]: '200',
      },
      HOY,
    );

    // El endpoint de la ronda no admite filtros ni limite: se limpian aca para
    // que la barra no muestre un filtro que nadie esta aplicando.
    expect(filtro).toMatchObject({
      ronda: RONDA,
      recinto: '',
      estado: '',
      desde: '',
      filas: FILAS_POR_DEFECTO,
    });
  });

  it('una ronda que no es un uuid no se manda a la API', () => {
    const filtro = resolverFiltro({ [CLAVE_URL.ronda]: 'la-de-ayer' }, HOY);

    expect(filtro.ronda).toBe('');
    expect(filtro.ajustado).toBe(true);
  });
});

describe('parametros de la consulta y de la URL', () => {
  it('no manda ningun filtro vacio', () => {
    const filtro = resolverFiltro({}, HOY);
    const consulta = parametrosDeConsulta(filtro);

    // `siteId=` con cadena vacia hace que el DTO responda 400: lo valida como
    // UUID. Lo mismo con el resto.
    expect([...consulta.keys()]).toEqual(['limite']);
    expect(consulta.get('limite')).toBe(String(FILAS_POR_DEFECTO));
  });

  it('traduce el filtro a los nombres que espera la API', () => {
    const filtro = resolverFiltro(
      {
        [CLAVE_URL.recinto]: RECINTO,
        [CLAVE_URL.estado]: 'rebotado',
        [CLAVE_URL.plantilla]: 'informe-ronda',
        [CLAVE_URL.desde]: '2026-08-01',
        [CLAVE_URL.hasta]: '2026-08-04',
        [CLAVE_URL.filas]: '100',
      },
      HOY,
    );
    const consulta = parametrosDeConsulta(filtro);

    expect(consulta.get('siteId')).toBe(RECINTO);
    expect(consulta.get('estado')).toBe('rebotado');
    expect(consulta.get('plantilla')).toBe('informe-ronda');
    expect(consulta.get('desde')).toBe('2026-08-01');
    expect(consulta.get('hasta')).toBe('2026-08-04');
    expect(consulta.get('limite')).toBe('100');
  });

  it('en la URL no viaja ningun correo', () => {
    const filtro = resolverFiltro({ [CLAVE_URL.recinto]: RECINTO }, HOY);
    const url = parametrosDeUrl(filtro).toString();

    expect(url).not.toContain('@');
  });

  it('respeta el filtro de los otros bloques de la pagina y no repite el suyo', () => {
    const parametros = {
      desde: '2026-01-01',
      agrupacion: 'mes',
      aud_accion: 'regla.modificada',
      [CLAVE_URL.estado]: 'rebotado',
    };
    const otros = parametrosAjenos(parametros);

    expect(otros.get('desde')).toBe('2026-01-01');
    expect(otros.get('agrupacion')).toBe('mes');
    expect(otros.get('aud_accion')).toBe('regla.modificada');
    expect(otros.has(CLAVE_URL.estado)).toBe(false);

    const url = parametrosDeUrl(resolverFiltro(parametros, HOY), otros);
    expect(url.get('desde')).toBe('2026-01-01');
    expect(url.get(CLAVE_URL.estado)).toBe('rebotado');
    // El tamaño por defecto no ensucia el enlace.
    expect(url.has(CLAVE_URL.filas)).toBe(false);
  });

  it('con ronda no arrastra filtros que el endpoint de la ronda ignora', () => {
    const filtro: FiltroEnvios = {
      ...resolverFiltro({ [CLAVE_URL.ronda]: RONDA }, HOY),
      filas: 200,
    };
    const url = parametrosDeUrl(filtro);

    expect(url.get(CLAVE_URL.ronda)).toBe(RONDA);
    expect(url.has(CLAVE_URL.filas)).toBe(false);
    expect(url.has(CLAVE_URL.estado)).toBe(false);
  });

  it('recintoPedido lee el recinto antes de resolver el filtro, para la zona horaria', () => {
    expect(recintoPedido({ [CLAVE_URL.recinto]: RECINTO })).toBe(RECINTO);
    expect(recintoPedido({ [CLAVE_URL.recinto]: 'cualquier cosa' })).toBe('');
    expect(recintoPedido({})).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* 4. Resumen y apoyos de la pantalla                                  */
/* ------------------------------------------------------------------ */

describe('resumirEnvios', () => {
  it('separa lo que llego de lo que solo salio', () => {
    const resumen = resumirEnvios([
      envio({ estado: 'entregado', entregadoEn: '2026-08-05T12:00:10.000Z' }),
      envio({ estado: 'enviado' }),
      envio({ estado: 'rebotado' }),
      envio({ estado: 'fallido' }),
      envio({ estado: 'encolado', enviadoEn: null }),
      envio({ estado: 'reclamo' }),
      envio({ estado: 'entregado', encoladoEn: '2026-08-05T18:30:00.000Z' }),
    ]);

    expect(resumen.total).toBe(7);
    // 'reclamo' cuenta como entregado —el correo llego— y ademas se cuenta aparte.
    expect(resumen.entregados).toBe(3);
    expect(resumen.reclamos).toBe(1);
    expect(resumen.sinConfirmar).toBe(1);
    expect(resumen.noLlegaron).toBe(2);
    expect(resumen.enCola).toBe(1);
    expect(resumen.ultimo).toBe('2026-08-05T18:30:00.000Z');
  });

  it('avisa cuando nada tiene confirmacion de entrega, y se calla apenas hay una', () => {
    const sinConfirmacion = resumirEnvios([envio({ estado: 'enviado' })]);
    expect(faltaConfirmacionDeEntrega(sinConfirmacion)).toBe(true);

    const conUna = resumirEnvios([envio({ estado: 'enviado' }), envio({ estado: 'entregado' })]);
    expect(faltaConfirmacionDeEntrega(conUna)).toBe(false);

    // Sin nada que haya salido no hay nada que avisar.
    expect(faltaConfirmacionDeEntrega(resumirEnvios([]))).toBe(false);
  });

  it('junta las plantillas y las rondas presentes para los selectores', () => {
    const lista = [
      envio({ plantilla: 'invitation' }),
      envio({ plantilla: 'report-dispatch:informe', patrolId: RONDA }),
      envio({ plantilla: 'invitation' }),
    ];

    expect(plantillasPresentes(lista)).toEqual(['invitation', 'report-dispatch:informe']);
    expect(rondasPresentes(lista)).toEqual([RONDA]);
  });
});

describe('plantillas', () => {
  it('humaniza una clave que el catalogo no conoce', () => {
    const ficha = describirPlantilla('aviso-nuevo:mensual');

    expect(ficha.clave).toBe('aviso-nuevo:mensual');
    expect(ficha.etiqueta).toBe('Aviso nuevo mensual');
  });

  it('el selector ofrece el catalogo mas lo que aparece en los datos, sin repetir', () => {
    const opciones = opcionesDePlantilla(['report-dispatch:informe', 'aviso-nuevo']);
    const claves = opciones.map((ficha) => ficha.clave);

    expect(new Set(claves).size).toBe(claves.length);
    expect(claves).toContain('aviso-nuevo');
    expect(claves).toContain('sin-clasificar');
    // Las dos familias de claves conviven: la declarada y la deducida de la
    // clave de idempotencia.
    expect(claves).toContain('informe-ronda');
    expect(claves).toContain('report-dispatch:informe');
  });
});

describe('apoyos de la pantalla', () => {
  it('el tamaño de pagina sube hasta el maximo y ahi se detiene', () => {
    expect(siguienteTamano(50)).toBe(100);
    expect(siguienteTamano(100)).toBe(200);
    expect(siguienteTamano(200)).toBeNull();
  });

  it('avisa que puede faltar historia cuando la consulta llego al tope', () => {
    const filtro = resolverFiltro({}, HOY);
    const llenas = Array.from({ length: FILAS_POR_DEFECTO }, () => envio());

    expect(puedeHaberMas(llenas, filtro)).toBe(true);
    expect(puedeHaberMas(llenas.slice(0, 3), filtro)).toBe(false);
  });

  it('la zona horaria sale del recinto elegido', () => {
    const recintos = [
      { id: RECINTO, name: 'Bodega', branchName: 'Norte', timezone: 'Pacific/Easter', isActive: true },
    ];

    expect(zonaDelRecinto(recintos, RECINTO)).toBe('Pacific/Easter');
    expect(zonaDelRecinto(recintos, '')).toBeNull();
    expect(zonaDelRecinto(recintos, RONDA)).toBeNull();
  });

  it('la ronda se nombra sin datos de personas', () => {
    const etiqueta = etiquetaDeRonda({
      id: RONDA,
      siteName: 'Bodega Norte',
      routeName: 'Perímetro',
      status: 'completada',
      scheduledStartAt: '2026-08-04T22:00:00.000Z',
    });

    expect(etiqueta).toBe('Bodega Norte · Perímetro · 2026-08-04');
  });

  it('la referencia corta de un id sirve para cruzarlo y no llena la tabla', () => {
    expect(referenciaCorta(RONDA)).toBe('3f1c2a44');
    expect(referenciaCorta(null)).toBe('—');
  });

  it('esUuid y esEstadoConocido no se dejan engañar', () => {
    expect(esUuid(RONDA)).toBe(true);
    expect(esUuid('3f1c2a44')).toBe(false);
    expect(esEstadoConocido('rebotado')).toBe(true);
    expect(esEstadoConocido('bounced')).toBe(false);
    expect(esEstadoConocido(undefined)).toBe(false);
  });
});
