import * as crypto from 'crypto';
import * as path from 'path';

describe('Utility Functions - Enhanced Tests', () => {
  describe('Password Hashing', () => {
    test('should hash password consistently', () => {
      const password = 'testPassword123';
      const hash1 = crypto.createHash('sha256').update(password).digest('hex');
      const hash2 = crypto.createHash('sha256').update(password).digest('hex');

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 produces 64 character hex
    });

    test('should produce different hashes for different passwords', () => {
      const pass1 = 'password1';
      const pass2 = 'password2';

      const hash1 = crypto.createHash('sha256').update(pass1).digest('hex');
      const hash2 = crypto.createHash('sha256').update(pass2).digest('hex');

      expect(hash1).not.toBe(hash2);
    });

    test('should handle empty password', () => {
      const password = '';
      const hash = crypto.createHash('sha256').update(password).digest('hex');

      expect(hash).toHaveLength(64);
    });

    test('should handle special characters', () => {
      const password = 'p@$$w0rd!#%&*()';
      const hash = crypto.createHash('sha256').update(password).digest('hex');

      expect(hash).toHaveLength(64);
    });

    test('should handle unicode characters', () => {
      const password = 'пароль密码パスワード';
      const hash = crypto.createHash('sha256').update(password).digest('hex');

      expect(hash).toHaveLength(64);
    });

    test('should be case sensitive', () => {
      const pass1 = 'Password';
      const pass2 = 'password';

      const hash1 = crypto.createHash('sha256').update(pass1).digest('hex');
      const hash2 = crypto.createHash('sha256').update(pass2).digest('hex');

      expect(hash1).not.toBe(hash2);
    });

    test('should handle very long passwords', () => {
      const password = 'a'.repeat(1000);
      const hash = crypto.createHash('sha256').update(password).digest('hex');

      expect(hash).toHaveLength(64);
    });
  });

  describe('Path Operations', () => {
    test('should normalize paths', () => {
      const testPath = 'C:\\Users\\Test\\..\\Admin\\file.txt';
      const normalized = path.win32.normalize(testPath);

      expect(normalized).toBe('C:\\Users\\Admin\\file.txt');
    });

    test('should join paths correctly', () => {
      const base = 'C:\\Users';
      const sub = 'test\\documents';
      const joined = path.win32.join(base, sub);

      expect(joined).toBe('C:\\Users\\test\\documents');
    });

    test('should resolve relative paths', () => {
      const relative = './test/../docs/file.txt';
      const resolved = path.resolve(relative);

      expect(path.isAbsolute(resolved)).toBe(true);
    });

    test('should get directory name', () => {
      const filePath = 'C:\\Users\\test\\file.txt';
      const dir = path.win32.dirname(filePath);

      expect(dir).toBe('C:\\Users\\test');
    });

    test('should get base name', () => {
      const filePath = 'C:\\Users\\test\\file.txt';
      const base = path.win32.basename(filePath);

      expect(base).toBe('file.txt');
    });

    test('should get extension', () => {
      const filePath = 'C:\\Users\\test\\file.txt';
      const ext = path.win32.extname(filePath);

      expect(ext).toBe('.txt');
    });

    test('should handle paths without extension', () => {
      const filePath = 'C:\\Users\\test\\README';
      const ext = path.win32.extname(filePath);

      expect(ext).toBe('');
    });

    test('should handle POSIX paths', () => {
      const posixPath = '/home/user/documents/file.txt';
      const base = path.posix.basename(posixPath);

      expect(base).toBe('file.txt');
    });

    test('should convert to POSIX format', () => {
      const windowsPath = 'C:\\Users\\test\\file.txt';
      // Remove drive letter and convert backslashes
      const posixPath = windowsPath.substring(2).replace(/\\/g, '/');

      expect(posixPath).toBe('/Users/test/file.txt');
    });
  });

  describe('String Operations', () => {
    test('should trim whitespace', () => {
      const str = '  hello world  ';
      expect(str.trim()).toBe('hello world');
    });

    test('should convert to lowercase', () => {
      const str = 'HELLO World';
      expect(str.toLowerCase()).toBe('hello world');
    });

    test('should convert to uppercase', () => {
      const str = 'hello world';
      expect(str.toUpperCase()).toBe('HELLO WORLD');
    });

    test('should split strings', () => {
      const str = 'apple,banana,orange';
      const parts = str.split(',');

      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('apple');
    });

    test('should replace substrings', () => {
      const str = 'Hello World';
      const replaced = str.replace('World', 'Universe');

      expect(replaced).toBe('Hello Universe');
    });

    test('should check if string includes substring', () => {
      const str = 'Hello World';
      expect(str.includes('World')).toBe(true);
      expect(str.includes('Universe')).toBe(false);
    });

    test('should check if string starts with', () => {
      const str = 'Hello World';
      expect(str.startsWith('Hello')).toBe(true);
      expect(str.startsWith('World')).toBe(false);
    });

    test('should check if string ends with', () => {
      const str = 'Hello World';
      expect(str.endsWith('World')).toBe(true);
      expect(str.endsWith('Hello')).toBe(false);
    });
  });

  describe('Array Operations', () => {
    test('should filter arrays', () => {
      const numbers = [1, 2, 3, 4, 5];
      const even = numbers.filter(n => n % 2 === 0);

      expect(even).toEqual([2, 4]);
    });

    test('should map arrays', () => {
      const numbers = [1, 2, 3];
      const doubled = numbers.map(n => n * 2);

      expect(doubled).toEqual([2, 4, 6]);
    });

    test('should reduce arrays', () => {
      const numbers = [1, 2, 3, 4];
      const sum = numbers.reduce((acc, n) => acc + n, 0);

      expect(sum).toBe(10);
    });

    test('should find elements', () => {
      const users = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' }
      ];
      const found = users.find(u => u.id === 2);

      expect(found?.name).toBe('Bob');
    });

    test('should check if array includes', () => {
      const arr = [1, 2, 3];
      expect(arr.includes(2)).toBe(true);
      expect(arr.includes(4)).toBe(false);
    });

    test('should sort arrays', () => {
      const numbers = [3, 1, 4, 1, 5];
      const sorted = [...numbers].sort((a, b) => a - b);

      expect(sorted).toEqual([1, 1, 3, 4, 5]);
    });

    test('should remove duplicates', () => {
      const arr = [1, 2, 2, 3, 3, 3];
      const unique = [...new Set(arr)];

      expect(unique).toEqual([1, 2, 3]);
    });
  });

  describe('Date Operations', () => {
    test('should create current date', () => {
      const now = new Date();
      expect(now).toBeInstanceOf(Date);
    });

    test('should create specific date', () => {
      const date = new Date('2024-01-01');
      expect(date.getFullYear()).toBe(2024);
      expect(date.getMonth()).toBe(0); // January is 0
    });

    test('should format date to ISO string', () => {
      const date = new Date('2024-01-01T12:00:00Z');
      const iso = date.toISOString();

      expect(iso).toContain('2024-01-01');
    });

    test('should get timestamp', () => {
      const now = Date.now();
      expect(typeof now).toBe('number');
      expect(now).toBeGreaterThan(0);
    });

    test('should calculate time difference', () => {
      const date1 = new Date('2024-01-01T00:00:00Z');
      const date2 = new Date('2024-01-01T01:00:00Z');
      const diff = date2.getTime() - date1.getTime();

      expect(diff).toBe(3600000); // 1 hour in milliseconds
    });

    test('should format date to locale string', () => {
      const date = new Date('2024-01-01T12:00:00Z');
      const str = date.toLocaleString();

      expect(typeof str).toBe('string');
      expect(str.length).toBeGreaterThan(0);
    });
  });

  describe('Object Operations', () => {
    test('should get object keys', () => {
      const obj = { a: 1, b: 2, c: 3 };
      const keys = Object.keys(obj);

      expect(keys).toEqual(['a', 'b', 'c']);
    });

    test('should get object values', () => {
      const obj = { a: 1, b: 2, c: 3 };
      const values = Object.values(obj);

      expect(values).toEqual([1, 2, 3]);
    });

    test('should get object entries', () => {
      const obj = { a: 1, b: 2 };
      const entries = Object.entries(obj);

      expect(entries).toEqual([['a', 1], ['b', 2]]);
    });

    test('should merge objects', () => {
      const obj1 = { a: 1, b: 2 };
      const obj2 = { b: 3, c: 4 };
      const merged = { ...obj1, ...obj2 };

      expect(merged).toEqual({ a: 1, b: 3, c: 4 });
    });

    test('should clone objects', () => {
      const obj = { a: 1, b: { c: 2 } };
      const clone = JSON.parse(JSON.stringify(obj));

      expect(clone).toEqual(obj);
      expect(clone).not.toBe(obj);
    });

    test('should check if property exists', () => {
      const obj = { a: 1, b: 2 };

      expect('a' in obj).toBe(true);
      expect('c' in obj).toBe(false);
    });
  });

  describe('Number Operations', () => {
    test('should parse integers', () => {
      expect(parseInt('123')).toBe(123);
      expect(parseInt('123.45')).toBe(123);
      expect(parseInt('abc')).toBeNaN();
    });

    test('should parse floats', () => {
      expect(parseFloat('123.45')).toBe(123.45);
      expect(parseFloat('123')).toBe(123);
      expect(parseFloat('abc')).toBeNaN();
    });

    test('should check if number is integer', () => {
      expect(Number.isInteger(123)).toBe(true);
      expect(Number.isInteger(123.45)).toBe(false);
    });

    test('should check if NaN', () => {
      expect(Number.isNaN(NaN)).toBe(true);
      expect(Number.isNaN(123)).toBe(false);
    });

    test('should round numbers', () => {
      expect(Math.round(123.45)).toBe(123);
      expect(Math.round(123.56)).toBe(124);
    });

    test('should floor numbers', () => {
      expect(Math.floor(123.99)).toBe(123);
    });

    test('should ceil numbers', () => {
      expect(Math.ceil(123.01)).toBe(124);
    });

    test('should get max value', () => {
      expect(Math.max(1, 2, 3, 4, 5)).toBe(5);
    });

    test('should get min value', () => {
      expect(Math.min(1, 2, 3, 4, 5)).toBe(1);
    });
  });

  describe('Boolean Operations', () => {
    test('should handle truthy values', () => {
      expect(Boolean(1)).toBe(true);
      expect(Boolean('text')).toBe(true);
      expect(Boolean([])).toBe(true);
      expect(Boolean({})).toBe(true);
    });

    test('should handle falsy values', () => {
      expect(Boolean(0)).toBe(false);
      expect(Boolean('')).toBe(false);
      expect(Boolean(null)).toBe(false);
      expect(Boolean(undefined)).toBe(false);
      expect(Boolean(NaN)).toBe(false);
    });

    test('should handle logical AND', () => {
      expect(true && true).toBe(true);
      expect(true && false).toBe(false);
      expect(false && true).toBe(false);
    });

    test('should handle logical OR', () => {
      expect(true || false).toBe(true);
      expect(false || true).toBe(true);
      expect(false || false).toBe(false);
    });

    test('should handle logical NOT', () => {
      expect(!true).toBe(false);
      expect(!false).toBe(true);
    });
  });

  describe('Type Checking', () => {
    test('should check typeof', () => {
      expect(typeof 123).toBe('number');
      expect(typeof 'text').toBe('string');
      expect(typeof true).toBe('boolean');
      expect(typeof undefined).toBe('undefined');
      expect(typeof {}).toBe('object');
      expect(typeof []).toBe('object');
      expect(typeof null).toBe('object');
    });

    test('should check Array.isArray', () => {
      expect(Array.isArray([])).toBe(true);
      expect(Array.isArray({})).toBe(false);
      expect(Array.isArray('text')).toBe(false);
    });

    test('should check instanceof', () => {
      expect(new Date() instanceof Date).toBe(true);
      expect([] instanceof Array).toBe(true);
      expect({} instanceof Object).toBe(true);
    });
  });

  describe('Random Operations', () => {
    test('should generate random numbers', () => {
      const random = Math.random();
      expect(random).toBeGreaterThanOrEqual(0);
      expect(random).toBeLessThan(1);
    });

    test('should generate random integers in range', () => {
      const min = 1;
      const max = 10;
      const random = Math.floor(Math.random() * (max - min + 1)) + min;

      expect(random).toBeGreaterThanOrEqual(min);
      expect(random).toBeLessThanOrEqual(max);
    });

    test('should generate session IDs', () => {
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      expect(typeof sessionId).toBe('string');
      expect(sessionId.startsWith('session_')).toBe(true);
    });
  });

  describe('Error Handling', () => {
    test('should throw and catch errors', () => {
      expect(() => {
        throw new Error('Test error');
      }).toThrow('Test error');
    });

    test('should create custom errors', () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }

      expect(() => {
        throw new CustomError('Custom error');
      }).toThrow(CustomError);
    });

    test('should handle try-catch', () => {
      let caught = false;
      try {
        throw new Error('Test');
      } catch (e) {
        caught = true;
      }

      expect(caught).toBe(true);
    });
  });
});


