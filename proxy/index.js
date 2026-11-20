/* ============================================================
   Content Pulse Studio — прослойка к облачному хранилищу
   (Yandex Cloud Function + Object Storage).

   Версия без Яндекс Диска: кадры, превью и отбор лежат в закрытом
   бакете. Страница не видит ключей хранилища — прослойка выдаёт ей
   подписанные ссылки и читает/пишет файл отбора.

   Кто может что:
     владелец  — заголовок X-Owner-Key (ключ в переменной OWNER_KEY):
                 все проекты, создание, загрузка кадров, ссылки, удаление;
     по ссылке — заголовок X-Share-Token, у проекта их две, обе бессрочные:
                 «редактирование» — читать и править отбор, подписывать, согласовывать, скачивать;
                 «скачивание»    — смотреть текущий отбор и скачивать (для ретушёров).
                 Владелец может сменить любую ссылку — старая перестаёт работать.

   Устройство бакета:
     projects/<pid>/meta.json    имя, когда создан, токены двух ссылок
     projects/<pid>/state.json   отбор (карточки, подписи, согласования, журнал), поле rev
     projects/<pid>/o/<fid>      оригинал кадра (имя файла — в отборе, ключ — латиница)
     projects/<pid>/p/<fid>.jpg  превью (делает браузер при загрузке)
     shares/<token>.json         {pid, mode: edit|download} — по токену находится проект
     exports/<rand>.zip          архивы скачивания (удаляются правилом бакета через 3 дня)

   Действия (?a=...): ping, whoami, projects, create, share, delete,
   state, save, upload, media, zip, exif.
   ============================================================ */

'use strict';

const crypto = require('crypto');
/* время съёмки из EXIF — общий файл со страницей; в функции лежит рядом с index.js */
const exifTime = (() => { try { return require('./exif-time.js'); } catch (e) { return require('../exif-time.js'); } })();
const http = require('http');
const https = require('https');

/* Адреса страницы, которым разрешено звать прослойку (CORS). */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://barinskim-cmyk.github.io').split(',').map((s) => s.trim()).filter(Boolean);

const MAX_STATE = 3 * 1024 * 1024;          /* файл отбора — в пределах ответа функции */
const UPLOAD_PART = +process.env.UPLOAD_PART || 64 * 1024 * 1024;   /* крупные оригиналы — частями по 64 МБ */
const ZIP_BUDGET_MS = 480000;               /* функция живёт 600 с — запас на завершение */
const LINK_TTL = 3 * 24 * 3600;             /* ссылка на архив — 3 дня, как и сам архив */
const MEDIA_TTL = 6 * 3600;                 /* ссылки на превью — 6 часов */
const PUT_TTL = 12 * 3600;                  /* ссылки на загрузку — 12 часов */

/* ---------- ответы ---------- */

function cors(origin) {
  const ok = ALLOWED_ORIGINS.indexOf(origin) !== -1 || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin || '');
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Owner-Key, X-Share-Token, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(status, obj, h) {
  return { statusCode: status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, h), body: JSON.stringify(obj) };
}

function fail(status, error, extra) { return { status, result: Object.assign({ error }, extra || {}) }; }
function ok(result) { return { status: 200, result }; }

/* ---------- Object Storage (S3, подпись AWS4) ----------
   S3_ENDPOINT — для проверки на подменном хранилище (http://127.0.0.1:порт). */

function s3Conf() {
  const ep = new URL(process.env.S3_ENDPOINT || 'https://storage.yandexcloud.net');
  return {
    proto: ep.protocol, host: ep.host, hostname: ep.hostname, port: ep.port || (ep.protocol === 'https:' ? 443 : 80),
    region: 'ru-central1',
    key: process.env.S3_KEY_ID || '', secret: process.env.S3_SECRET || '', bucket: process.env.S3_BUCKET || '',
  };
}
function s3Ready() { const S = s3Conf(); return !!(S.key && S.secret && S.bucket); }

function hmac(k, str) { return crypto.createHmac('sha256', k).update(str, 'utf8').digest(); }
function sha256hex(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }
function amzDate(d) { return d.toISOString().replace(/[:-]|\.\d{3}/g, ''); }
function uriEnc(str) { return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function s3Path(S, key) { return '/' + S.bucket + (key ? '/' + key.split('/').map(uriEnc).join('/') : ''); }
function s3Query(q) { return Object.keys(q).sort().map((k) => uriEnc(k) + '=' + uriEnc(q[k])).join('&'); }
function s3SigningKey(S, date) {
  let k = hmac('AWS4' + S.secret, date);
  k = hmac(k, S.region); k = hmac(k, 's3');
  return hmac(k, 'aws4_request');
}

/** Подписанные заголовки для запроса к бакету (тело не хешируем: UNSIGNED-PAYLOAD). */
function s3Sign(method, key, query, headers) {
  const S = s3Conf();
  const ad = amzDate(new Date()), date = ad.slice(0, 8);
  const h = { host: S.host, 'x-amz-date': ad, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
  Object.keys(headers || {}).forEach((n) => { h[n.toLowerCase()] = String(headers[n]).trim(); });
  const names = Object.keys(h).sort();
  const qs = s3Query(query || {});
  const canon = [method, s3Path(S, key), qs, names.map((n) => n + ':' + h[n] + '\n').join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = date + '/' + S.region + '/s3/aws4_request';
  const sts = ['AWS4-HMAC-SHA256', ad, scope, sha256hex(canon)].join('\n');
  const sig = crypto.createHmac('sha256', s3SigningKey(S, date)).update(sts, 'utf8').digest('hex');
  h.authorization = 'AWS4-HMAC-SHA256 Credential=' + S.key + '/' + scope + ', SignedHeaders=' + names.join(';') + ', Signature=' + sig;
  return { path: s3Path(S, key) + (qs ? '?' + qs : ''), headers: h };
}

/** Подписанная ссылка (GET — скачать/показать, PUT — залить из браузера). extra — partNumber/uploadId или response-*. */
function s3Presign(method, key, ttl, extra) {
  const S = s3Conf();
  const ad = amzDate(new Date()), date = ad.slice(0, 8);
  const scope = date + '/' + S.region + '/s3/aws4_request';
  const q = Object.assign({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': S.key + '/' + scope, 'X-Amz-Date': ad, 'X-Amz-Expires': String(ttl), 'X-Amz-SignedHeaders': 'host' }, extra || {});
  const qs = s3Query(q);
  const canon = [method, s3Path(S, key), qs, 'host:' + S.host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', ad, scope, sha256hex(canon)].join('\n');
  const sig = crypto.createHmac('sha256', s3SigningKey(S, date)).update(sts, 'utf8').digest('hex');
  return S.proto + '//' + S.host + s3Path(S, key) + '?' + qs + '&X-Amz-Signature=' + sig;
}

/** Ссылка на скачивание с русским именем файла. */
function s3DownloadUrl(key, ttl, filename, contentType) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return s3Presign('GET', key, ttl, {
    'response-content-disposition': 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + uriEnc(filename),
    'response-content-type': contentType || 'application/zip',
  });
}

function transport() { return s3Conf().proto === 'https:' ? https : http; }

/** Короткий запрос к бакету. Ответ: {status, body (строка), headers}. */
function s3Call(method, key, query, body, headers) {
  const S = s3Conf();
  const signed = s3Sign(method, key, query || {}, headers || {});
  return new Promise((resolve, reject) => {
    const req = transport().request({ method, hostname: S.hostname, port: S.port, path: signed.path,
      headers: Object.assign({}, signed.headers, { 'Content-Length': body ? Buffer.byteLength(body) : 0 }) }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: r.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Прочитать JSON-объект из бакета; нет объекта — null. */
async function s3GetJson(key) {
  const r = await s3Call('GET', key);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error('Хранилище не отдало ' + key + ': HTTP ' + r.status);
  return JSON.parse(r.body);
}

async function s3PutJson(key, obj) {
  const r = await s3Call('PUT', key, {}, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
  if (r.status !== 200) throw new Error('Хранилище не приняло ' + key + ': HTTP ' + r.status + ' ' + r.body.slice(0, 200));
}

/** Список ключей по префиксу (с разделителем — «папки» первого уровня). */
async function s3List(prefix, delimiter) {
  const keys = [], dirs = [];
  let token = '';
  for (let guard = 0; guard < 100; guard++) {
    const q = { 'list-type': '2', prefix };
    if (delimiter) q.delimiter = delimiter;
    if (token) q['continuation-token'] = token;
    const r = await s3Call('GET', '', q);
    if (r.status !== 200) throw new Error('Хранилище не отдало список: HTTP ' + r.status);
    (r.body.match(/<Key>[^<]*<\/Key>/g) || []).forEach((m) => keys.push(xmlText(m.slice(5, -6))));
    (r.body.match(/<CommonPrefixes>\s*<Prefix>[^<]*<\/Prefix>/g) || []).forEach((m) => dirs.push(xmlText(/<Prefix>([^<]*)</.exec(m)[1])));
    const t = /<NextContinuationToken>([^<]*)</.exec(r.body);
    if (!/<IsTruncated>true</.test(r.body) || !t) break;
    token = xmlText(t[1]);
  }
  return { keys, dirs };
}

function xmlText(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }

/** Начало объекта (Range) как Buffer; нет объекта — null. */
function s3GetHead(key, bytes) {
  const S = s3Conf();
  const signed = s3Sign('GET', key, {}, {});
  return new Promise((resolve, reject) => {
    const req = transport().request({ method: 'GET', hostname: S.hostname, port: S.port, path: signed.path,
      headers: Object.assign({}, signed.headers, { Range: 'bytes=0-' + (bytes - 1) }) }, (r) => {
      const ch = []; r.on('data', (c) => ch.push(c));
      r.on('end', () => resolve(r.statusCode === 200 || r.statusCode === 206 ? Buffer.concat(ch).subarray(0, bytes) : null));
      r.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Поток объекта из бакета: onChunk(buf) на каждый кусок; возвращает число байт. */
function s3Stream(key, onChunk) {
  const S = s3Conf();
  const signed = s3Sign('GET', key, {}, {});
  return new Promise((resolve, reject) => {
    const req = transport().request({ method: 'GET', hostname: S.hostname, port: S.port, path: signed.path, headers: signed.headers }, (r) => {
      if (r.statusCode !== 200) { r.resume(); reject(new Error('Хранилище не отдало кадр: HTTP ' + r.statusCode)); return; }
      let n = 0, chain = Promise.resolve();
      r.on('data', (c) => {
        n += c.length;
        r.pause();
        chain = chain.then(() => onChunk(c)).then(() => r.resume(), (e) => { r.destroy(e); reject(e); });
      });
      r.on('end', () => chain.then(() => resolve(n), reject));
      r.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** PUT в бакет потоком с известной длиной (кусок многочастной загрузки). */
function s3OpenPut(key, length, query, contentType) {
  const S = s3Conf();
  const signed = s3Sign('PUT', key, query || {}, { 'content-type': contentType || 'application/octet-stream' });
  const req = transport().request({ method: 'PUT', hostname: S.hostname, port: S.port, path: signed.path,
    headers: Object.assign({}, signed.headers, { 'Content-Length': length }) });
  const done = new Promise((res, rej) => {
    req.on('response', (r) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => res({ status: r.statusCode, body: t, etag: r.headers.etag || '' })); });
    req.on('error', rej);
  });
  done.catch(() => { });
  return {
    write(buf) { return new Promise((res, rej) => { const okw = req.write(buf, (e) => (e ? rej(e) : null)); if (okw) res(); else req.once('drain', res); }); },
    end() { req.end(); return done; },
    abort() { try { req.destroy(); } catch (e) { } },
  };
}

async function s3StartMultipart(key, type) {
  const r = await s3Call('POST', key, { uploads: '' }, '', { 'content-type': type || 'application/octet-stream' });
  const m = /<UploadId>([^<]+)<\/UploadId>/.exec(r.body);
  if (r.status !== 200 || !m) throw new Error('Хранилище не начало загрузку: HTTP ' + r.status + ' ' + r.body.slice(0, 200));
  return xmlText(m[1]);
}

async function s3CompleteMultipart(key, uploadId, etags) {
  const xml = '<CompleteMultipartUpload>' + etags.map((e, i) => '<Part><PartNumber>' + (i + 1) + '</PartNumber><ETag>' + String(e).replace(/[<>&]/g, '') + '</ETag></Part>').join('') + '</CompleteMultipartUpload>';
  const r = await s3Call('POST', key, { uploadId }, xml, { 'content-type': 'application/xml' });
  if (r.status !== 200 || /<Error>/.test(r.body)) throw new Error('Хранилище не собрало файл: HTTP ' + r.status + ' ' + r.body.slice(0, 200));
}

/* ---------- доступ ---------- */

const PID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const FID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function newToken() { return crypto.randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function sameSecret(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** Кто зовёт: {role:'owner'} | {role:'guest', pid} | null. */
async function whoCalls(headers) {
  const key = headers['X-Owner-Key'] || headers['x-owner-key'] || '';
  const ownerKey = process.env.OWNER_KEY || '';
  if (key && ownerKey && ownerKey.length >= 12 && sameSecret(key, ownerKey)) return { role: 'owner' };
  const token = headers['X-Share-Token'] || headers['x-share-token'] || '';
  if (token && TOKEN_RE.test(token)) {
    const s = await s3GetJson('shares/' + token + '.json');
    if (s && s.pid && PID_RE.test(s.pid)) return { role: 'guest', pid: s.pid, mode: s.mode === 'download' ? 'download' : 'edit', token };
  }
  return null;
}

/** Проект, к которому относится запрос: владельцу — любой, по ссылке — только свой. */
function projectFor(who, pid) {
  if (!pid || !PID_RE.test(pid)) return null;
  if (who.role === 'owner') return pid;
  return who.pid === pid ? pid : null;
}

const P = (pid) => 'projects/' + pid + '/';

/* ---------- проекты ---------- */

async function doProjects() {
  const { dirs } = await s3List('projects/', '/');
  const out = [];
  for (const d of dirs) {
    const pid = d.slice('projects/'.length, -1);
    if (!PID_RE.test(pid)) continue;
    const meta = await s3GetJson(P(pid) + 'meta.json');
    if (meta) out.push({ id: pid, name: meta.name, created: meta.created, edit: meta.edit, download: meta.download });
  }
  out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return ok({ projects: out });
}

async function doCreate(req) {
  const name = String(req.name || '').trim().slice(0, 200) || 'Без названия';
  const d = new Date();
  const pid = d.toISOString().slice(0, 10) + '-' + crypto.randomBytes(5).toString('hex');
  const meta = { id: pid, name, created: d.toISOString(), edit: newToken(), download: newToken() };
  await s3PutJson(P(pid) + 'meta.json', meta);
  await s3PutJson('shares/' + meta.edit + '.json', { pid, mode: 'edit' });
  await s3PutJson('shares/' + meta.download + '.json', { pid, mode: 'download' });
  await s3PutJson(P(pid) + 'state.json', { rev: 1, name, photos: [], cards: [], log: [{ at: d.toISOString(), who: 'владелец', what: 'создан проект' }] });
  return ok(meta);
}

/** Сменить ссылку (mode: edit | download): старая перестаёт работать, вторая не меняется. */
async function doShare(pid, req) {
  const mode = req.mode === 'download' ? 'download' : 'edit';
  const meta = await s3GetJson(P(pid) + 'meta.json');
  if (!meta) return fail(404, 'Нет такого проекта');
  if (meta[mode]) await s3Call('DELETE', 'shares/' + meta[mode] + '.json');
  meta[mode] = newToken();
  await s3PutJson('shares/' + meta[mode] + '.json', { pid, mode });
  await s3PutJson(P(pid) + 'meta.json', meta);
  return ok({ mode, token: meta[mode] });
}

/** Удалить проект целиком: ссылку, отбор, кадры, превью. */
async function doDelete(pid) {
  const meta = await s3GetJson(P(pid) + 'meta.json');
  for (const t of [meta && meta.edit, meta && meta.download]) if (t) await s3Call('DELETE', 'shares/' + t + '.json');
  const { keys } = await s3List(P(pid));
  let n = 0;
  for (const k of keys) { const r = await s3Call('DELETE', k); if (r.status === 204 || r.status === 200) n++; }
  return ok({ deleted: n });
}

/* ---------- отбор ----------
   save: страница присылает rev, с которой начинала правку. Совпало — пишем rev+1.
   Не совпало (кто-то сохранил раньше) — 409 и текущий отбор: страница склеивает
   свои правки с ним и сохраняет ещё раз. */

async function doState(pid) {
  const s = await s3GetJson(P(pid) + 'state.json');
  if (!s) return fail(404, 'Нет отбора');
  const meta = await s3GetJson(P(pid) + 'meta.json');
  s.name = (meta && meta.name) || s.name;
  return ok({ state: s });
}

async function doSave(pid, req, who) {
  const st = req.state;
  if (!st || typeof st !== 'object' || !Array.isArray(st.photos) || !Array.isArray(st.cards)) return fail(400, 'Нет отбора');
  const body = JSON.stringify(st);
  if (Buffer.byteLength(body) > MAX_STATE) return fail(413, 'Отбор слишком большой');
  const cur = await s3GetJson(P(pid) + 'state.json');
  const curRev = (cur && +cur.rev) || 0;
  if (+req.baseRev !== curRev) return { status: 409, result: { error: 'Отбор уже изменили', state: cur } };
  /* кадры, которых нет в бакете, по ссылке не добавить: гость правит раскладку, а не набор файлов */
  if (who.role !== 'owner' && cur) {
    const known = {};
    (cur.photos || []).forEach((p) => { if (p && p.fid) known[p.fid] = true; });
    if (st.photos.some((p) => p && p.fid && !known[p.fid])) return fail(403, 'По ссылке нельзя добавлять кадры');
  }
  st.rev = curRev + 1;
  st.savedAt = new Date().toISOString();
  await s3PutJson(P(pid) + 'state.json', st);
  return ok({ rev: st.rev, savedAt: st.savedAt });
}

/* ---------- загрузка кадров (владелец) ----------
   start: на каждый файл — ссылка на оригинал (крупный — частями) и на превью.
   done: собрать многочастный оригинал. */

async function doUpload(pid, req) {
  if (req.op === 'start') {
    const files = (req.files || []).slice(0, 200), out = [];
    for (const f of files) {
      if (!FID_RE.test(String(f.fid || ''))) return fail(400, 'Плохой номер кадра');
      const size = +f.size || 0, key = P(pid) + 'o/' + f.fid;
      const item = { fid: f.fid, preview: s3Presign('PUT', P(pid) + 'p/' + f.fid + '.jpg', PUT_TTL) };
      if (size <= UPLOAD_PART) item.put = s3Presign('PUT', key, PUT_TTL);
      else {
        const uploadId = await s3StartMultipart(key, f.type);
        const n = Math.ceil(size / UPLOAD_PART), parts = [];
        for (let k = 1; k <= n; k++) parts.push(s3Presign('PUT', key, PUT_TTL, { partNumber: String(k), uploadId }));
        Object.assign(item, { uploadId, partSize: UPLOAD_PART, parts });
      }
      out.push(item);
    }
    return ok({ files: out });
  }
  if (req.op === 'done') {
    if (!FID_RE.test(String(req.fid || '')) || !req.uploadId || !Array.isArray(req.etags) || !req.etags.length) return fail(400, 'Нет частей');
    await s3CompleteMultipart(P(pid) + 'o/' + req.fid, req.uploadId, req.etags);
    return ok({ ok: true });
  }
  return fail(400, 'Неизвестная операция');
}

/** Ссылки на превью (и при orig — на оригиналы) для показа на странице. */
function doMedia(pid, req) {
  const fids = (req.fids || []).filter((f) => FID_RE.test(String(f))).slice(0, 2000);
  const out = {};
  fids.forEach((f) => {
    out[f] = { preview: s3Presign('GET', P(pid) + 'p/' + f + '.jpg', MEDIA_TTL) };
    if (req.orig) out[f].orig = s3Presign('GET', P(pid) + 'o/' + f, MEDIA_TTL);
  });
  return ok({ media: out, ttl: MEDIA_TTL });
}

/* ---------- время съёмки ----------
   Для кадров, загруженных до того, как страница стала читать EXIF сама: прослойка
   читает начало оригинала (128 КБ) прямо в облаке и отдаёт время съёмки.
   {fids:[...]} -> {shot: {fid: '2026-11-18T12:03:44.120' | ''}} */

async function doExif(pid, req) {
  const fids = (req.fids || []).filter((f) => FID_RE.test(String(f))).slice(0, 300);
  const out = {};
  let next = 0;
  async function worker() {
    while (next < fids.length) {
      const f = fids[next++];
      try { const head = await s3GetHead(P(pid) + 'o/' + f, 131072); out[f] = head ? exifTime(head) : ''; } catch (e) { out[f] = null; }
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  return ok({ shot: out });
}

/* ---------- архив скачивания ----------
   Один ZIP (без сжатия, ZIP64 для больших) собирается многочастной загрузкой в
   бакете: страница шлёт кадры пачками, каждый вызов дописывает свой кусок. CRC и
   размер каждого кадра посчитаны браузером при загрузке и лежат в отборе, поэтому
   кадр читается из бакета один раз. Внутри облака трафик бесплатный.
     start {name}                       -> {key, uploadId}
     part  {key, uploadId, n, offset, entries:[{fid,name,size,crc}], final, prev:[...]}
                                        -> {etag, next, done:[{name,size,crc,offset}]}
     done  {key, uploadId, etags, name} -> {url} (3 дня)
   Кусок, кроме последнего, должен быть не меньше 5 МБ — так требует хранилище;
   страница набирает пачки с запасом. */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32Update(c, buf) { for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return c; }

function dosDateTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

const Z64 = 0xFFFFFFFF;
function needs64(offset) { return offset >= Z64 || process.env.ZIP_FORCE64 === '1'; }

function localHeader(nameBuf, crc, size, dt, v45) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(v45 ? 45 : 20, 4);
  h.writeUInt16LE(0x0800, 6);            /* имена в UTF-8 */
  h.writeUInt16LE(0, 8);                 /* без сжатия */
  h.writeUInt16LE(dt.time, 10);
  h.writeUInt16LE(dt.date, 12);
  h.writeUInt32LE(crc >>> 0, 14);
  h.writeUInt32LE(size, 18);
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, nameBuf]);
}

function centralHeader(nameBuf, crc, size, offset, dt) {
  const big = needs64(offset);
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  /* «сделано в Unix», права 644 — у записей «из MS-DOS» unzip не верит флагу UTF-8 и
     портит русские имена папок карточек; у ZIP64 — версия 4.5 */
  h.writeUInt16LE(big ? 0x032d : 0x0314, 4);
  h.writeUInt16LE(big ? 45 : 20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(dt.time, 12);
  h.writeUInt16LE(dt.date, 14);
  h.writeUInt32LE(crc >>> 0, 16);
  h.writeUInt32LE(size, 20);
  h.writeUInt32LE(size, 24);
  h.writeUInt16LE(nameBuf.length, 28);
  h.writeUInt16LE(big ? 12 : 0, 30);
  h.writeUInt32LE(0x81a40000, 38);
  h.writeUInt32LE(big ? Z64 : offset, 42);
  if (!big) return Buffer.concat([h, nameBuf]);
  const x = Buffer.alloc(12);
  x.writeUInt16LE(0x0001, 0);
  x.writeUInt16LE(8, 2);
  x.writeBigUInt64LE(BigInt(offset), 4);
  return Buffer.concat([h, nameBuf, x]);
}

function endRecord(count, cdSize, cdOffset) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(Math.min(count, 0xFFFF), 8);
  h.writeUInt16LE(Math.min(count, 0xFFFF), 10);
  h.writeUInt32LE(Math.min(cdSize, Z64), 12);
  h.writeUInt32LE(Math.min(cdOffset, Z64), 16);
  if (!(count >= 0xFFFF || cdSize >= Z64 || needs64(cdOffset))) return h;
  const r = Buffer.alloc(56);
  r.writeUInt32LE(0x06064b50, 0);
  r.writeBigUInt64LE(44n, 4);
  r.writeUInt16LE(45, 12);
  r.writeUInt16LE(45, 14);
  r.writeBigUInt64LE(BigInt(count), 24);
  r.writeBigUInt64LE(BigInt(count), 32);
  r.writeBigUInt64LE(BigInt(cdSize), 40);
  r.writeBigUInt64LE(BigInt(cdOffset), 48);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
  loc.writeUInt32LE(1, 16);
  h.writeUInt32LE(Z64, 16);
  return Buffer.concat([r, loc, h]);
}

/** Имя внутри архива: без «..», без ведущих слешей, без запрещённых в Windows знаков. */
function zipName(s) {
  return String(s || '').split('/').map((x) => x.replace(/[\\:*?"<>|\x00-\x1f]/g, '_').trim()).filter((x) => x && x !== '.' && x !== '..').join('/').slice(0, 400) || 'file';
}

async function doZip(pid, req) {
  if (req.op === 'start') {
    const key = 'exports/' + crypto.randomBytes(16).toString('hex') + '.zip';
    const uploadId = await s3StartMultipart(key, 'application/zip');
    return ok({ key, uploadId });
  }
  if (!/^exports\/[0-9a-f]{32}\.zip$/.test(String(req.key || '')) || !req.uploadId) return fail(400, 'Нет архива');
  if (req.op === 'part') {
    const t0 = Date.now();
    const state = await s3GetJson(P(pid) + 'state.json');
    const byFid = {};
    ((state && state.photos) || []).forEach((p) => { if (p && p.fid) byFid[p.fid] = p; });
    const dt = dosDateTime(new Date());
    const entries = (req.entries || []).map((e) => {
      const p = byFid[e.fid];
      if (!p || !FID_RE.test(e.fid)) throw Object.assign(new Error('Кадра нет в отборе: ' + e.fid), { status: 400 });
      if (!(p.size > 0) || typeof p.crc !== 'number') throw Object.assign(new Error('У кадра нет размера или CRC: ' + (p.name || e.fid)), { status: 422 });
      return { fid: e.fid, name: Buffer.from(zipName(e.name || p.name), 'utf8'), size: +p.size, crc: p.crc >>> 0 };
    });
    let offset = +req.offset || 0;
    /* длина куска известна заранее: заголовки + данные (+ оглавление и конец, если последний) */
    let len = 0;
    const plan = [];
    for (const x of entries) { plan.push(Object.assign({ offset: offset + len }, x)); len += 30 + x.name.length + x.size; }
    let tail = Buffer.alloc(0);
    if (req.final) {
      const all = (req.prev || []).map((d) => ({ name: Buffer.from(String(d.name), 'utf8'), size: +d.size, crc: d.crc >>> 0, offset: +d.offset })).concat(plan);
      const cd = Buffer.concat(all.map((d) => centralHeader(d.name, d.crc, d.size, d.offset, dt)));
      tail = Buffer.concat([cd, endRecord(all.length, cd.length, offset + len)]);
    }
    len += tail.length;
    if (!len) return fail(400, 'Пустой кусок');
    const out = s3OpenPut(req.key, len, { partNumber: String(+req.n), uploadId: req.uploadId }, 'application/zip');
    try {
      for (const x of plan) {
        if (Date.now() - t0 > ZIP_BUDGET_MS) throw new Error('Не успели собрать кусок архива — пачка слишком большая');
        await out.write(localHeader(x.name, x.crc, x.size, dt, needs64(x.offset)));
        let c = -1;
        const n = await s3Stream(P(pid) + 'o/' + x.fid, (b) => { c = crc32Update(c, b); return out.write(b); });
        if (n !== x.size) throw new Error(x.name.toString('utf8') + ': размер в хранилище ' + n + ' вместо ' + x.size);
        if (((c ^ -1) >>> 0) !== x.crc) throw new Error(x.name.toString('utf8') + ': файл в хранилище повреждён (CRC)');
      }
      if (tail.length) await out.write(tail);
      const w = await out.end();
      if (w.status !== 200 || !w.etag) throw new Error('Хранилище не приняло кусок архива: HTTP ' + w.status + ' ' + String(w.body || '').slice(0, 200));
      return ok({ n: +req.n, etag: w.etag, next: offset + len - tail.length,
        done: plan.map((d) => ({ name: d.name.toString('utf8'), size: d.size, crc: d.crc, offset: d.offset })) });
    } catch (e) {
      out.abort();
      throw e;
    }
  }
  if (req.op === 'done') {
    if (!Array.isArray(req.etags) || !req.etags.length) return fail(400, 'Нет частей');
    await s3CompleteMultipart(req.key, req.uploadId, req.etags);
    const name = zipName(req.name || 'Отбор') .replace(/\//g, '_') + (/\.zip$/i.test(req.name || '') ? '' : '.zip');
    return ok({ url: s3DownloadUrl(req.key, LINK_TTL, name), expires: new Date(Date.now() + LINK_TTL * 1000).toISOString() });
  }
  return fail(400, 'Неизвестная операция');
}

/* ---------- вход ---------- */

module.exports.handler = async function (event) {
  const headers = event.headers || {};
  const h = cors(headers.Origin || headers.origin || '');
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: h, body: '' };
  const q = event.queryStringParameters || {};
  const a = q.a || '';
  if (a === 'ping') return json(200, { ok: true, storage: s3Ready() }, h);
  if (!s3Ready()) return json(501, { error: 'Хранилище не настроено' }, h);

  let req = {};
  if (event.body) {
    try { req = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body); } catch (e) { return json(400, { error: 'Плохой запрос' }, h); }
  }
  const t0 = Date.now();
  try {
    const who = await whoCalls(headers);
    if (!who) return json(401, { error: 'Нет доступа: нужен ключ владельца или действующая ссылка' }, h);
    if (a === 'whoami') return json(200, who.role === 'owner' ? { role: 'owner' } : { role: 'guest', pid: who.pid, mode: who.mode }, h);

    const ownerOnly = { projects: 1, create: 1, share: 1, delete: 1, upload: 1 };
    if (ownerOnly[a] && who.role !== 'owner') return json(403, { error: 'Это может только владелец' }, h);
    if (a === 'save' && who.mode === 'download') return json(403, { error: 'Эта ссылка — только для скачивания' }, h);
    if (a === 'projects') { const r = await doProjects(); return json(r.status, r.result, h); }
    if (a === 'create') { const r = await doCreate(req); return json(r.status, r.result, h); }

    const pid = projectFor(who, q.pid || req.pid);
    if (!pid) return json(403, { error: 'Нет доступа к проекту' }, h);
    let r;
    if (a === 'share') r = await doShare(pid, req);
    else if (a === 'delete') r = await doDelete(pid);
    else if (a === 'state') r = await doState(pid);
    else if (a === 'save') r = await doSave(pid, req, who);
    else if (a === 'upload') r = await doUpload(pid, req);
    else if (a === 'media') r = doMedia(pid, req);
    else if (a === 'zip') r = await doZip(pid, req);
    else if (a === 'exif') r = await doExif(pid, req);
    else r = fail(400, 'Неизвестное действие');
    console.log(JSON.stringify({ ev: a, op: req.op || undefined, role: who.role, status: r.status, ms: Date.now() - t0 }));
    return json(r.status, r.result, h);
  } catch (e) {
    console.log(JSON.stringify({ ev: 'error', a, error: String(e && e.message || e), ms: Date.now() - t0 }));
    return json(e && e.status || 500, { error: String(e && e.message || e) }, h);
  }
};

module.exports._test = { zipName, crc32Update, s3Presign };
module.exports._s3 = { s3Call, s3Presign, s3PutJson, s3GetJson, s3Conf };
