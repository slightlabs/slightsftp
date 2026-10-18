/**
 * A small in-memory S3 server (path-style) for tests: just enough of the API
 * for the S3 backend - list (v2, with delimiter and paging), head, get (with
 * Range), put, copy, delete and multipart uploads.
 */
import * as http from 'http';
import * as crypto from 'crypto';

interface Obj { body: Buffer; mtime: Date; etag: string }

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  objects: Map<string, Obj>;
  requests: string[];
  close(): Promise<void>;
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function startFakeS3(options: { bucket?: string; pageSize?: number } = {}): Promise<FakeS3> {
  const bucket = options.bucket || 'test-bucket';
  const pageSize = options.pageSize || 1000;
  const objects = new Map<string, Obj>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const requests: string[] = [];

  const error = (res: http.ServerResponse, status: number, code: string) => {
    res.writeHead(status, { 'Content-Type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, 'http://x');
      const parts = url.pathname.split('/').slice(1);
      const b = decodeURIComponent(parts[0] || '');
      const key = parts.slice(1).map(decodeURIComponent).join('/');
      const q = url.searchParams;
      requests.push(`${req.method} ${key}${url.search}`);
      if (!req.headers.authorization) return error(res, 403, 'AccessDenied');
      if (b !== bucket) return error(res, 404, 'NoSuchBucket');

      if (!key && req.method === 'GET') {
        const prefix = q.get('prefix') || '';
        const delimiter = q.get('delimiter') || '';
        const max = Math.min(Number(q.get('max-keys')) || 1000, pageSize);
        const after = q.get('continuation-token') || q.get('start-after') || '';
        const keys = [...objects.keys()].filter(k => k.startsWith(prefix) && k > after).sort();
        const contents: string[] = [];
        const prefixes = new Set<string>();
        let last = '';
        let truncated = false;
        for (const k of keys) {
          if (contents.length + prefixes.size >= max) { truncated = true; break; }
          const rest = k.slice(prefix.length);
          const cut = delimiter ? rest.indexOf(delimiter) : -1;
          if (cut >= 0) {
            const p = prefix + rest.slice(0, cut + 1);
            if (!prefixes.has(p)) prefixes.add(p);
            last = k;
            continue;
          }
          const o = objects.get(k)!;
          contents.push(`<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.mtime.toISOString()}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`);
          last = k;
        }
        // skip the rest of a common prefix so the next page does not repeat it
        if (truncated && delimiter) {
          const rest = last.slice(prefix.length);
          const cut = rest.indexOf(delimiter);
          if (cut >= 0) last = prefix + rest.slice(0, cut + 1) + '￿';
        }
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${contents.length + prefixes.size}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xmlEscape(last)}</NextContinuationToken>` : ''}${contents.join('')}${[...prefixes].map(p => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`);
      }

      if (req.method === 'POST' && q.has('uploads')) {
        const id = crypto.randomBytes(8).toString('hex');
        uploads.set(id, { key, parts: new Map() });
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === 'PUT' && q.has('uploadId')) {
        const up = uploads.get(q.get('uploadId')!);
        if (!up) return error(res, 404, 'NoSuchUpload');
        up.parts.set(Number(q.get('partNumber')), body);
        res.writeHead(200, { ETag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
        return res.end();
      }
      if (req.method === 'POST' && q.has('uploadId')) {
        const up = uploads.get(q.get('uploadId')!);
        if (!up) return error(res, 404, 'NoSuchUpload');
        const data = Buffer.concat([...up.parts.entries()].sort((a, c) => a[0] - c[0]).map(e => e[1]));
        objects.set(up.key, { body: data, mtime: new Date(), etag: crypto.createHash('md5').update(data).digest('hex') });
        uploads.delete(q.get('uploadId')!);
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xmlEscape(up.key)}</Key><ETag>"x"</ETag></CompleteMultipartUploadResult>`);
      }
      if (req.method === 'DELETE' && q.has('uploadId')) {
        uploads.delete(q.get('uploadId')!);
        res.writeHead(204);
        return res.end();
      }

      const obj = objects.get(key);
      switch (req.method) {
        case 'HEAD':
          if (!obj) { res.writeHead(404); return res.end(); }
          res.writeHead(200, { 'Content-Length': obj.body.length, 'Last-Modified': obj.mtime.toUTCString(), ETag: `"${obj.etag}"` });
          return res.end();
        case 'GET': {
          if (!obj) return error(res, 404, 'NoSuchKey');
          const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Number(range[2]) : obj.body.length - 1;
            if (start >= obj.body.length) return error(res, 416, 'InvalidRange');
            res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${obj.body.length}`, ETag: `"${obj.etag}"` });
            return res.end(obj.body.subarray(start, end + 1));
          }
          res.writeHead(200, { 'Content-Length': obj.body.length, 'Last-Modified': obj.mtime.toUTCString(), ETag: `"${obj.etag}"` });
          return res.end(obj.body);
        }
        case 'PUT': {
          const source = req.headers['x-amz-copy-source'] as string | undefined;
          if (source) {
            const src = decodeURIComponent(source.replace(/^\//, '')).split('/').slice(1).join('/');
            const from = objects.get(src);
            if (!from) return error(res, 404, 'NoSuchKey');
            objects.set(key, { ...from, mtime: new Date() });
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            return res.end(`<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"${from.etag}"</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`);
          }
          const etag = crypto.createHash('md5').update(body).digest('hex');
          objects.set(key, { body, mtime: new Date(), etag });
          res.writeHead(200, { ETag: `"${etag}"` });
          return res.end();
        }
        case 'DELETE':
          objects.delete(key);
          res.writeHead(204);
          return res.end();
      }
      error(res, 405, 'MethodNotAllowed');
    });
  });

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as any;
    resolve({
      endpoint: `http://127.0.0.1:${port}`,
      bucket,
      objects,
      requests,
      close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
    });
  }));
}

export function fakeS3Config(s3: FakeS3) {
  return { bucket: s3.bucket, region: 'us-east-1', endpoint: s3.endpoint, accessKeyId: 'test', secretAccessKey: 'test-secret', forcePathStyle: true };
}
