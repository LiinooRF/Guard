/**
 * La aplicación tiene que poder CONSTRUIRSE.
 *
 * EL FALLO QUE ESTO IMPIDE
 * ---------------------------------------------------------------------------
 * Se inyectó `AuditService` en `SupervisorService` sin importar el módulo que
 * lo provee. Typecheck en verde, lint en verde, 2.365 pruebas en verde... y la
 * API en bucle de reinicio apenas se desplegó: Nest no podía construir el
 * servicio y moría al levantar, con la web sin arrancar detrás.
 *
 * Ninguna prueba lo vio porque todas instancian los servicios A MANO, con
 * dependencias falsas. Eso comprueba la lógica, no el CABLEADO. El grafo de
 * dependencias solo se valida armándolo.
 *
 * No se levanta un servidor ni se consulta la base: `createTestingModule`
 * resuelve el grafo y con eso alcanza para saber que cada provider encuentra lo
 * que pide. Las variables de entorno son falsas a propósito — varios módulos
 * las exigen al importarse.
 */

process.env.DATABASE_URL ??= 'postgres://falso:falso@localhost:5432/falso';
process.env.MIGRATION_DATABASE_URL ??= process.env.DATABASE_URL;
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SECRET ??= 'secreto-de-prueba-que-no-se-usa-para-firmar-nada-real';
process.env.WEB_PUBLIC_URL ??= 'http://localhost:3000';
process.env.NODE_ENV ??= 'test';

describe('el grafo de dependencias de la aplicación', () => {
  it('Nest puede construir TODOS los módulos', async () => {
    // `require` y no `import`: las variables de arriba tienen que estar puestas
    // ANTES de que se evalúen los módulos, y los import se elevan al principio.
    const { Test } = await import('@nestjs/testing');
    const { DataSource } = await import('typeorm');
    const { AppModule } = await import('./app.module');

    const modulo = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue({
        isInitialized: true,
        query: async () => [],
        manager: { query: async () => [] },
        createQueryRunner: () => ({
          connect: async () => undefined,
          release: async () => undefined,
          query: async () => [],
        }),
      })
      .compile();

    expect(modulo).toBeDefined();
    await modulo.close();
  }, 90_000);
});
