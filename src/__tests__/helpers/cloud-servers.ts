/**
 * Cloud storage servers for tests: Azurite (the official Azure Storage
 * emulator) in a child process, plus a fresh container per suite.
 */
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { getFreePort, waitFor } from './test-env';

// Azurite's well-known development account
export const AZURITE_ACCOUNT = 'devstoreaccount1';
export const AZURITE_KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

export interface Azurite {
  endpoint: string;
  connectionString: string;
  stop(): Promise<void>;
}

export async function startAzurite(): Promise<Azurite> {
  const port = await getFreePort();
  const main = path.join(__dirname, '../../../node_modules/azurite/dist/src/blob/main.js');
  const child: ChildProcess = spawn(process.execPath, [
    main, '--blobHost', '127.0.0.1', '--blobPort', String(port),
    '--inMemoryPersistence', '--skipApiVersionCheck', '--silent', '--loose',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', d => { output += d; });
  child.stderr!.on('data', d => { output += d; });
  await waitFor(() => output.includes('successfully listens'), 20000).catch(() => {
    child.kill();
    throw new Error(`Azurite did not start: ${output}`);
  });
  const endpoint = `http://127.0.0.1:${port}/${AZURITE_ACCOUNT}`;
  return {
    endpoint,
    connectionString: `DefaultEndpointsProtocol=http;AccountName=${AZURITE_ACCOUNT};AccountKey=${AZURITE_KEY};BlobEndpoint=${endpoint};`,
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
    }),
  };
}

export async function createAzureContainer(connectionString: string, name: string): Promise<void> {
  const { BlobServiceClient } = require('@azure/storage-blob');
  await BlobServiceClient.fromConnectionString(connectionString).getContainerClient(name).createIfNotExists();
}
