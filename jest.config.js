module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/test-client.ts',
    '!src/renderer.js',
    '!src/main.ts' // Electron main process is hard to unit test
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  verbose: true,
  testPathIgnorePatterns: [
    '/node_modules/',
    'database.test.ts',
    'sftp-server.test.ts',
    'ftp-server.test.ts',
    'server-manager.test.ts'
  ]
};
