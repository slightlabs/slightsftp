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

describe('Release contents', () => {
  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  test('developer tools live outside src/, so they are never compiled into dist/ or packaged', () => {
    const shipped = fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.ts'));
    const devTools = shipped.filter(f => /^(test-|setup-test|fix-|server-only)/.test(f));
    expect(devTools).toEqual([]);
    // nothing in the shipped code resets an account to the default password
    for (const file of shipped) {
      const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
      expect(source).not.toMatch(/password:\s*['"]admin123['"]/);
    }
  });

  test('the build starts from an empty dist/ and packages no type declarations', () => {
    expect(pkg.scripts.prebuild).toContain("rmSync('dist'");
    expect(pkg.build.files).toEqual(expect.arrayContaining(['!dist/**/*.d.ts', '!dist/**/*.d.ts.map']));
    expect(pkg.build.files.some((f: string) => f.startsWith('tools') || f.startsWith('dist-tools'))).toBe(false);
  });

  test('the Docker image copies only the compiled app', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).not.toMatch(/COPY\s+tools/);
    expect(dockerfile).toMatch(/COPY src \.\/src/);
  });
});
