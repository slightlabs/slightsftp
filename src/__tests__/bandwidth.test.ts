import { RateLimiter, limitFromForm } from '../bandwidth';

describe('RateLimiter', () => {
  test('paces transfers at the configured rate', () => {
    const l = new RateLimiter(1000);
    expect(l.delayFor(500, 0)).toBe(0);
    expect(l.delayFor(500, 0)).toBe(500);
    expect(l.delayFor(1000, 0)).toBe(1000);
    expect(l.delayFor(100, 5000)).toBe(0); // idle time is not banked
  });

  test('form parsing', () => {
    expect(limitFromForm('')).toBeNull();
    expect(limitFromForm('256')).toBe(256);
    expect(() => limitFromForm('-5')).toThrow();
  });
});
