/**
 * Jest para la logica pura del panel web (#83).
 *
 * Solo `*.spec.ts`: lo que se prueba es la generacion del formulario desde el
 * catalogo y lo que viaja en el PUT, no el renderizado. Por eso no hace falta
 * jsdom ni testing-library, y el panel no paga bundle por sus pruebas.
 *
 * ts-jest sin diagnosticos: los tipos los revisa `npm run typecheck` con el
 * tsconfig de Next, que es el que manda.
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/app/**/*.spec.ts'],
  /*
   * Limitar el escaneo a app/ y no a todo el workspace. npm deja un enlace
   * node_modules/@voxia/web que apunta a esta misma carpeta, asi que jest
   * indexaria el paquete dos veces y avisaria "Haste module naming collision"
   * en cada corrida: ruido que parece un problema del codigo y no lo es.
   *
   * modulePathIgnorePatterns NO sirve para esto: afecta la resolucion de
   * modulos, no el escaneo que arma el mapa.
   */
  roots: ['<rootDir>/app'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          esModuleInterop: true,
          isolatedModules: true,
          jsx: 'react-jsx',
        },
      },
    ],
  },
};
