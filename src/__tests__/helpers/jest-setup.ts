// Keep generated TLS certificates and SSH host keys out of the repository
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

if (!process.env.SLIGHTSFTP_CERT_DIR) {
  const dir = path.join(os.tmpdir(), 'slightsftp-test-keys');
  fs.mkdirSync(dir, { recursive: true });
  process.env.SLIGHTSFTP_CERT_DIR = dir;
}

// never call the real GitHub API from tests
process.env.SLIGHTSFTP_NO_UPDATE_CHECK = process.env.SLIGHTSFTP_NO_UPDATE_CHECK || '1';
