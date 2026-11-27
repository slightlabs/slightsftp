#!/usr/bin/env node
/**
 * Write a CycloneDX SBOM of the dependencies that ship (no dev dependencies).
 *
 *   npm ci --ignore-scripts
 *   node tools/production-sbom.js > sbom.cdx.json
 *
 * `npm sbom --omit=dev` (npm 10) drops most production packages from this
 * tree, ssh2 and express among them, so this takes the complete `npm sbom`
 * output and removes the packages the lockfile marks as dev-only.
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const lock = require(path.join(root, 'package-lock.json'));

const shipped = new Set();
for (const [location, pkg] of Object.entries(lock.packages || {})) {
  if (!location || pkg.dev) continue;
  const name = pkg.name || location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
  shipped.add(`${name}@${pkg.version}`);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sbom = JSON.parse(execFileSync(npm, ['sbom', '--sbom-format', 'cyclonedx', '--sbom-type', 'application'], {
  cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
}));

const before = sbom.components.length;
sbom.components = sbom.components.filter(c => shipped.has(`${c.name}@${c.version}`));
const kept = new Set([sbom.metadata?.component?.['bom-ref'], ...sbom.components.map(c => c['bom-ref'])]);
sbom.dependencies = (sbom.dependencies || [])
  .filter(d => kept.has(d.ref))
  .map(d => ({ ...d, dependsOn: (d.dependsOn || []).filter(ref => kept.has(ref)) }));

const missing = [...shipped].filter(id => !sbom.components.some(c => `${c.name}@${c.version}` === id));
if (missing.length) {
  console.error(`production-sbom: ${missing.length} shipped packages are not in npm's SBOM: ${missing.slice(0, 10).join(', ')}`);
  process.exit(1);
}
console.error(`production-sbom: ${sbom.components.length} of ${before} components ship`);
process.stdout.write(JSON.stringify(sbom, null, 2) + '\n');
