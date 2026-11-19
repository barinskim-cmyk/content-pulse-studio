/* Подменное хранилище для проверки прослойки без облака: минимум S3 —
   PUT/GET/DELETE объекта, список (list-type=2, prefix, delimiter),
   многочастная загрузка (uploads / partNumber+uploadId / complete).
   Подписи не проверяет. Данные — в памяти. */
'use strict';
const http = require('http');
const crypto = require('crypto');

function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function start() {
  const objects = new Map();   /* key -> Buffer */
  const uploads = new Map();   /* uploadId -> {key, parts: Map<n, Buffer>} */
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const parts = u.pathname.split('/').slice(1).map(decodeURIComponent);
    const key = parts.slice(1).join('/');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const q = u.searchParams;
      const send = (status, text, headers) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/xml' }, headers || {})); res.end(text || ''); };
      if (req.method === 'GET' && !key) {
        const prefix = q.get('prefix') || '', delim = q.get('delimiter');
        const keys = [], dirs = new Set();
        [...objects.keys()].sort().forEach((k) => {
          if (!k.startsWith(prefix)) return;
          const rest = k.slice(prefix.length);
          if (delim && rest.indexOf(delim) !== -1) dirs.add(prefix + rest.slice(0, rest.indexOf(delim) + 1));
          else keys.push(k);
        });
        return send(200, '<ListBucketResult><IsTruncated>false</IsTruncated>' + keys.map((k) => '<Contents><Key>' + xmlEsc(k) + '</Key></Contents>').join('')
          + [...dirs].map((d) => '<CommonPrefixes><Prefix>' + xmlEsc(d) + '</Prefix></CommonPrefixes>').join('') + '</ListBucketResult>');
      }
      if (req.method === 'POST' && q.has('uploads')) {
        const id = crypto.randomBytes(8).toString('hex');
        uploads.set(id, { key, parts: new Map() });
        return send(200, '<InitiateMultipartUploadResult><UploadId>' + id + '</UploadId></InitiateMultipartUploadResult>');
      }
      if (req.method === 'PUT' && q.has('uploadId')) {
        const up = uploads.get(q.get('uploadId'));
        if (!up || up.key !== key) return send(404, '<Error>NoSuchUpload</Error>');
        up.parts.set(+q.get('partNumber'), body);
        return send(200, '', { ETag: '"' + crypto.createHash('md5').update(body).digest('hex') + '"' });
      }
      if (req.method === 'POST' && q.has('uploadId')) {
        const up = uploads.get(q.get('uploadId'));
        if (!up) return send(404, '<Error>NoSuchUpload</Error>');
        const ns = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => +m[1]);
        objects.set(key, Buffer.concat(ns.map((n) => up.parts.get(n))));
        uploads.delete(q.get('uploadId'));
        return send(200, '<CompleteMultipartUploadResult/>');
      }
      if (req.method === 'PUT') { objects.set(key, body); return send(200, '', { ETag: '"x"' }); }
      if (req.method === 'GET') {
        if (!objects.has(key)) return send(404, '<Error>NoSuchKey</Error>');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': objects.get(key).length });
        return res.end(objects.get(key));
      }
      if (req.method === 'DELETE') { objects.delete(key); return send(204); }
      send(400, '<Error>Unsupported</Error>');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, objects, port: server.address().port })));
}

module.exports = { start };
