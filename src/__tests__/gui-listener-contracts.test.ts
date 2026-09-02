import * as fs from 'fs';
import * as path from 'path';

function readSource(fileName: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', fileName), 'utf8');
}

describe('Web GUI Listener Contracts', () => {
  test('main process listener statuses append Web GUI server entry', () => {
    const src = readSource('main.ts');

    expect(src).toContain("ipcMain.handle('get-all-listener-statuses'");
    expect(src).toContain("name: 'Web GUI Server'");
    expect(src).toContain("protocol: 'HTTP'");
    expect(src).toContain('id: -1');
  });

  test('web API listener statuses include Web GUI server entry', () => {
    const src = readSource('web-server.ts');

    expect(src).toContain("this.app.get('/api/listener-statuses'");
    expect(src).toContain("name: 'Web GUI Server'");
    expect(src).toContain("protocol: 'HTTP'");
    expect(src).toContain('id: -1');
  });

  test('renderer keeps fallback when backend omits Web GUI status', () => {
    const src = readSource('renderer.js');

    expect(src).toContain('hasWebGuiStatus');
    expect(src).toContain('normalizedStatuses.push({');
    expect(src).toContain("name: 'Web GUI Server'");
    expect(src).toContain("protocol: 'HTTP'");
    expect(src).toContain('id: -1');
  });
});
