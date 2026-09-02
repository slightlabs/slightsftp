import * as fs from 'fs';
import * as path from 'path';

describe('Build Artifact Contracts', () => {
  const packageJsonPath = path.join(process.cwd(), 'package.json');

  test('build script copies required GUI assets to dist', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const buildScript: string = pkg?.scripts?.build || '';

    expect(buildScript).toContain("fs.copyFileSync('src/index.html','dist/index.html')");
    expect(buildScript).toContain("fs.copyFileSync('src/login.html','dist/login.html')");
    expect(buildScript).toContain("fs.copyFileSync('src/admin.html','dist/admin.html')");
    expect(buildScript).toContain("fs.copyFileSync('src/renderer.js','dist/renderer.js')");
  });

  test('packaging config includes all GUI source files', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const files: string[] = pkg?.build?.files || [];

    expect(files).toContain('src/index.html');
    expect(files).toContain('src/login.html');
    expect(files).toContain('src/admin.html');
    expect(files).toContain('src/renderer.js');
  });
});
