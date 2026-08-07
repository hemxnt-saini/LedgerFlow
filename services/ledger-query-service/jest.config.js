/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Only the pure projector has tests - it runs against an in-memory fake Redis.
  testMatch: ['**/src/**/*.test.ts'],
};
