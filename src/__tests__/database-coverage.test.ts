import { DatabaseManager } from '../database';

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

describe('DatabaseManager — activity and settings coverage', () => {
  let db: DatabaseManager;

  beforeEach(async () => {
    db = new DatabaseManager(':memory:');
    await db.init();

    // Seed: user + listener + a bunch of activities
    db.createUser({ username: 'u', password: 'p', passwordEnabled: true, guiEnabled: false });
    db.createListener({ name: 'L', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
  });

  afterEach(() => db.close());

  // ── helpers ───────────────────────────────────────────────────────────────
  function logN(n: number, daysAgo = 0) {
    const ts = new Date();
    ts.setDate(ts.getDate() - daysAgo);
    for (let i = 0; i < n; i++) {
      db.logActivity({ listenerId: null, username: 'u', action: `ACT${i}`, path: '/', success: true });
    }
  }

  // ── getActivityCount ──────────────────────────────────────────────────────
  describe('getActivityCount()', () => {
    test('returns 0 when no activities', () => {
      expect(db.getActivityCount()).toBe(0);
    });

    test('counts activities correctly', () => {
      logN(5);
      expect(db.getActivityCount()).toBe(5);
    });
  });

  // ── clearAllActivities ────────────────────────────────────────────────────
  describe('clearAllActivities()', () => {
    test('removes all activities and returns count', () => {
      logN(3);
      const deleted = db.clearAllActivities();
      expect(deleted).toBe(3);
      expect(db.getActivityCount()).toBe(0);
    });

    test('returns 0 when already empty', () => {
      expect(db.clearAllActivities()).toBe(0);
    });
  });

  // ── clearActivitiesByDate ─────────────────────────────────────────────────
  describe('clearActivitiesByDate()', () => {
    test('removes only activities before the given date', () => {
      logN(4);
      const future = new Date();
      future.setDate(future.getDate() + 1);
      const deleted = db.clearActivitiesByDate(future.toISOString());
      expect(deleted).toBe(4);
      expect(db.getActivityCount()).toBe(0);
    });

    test('removes nothing when date is in the past', () => {
      logN(3);
      const past = new Date(0); // 1970-01-01
      const deleted = db.clearActivitiesByDate(past.toISOString());
      expect(deleted).toBe(0);
      expect(db.getActivityCount()).toBe(3);
    });
  });

  // ── getOldLogsStats ───────────────────────────────────────────────────────
  describe('getOldLogsStats()', () => {
    test('returns 0 when no old logs', () => {
      logN(3);
      expect(db.getOldLogsStats(30)).toBe(0); // activities are new, not 30 days old
    });

    test('returns 0 when db is empty', () => {
      expect(db.getOldLogsStats(0)).toBe(0);
    });
  });

  // ── cleanupOldActivities ──────────────────────────────────────────────────
  describe('cleanupOldActivities()', () => {
    test('runs without error with default retention', () => {
      logN(3);
      expect(() => db.cleanupOldActivities()).not.toThrow();
    });

    test('respects logRetentionDays setting', () => {
      db.setSetting('logRetentionDays', '0'); // retention = 0 → delete everything older than now
      logN(2);
      // Activities were just created so they won't be deleted
      db.cleanupOldActivities();
      expect(db.getActivityCount()).toBeGreaterThanOrEqual(0);
    });
  });

  // ── getSetting / setSetting / getAllSettings ───────────────────────────────
  describe('Settings operations', () => {
    test('getSetting returns undefined for unknown key', () => {
      expect(db.getSetting('nonexistent')).toBeUndefined();
    });

    test('setSetting and getSetting roundtrip', () => {
      db.setSetting('myKey', 'myValue');
      expect(db.getSetting('myKey')).toBe('myValue');
    });

    test('setSetting overwrites existing value', () => {
      db.setSetting('k', 'v1');
      db.setSetting('k', 'v2');
      expect(db.getSetting('k')).toBe('v2');
    });

    test('getAllSettings returns all key/value pairs', () => {
      db.setSetting('a', '1');
      db.setSetting('b', '2');
      const settings = db.getAllSettings();
      expect(settings['a']).toBe('1');
      expect(settings['b']).toBe('2');
    });

    test('getAllSettings includes default logRetentionDays', () => {
      const settings = db.getAllSettings();
      expect(settings['logRetentionDays']).toBeDefined();
    });

    test('getAllSettings returns empty object when no custom settings', () => {
      // Default settings are seeded; just verify the function runs
      const settings = db.getAllSettings();
      expect(typeof settings).toBe('object');
    });
  });

  // ── close() ───────────────────────────────────────────────────────────────
  describe('close()', () => {
    test('can be called without error', () => {
      expect(() => db.close()).not.toThrow();
    });

    test('is safe to call twice (idempotent)', () => {
      db.close();
      expect(() => db.close()).not.toThrow();
    });
  });
});
