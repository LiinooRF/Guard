import {
  DOMINIOS_RESERVADOS_POR_NORMA,
  dominioDe,
  esDespachable,
  esDominioBloqueado,
  normalizarDominio,
  parsearDominios,
  reglaQueBloquea,
  resolverDominiosNoDespachables,
  separarPorDominio,
} from './mail-dominios';

/**
 * Tests del filtro de dominios no despachables (#86).
 *
 * Lo que se prueba es lo que cuesta caro equivocarse: que `@demo-andina.test`
 * NO salga con la configuracion de fabrica, y que la proteccion no se coma
 * correos legitimos que apenas se parecen.
 */

describe('dominios no despachables', () => {
  describe('dominioDe', () => {
    it('saca el dominio y lo normaliza', () => {
      expect(dominioDe('  Jefa@Empresa.CL ')).toBe('empresa.cl');
    });

    it('corta por la ULTIMA arroba', () => {
      // La parte local puede llevar arrobas si va entre comillas. Partir por la
      // primera dejaria pasar una direccion `.test` disfrazada.
      expect(dominioDe('"a@demo"@ejemplo.test')).toBe('ejemplo.test');
    });

    it('descarta el nombre para mostrar', () => {
      // Sin esto el dominio calculado seria `demo-andina.test>`, que no calza
      // con ninguna regla: la direccion saldria a internet. Fallo ABIERTO.
      expect(dominioDe('Central de Monitoreo <admin@demo-andina.test>')).toBe('demo-andina.test');
      expect(dominioDe('"Rojas, Ana" <ana@empresa.cl>')).toBe('empresa.cl');
    });

    it('ignora el punto final de un FQDN absoluto', () => {
      expect(dominioDe('admin@demo-andina.test.')).toBe('demo-andina.test');
    });

    it('devuelve null cuando no hay dominio', () => {
      for (const invalido of ['', 'sin-arroba', '@solo-dominio.cl', 'sin-dominio@', '   ', '<>']) {
        expect(dominioDe(invalido)).toBeNull();
      }
    });
  });

  describe('esDominioBloqueado', () => {
    it('bloquea el dominio exacto y sus subdominios', () => {
      expect(esDominioBloqueado('test', ['test'])).toBe(true);
      expect(esDominioBloqueado('demo-andina.test', ['test'])).toBe(true);
      expect(esDominioBloqueado('correo.demo-andina.test', ['test'])).toBe(true);
    });

    it('NO bloquea por parecido de texto', () => {
      // Esto es lo que rompe un `includes()`, y el sintoma —"a este cliente no
      // le llega el informe y a los demas si"— es carisimo de diagnosticar.
      expect(esDominioBloqueado('mitest.cl', ['test'])).toBe(false);
      expect(esDominioBloqueado('test.cl', ['test'])).toBe(false);
      expect(esDominioBloqueado('protest.com', ['test'])).toBe(false);
      expect(esDominioBloqueado('example.cl', ['example.com'])).toBe(false);
    });

    it('una entrada vacia nunca es la regla que bloquea', () => {
      // Descarte DEFENSIVO, y el test dice exactamente que cubre. Un dominio
      // normal no lo toca —`empresa.cl` no es `''` ni termina en `.`—, asi que
      // las dos primeras lineas pasan con el descarte y sin el. La que de
      // verdad lo prueba es la tercera: sin `if (bloqueado.length === 0)`, la
      // entrada vacia calza por igualdad con el dominio vacio y `reglaQueBloquea`
      // devuelve `''`, o sea una regla que en el log no contesta nada.
      expect(esDominioBloqueado('empresa.cl', [''])).toBe(false);
      expect(esDominioBloqueado('empresa.cl', ['', 'test'])).toBe(false);
      expect(reglaQueBloquea('', ['', 'test'])).toBeNull();
    });
  });

  describe('reglaQueBloquea', () => {
    it('devuelve la entrada que bloqueo, para poder decir por que en el log', () => {
      expect(reglaQueBloquea('demo-andina.test', resolverDominiosNoDespachables({}))).toBe('test');
      expect(
        reglaQueBloquea(
          'correo.demo-andina.cl',
          resolverDominiosNoDespachables({ MAIL_BLOCKED_DOMAINS: 'demo-andina.cl' }),
        ),
      ).toBe('demo-andina.cl');
    });

    it('null cuando no bloquea nadie', () => {
      expect(reglaQueBloquea('empresa.cl', resolverDominiosNoDespachables({}))).toBeNull();
    });
  });

  describe('esDespachable', () => {
    it('con la lista de fabrica, la cuenta demo no se despacha', () => {
      const lista = resolverDominiosNoDespachables({});
      expect(esDespachable('admin@demo-andina.test', lista)).toBe(false);
      expect(esDespachable('OPERACIONES@Demo-Andina.TEST', lista)).toBe(false);
    });

    it('con la lista de fabrica, un cliente de verdad si', () => {
      const lista = resolverDominiosNoDespachables({});
      expect(esDespachable('jefa@empresa.cl', lista)).toBe(true);
      expect(esDespachable('operaciones@cliente.com', lista)).toBe(true);
    });

    it('una direccion sin dominio no es despachable', () => {
      expect(esDespachable('sin-arroba', [])).toBe(false);
      expect(esDespachable('', [])).toBe(false);
    });

    it('cubre los reservados de RFC 2606 y RFC 6761', () => {
      const lista = resolverDominiosNoDespachables({});
      for (const direccion of [
        'a@algo.test',
        'a@algo.example',
        'a@algo.invalid',
        'a@algo.localhost',
        'a@algo.local',
        'a@example.com',
        'a@example.net',
        'a@example.org',
      ]) {
        expect(esDespachable(direccion, lista)).toBe(false);
      }
      expect(DOMINIOS_RESERVADOS_POR_NORMA).toContain('test');
    });
  });

  describe('resolverDominiosNoDespachables', () => {
    it('el entorno vacio ya protege: no hay que configurar nada', () => {
      expect(resolverDominiosNoDespachables({})).toEqual([...DOMINIOS_RESERVADOS_POR_NORMA]);
    });

    it('la variable de entorno SUMA, no reemplaza', () => {
      const lista = resolverDominiosNoDespachables({
        MAIL_BLOCKED_DOMAINS: 'demo-andina.cl, staging.voxia.cl',
      });
      expect(esDespachable('a@demo-andina.cl', lista)).toBe(false);
      expect(esDespachable('a@staging.voxia.cl', lista)).toBe(false);
      // Y los de norma siguen bloqueados.
      expect(esDespachable('a@demo-andina.test', lista)).toBe(false);
    });

    it('la escotilla de dev solo la abre el literal "true"', () => {
      // Falla cerrada, igual que las politicas de RLS: cualquier otro valor deja
      // la proteccion puesta.
      for (const valor of ['', 'TRUE', 'True', ' true', '1', 'si', undefined]) {
        const lista = resolverDominiosNoDespachables({ MAIL_ALLOW_RESERVED_DOMAINS: valor });
        expect(esDespachable('a@demo-andina.test', lista)).toBe(false);
      }

      const abierta = resolverDominiosNoDespachables({ MAIL_ALLOW_RESERVED_DOMAINS: 'true' });
      expect(esDespachable('a@demo-andina.test', abierta)).toBe(true);
    });

    it('la escotilla NO es el interruptor de encendido de la supresion', () => {
      // Decide si entran los RESERVADOS POR NORMA, no si hay supresion. Con la
      // escotilla abierta la lista propia del equipo sigue bloqueando.
      const lista = resolverDominiosNoDespachables({
        MAIL_ALLOW_RESERVED_DOMAINS: 'true',
        MAIL_BLOCKED_DOMAINS: 'demo-andina.cl',
      });
      expect(esDespachable('a@demo-andina.cl', lista)).toBe(false);
      expect(esDespachable('a@demo-andina.test', lista)).toBe(true);
    });
  });

  describe('parsearDominios', () => {
    it('acepta comas, punto y coma y espacios, y limpia la basura', () => {
      expect(parsearDominios(' A.CL, b.cl;  @c.cl \n .d.cl. ')).toEqual([
        'a.cl',
        'b.cl',
        'c.cl',
        'd.cl',
      ]);
    });

    it('sin valor devuelve lista vacia y no un dominio vacio', () => {
      // Un dominio vacio en la lista haria que `endsWith('.')` bloqueara
      // cualquier direccion: la proteccion se convertiria en un apagon.
      expect(parsearDominios(undefined)).toEqual([]);
      expect(parsearDominios('')).toEqual([]);
      expect(parsearDominios(' , ; ')).toEqual([]);
      expect(normalizarDominio('  ')).toBe('');
    });
  });

  describe('separarPorDominio', () => {
    it('parte la lista y conserva el orden de cada mitad', () => {
      const { despachables, suprimidos } = separarPorDominio(
        [
          { email: 'jefa@empresa.cl' },
          { email: 'admin@demo-andina.test' },
          { email: 'operaciones@cliente.cl' },
        ],
        resolverDominiosNoDespachables({}),
      );

      expect(despachables.map((d) => d.email)).toEqual([
        'jefa@empresa.cl',
        'operaciones@cliente.cl',
      ]);
      expect(suprimidos.map((d) => d.email)).toEqual(['admin@demo-andina.test']);
    });

    it('sin dominios bloqueados no suprime nada', () => {
      const { despachables, suprimidos } = separarPorDominio(
        [{ email: 'admin@demo-andina.test' }],
        [],
      );
      expect(despachables).toHaveLength(1);
      expect(suprimidos).toHaveLength(0);
    });
  });
});
