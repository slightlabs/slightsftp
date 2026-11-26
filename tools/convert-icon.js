// Regenerate build/icon.ico (Windows installer icon) from assets/icon.png:  node tools/convert-icon.js
const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const inputPng = path.join(__dirname, '..', 'assets', 'icon.png');
const outputIco = path.join(__dirname, '..', 'build', 'icon.ico');

(pngToIco.default || pngToIco)(inputPng)
  .then(buf => {
    fs.writeFileSync(outputIco, buf);
    console.log(`✓ ${outputIco} (${Math.round(buf.length / 1024)} KB)`);
  })
  .catch(err => {
    console.error('✗ Conversion failed:', err.message);
    process.exit(1);
  });
