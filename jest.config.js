module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/__tests__/**',
    // standalone CLI / maintenance scripts, not part of the shipped app logic
    '!src/test-client.ts',
    '!src/test-login.ts',
    '!src/test-vp-permissions.ts',
    '!src/setup-test-users.ts',
    '!src/setup-admin-vpath.ts',
    '!src/fix-admin-gui.ts',
    '!src/fix-admin-permissions.ts',
    '!src/server-only.ts',
    '!src/web-only.ts' // covered by the Playwright web GUI suite (e2e/)
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
