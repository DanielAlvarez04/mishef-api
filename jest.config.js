/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  // Argon2 es deliberadamente caro: con 17 suites en paralelo un hash puede
  // tardar decenas de segundos en una máquina cargada y hacer fallar una prueba
  // correcta. 60 s deja margen sin ocultar un cuelgue de verdad.
  testTimeout: 60000,
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    // @nestjs/jwt v12 es ESM puro; Jest no puede require() ese módulo en Node 22.
    '^@nestjs/jwt$': '<rootDir>/test/stubs/nestjs-jwt.ts',
  },
  collectCoverageFrom: ['**/*.(t|j)s', '!**/*.spec.ts', '!main.ts'],
  coverageDirectory: '../coverage',
};
