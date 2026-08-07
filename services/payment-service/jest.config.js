/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Only the pure domain module has tests - they need no Postgres/Redis/Kafka.
  testMatch: ['**/src/**/*.test.ts'],
};
