/**
 * Docker HEALTHCHECK: is the web GUI answering on WEB_PORT?
 *
 * HTTPS can be on through WEB_HTTPS or the webHttps setting (and usually uses
 * a self-signed certificate), so try HTTPS first without certificate checks,
 * then plain HTTP. Exit code 0 = healthy.
 */
import * as http from 'http';
import * as https from 'https';

const port = Number(process.env.WEB_PORT) || 3000;

function probe(secure: boolean): Promise<boolean> {
  return new Promise(resolve => {
    const options = { host: '127.0.0.1', port, path: '/login', timeout: 4000, rejectUnauthorized: false };
    const req = (secure ? https : http).get(options, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

(async () => {
  const order = process.env.WEB_HTTPS === 'false' ? [false] : [true, false];
  for (const secure of order) {
    if (await probe(secure)) process.exit(0);
  }
  process.exit(1);
})();
