import * as path from 'path';
import { resolveUserPath } from '../path-utils';
import { VirtualPath } from '../types';

const root = path.resolve('/srv/root');
const docs = path.resolve('/data/docs');
const vps: VirtualPath[] = [
  { id: 1, userId: 1, virtualPath: '/', localPath: root },
  { id: 2, userId: 1, virtualPath: '/docs', localPath: docs },
];

describe('resolveUserPath', () => {
  test.each([
    ['/', root],
    ['', root],
    ['/a/b.txt', path.join(root, 'a', 'b.txt')],
    ['a/b.txt', path.join(root, 'a', 'b.txt')],
    ['/./a//b.txt', path.join(root, 'a', 'b.txt')],
    ['\\a\\b.txt', path.join(root, 'a', 'b.txt')],
  ])('maps %p under the root virtual path', (input, expected) => {
    expect(resolveUserPath(vps, input)).toEqual({ virtualPath: vps[0], localPath: expected });
  });

  test('the most specific virtual path wins', () => {
    expect(resolveUserPath(vps, '/docs')!.localPath).toBe(docs);
    expect(resolveUserPath(vps, '/docs/x.pdf')).toEqual({ virtualPath: vps[1], localPath: path.join(docs, 'x.pdf') });
  });

  test('a prefix that is not a path segment does not match', () => {
    expect(resolveUserPath(vps, '/docsX/y')!.localPath).toBe(path.join(root, 'docsX', 'y'));
  });

  test('trailing slashes on configured virtual paths are tolerated', () => {
    const r = resolveUserPath([{ userId: 1, virtualPath: '/pub/', localPath: docs }], '/pub/a');
    expect(r!.localPath).toBe(path.join(docs, 'a'));
  });

  test.each(['/..', '/../etc/passwd', '/docs/../../etc', 'a/../../b', '..\\..\\windows'])('rejects traversal %p', input => {
    expect(resolveUserPath(vps, input)).toBeNull();
  });

  test('returns null when nothing matches or no virtual paths exist', () => {
    expect(resolveUserPath([{ userId: 1, virtualPath: '/only', localPath: docs }], '/other')).toBeNull();
    expect(resolveUserPath([], '/')).toBeNull();
  });
});
