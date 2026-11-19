/* Выкладка прослойки Content Pulse Studio в Yandex Cloud Functions.
   Запуск: node tools/deploy.js <ключи-папка>
   В папке ключей (не в репозитории):
     deploy-key.json  авторизованный ключ сервисного аккаунта studio-deploy (роль functions.admin)
     s3-key.json      {S3_KEY_ID, S3_SECRET} статического ключа studio-storage (роль storage.editor)
     config.json      {folderId, bucket, origin}
     owner-key.txt    ключ владельца для входа на страницу (создаётся сам, если нет)
   Что делает:
     1. по авторизованному ключу получает IAM-токен (JWT PS256);
     2. находит или создаёт функцию content-pulse-studio-proxy;
     3. выкладывает новую версию из proxy/index.js с переменными окружения;
     4. делает функцию публичной (без ключа владельца или ссылки она ничего не отдаёт).
   Печатает адрес вызова и id версии (для отката — поставить метку $latest на прежнюю версию). */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FN_NAME = 'content-pulse-studio-proxy';
const FN_API = 'https://serverless-functions.api.cloud.yandex.net/functions/v1';
const OP_API = 'https://operation.api.cloud.yandex.net/operations';

const dir = process.argv[2];
if (!dir) { console.error('node tools/deploy.js <папка с ключами>'); process.exit(2); }
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function iamToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'PS256', kid: key.id }));
  const body = b64url(JSON.stringify({ aud: 'https://iam.api.cloud.yandex.net/iam/v1/tokens', iss: key.service_account_id, iat: now, exp: now + 3600 }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: key.private_key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  const r = await call('POST', 'https://iam.api.cloud.yandex.net/iam/v1/tokens', { jwt: head + '.' + body + '.' + b64url(sig) });
  return r.iamToken;
}

async function call(method, url, body, token) {
  const r = await fetch(url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(method + ' ' + url.replace(/\?.*/, '') + ' -> ' + r.status + ' ' + t.slice(0, 400));
  return t ? JSON.parse(t) : {};
}

async function wait(op, token) {
  while (!op.done) { await new Promise((r) => setTimeout(r, 2000)); op = await call('GET', OP_API + '/' + op.id, null, token); }
  if (op.error) throw new Error('Операция не удалась: ' + JSON.stringify(op.error));
  return op.response || {};
}

/* ZIP из одного файла без сжатия — функции этого достаточно, зависимостей не нужно */
function zipOne(name, data) {
  let c = -1;
  for (let i = 0; i < data.length; i++) { c ^= data[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; }
  const crc = (c ^ -1) >>> 0, n = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(0x81a40000, 38);
  const cdOff = 30 + n.length + data.length, cd = Buffer.concat([ch, n]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(cdOff, 16);
  return Buffer.concat([lh, n, data, cd, end]);
}

(async () => {
  const deployKey = read('deploy-key.json'), s3 = read('s3-key.json'), cfg = read('config.json');
  const ownerFile = path.join(dir, 'owner-key.txt');
  if (!fs.existsSync(ownerFile)) { fs.writeFileSync(ownerFile, b64url(crypto.randomBytes(18)) + '\n', { mode: 0o600 }); console.log('создан ключ владельца:', ownerFile); }
  const ownerKey = fs.readFileSync(ownerFile, 'utf8').trim();

  const tok = await iamToken(deployKey);
  const found = await call('GET', FN_API + '/functions?folderId=' + cfg.folderId + '&filter=' + encodeURIComponent('name="' + FN_NAME + '"'), null, tok);
  let fn = (found.functions || [])[0];
  if (!fn) fn = await wait(await call('POST', FN_API + '/functions', { folderId: cfg.folderId, name: FN_NAME, description: 'Content Pulse Studio: прослойка к облачному хранилищу' }, tok), tok);
  console.log('функция', fn.id);

  const code = fs.readFileSync(path.join(__dirname, '..', 'proxy', 'index.js'));
  const version = {
    functionId: fn.id, entrypoint: 'index.handler',
    resources: { memory: String(512 * 1024 * 1024) }, executionTimeout: '600s',
    content: zipOne('index.js', code).toString('base64'),
    environment: { S3_KEY_ID: s3.S3_KEY_ID, S3_SECRET: s3.S3_SECRET, S3_BUCKET: cfg.bucket, OWNER_KEY: ownerKey, ALLOWED_ORIGINS: cfg.origin },
  };
  let ver;
  for (const runtime of ['nodejs22', 'nodejs18']) {
    try { ver = await wait(await call('POST', FN_API + '/versions', Object.assign({ runtime }, version), tok), tok); console.log('версия', ver.id, runtime); break; } catch (e) { if (runtime === 'nodejs18') throw e; console.log(runtime, 'не подошёл:', String(e.message).slice(0, 160)); }
  }

  await wait(await call('POST', FN_API + '/functions/' + fn.id + ':setAccessBindings', { accessBindings: [{ roleId: 'functions.functionInvoker', subject: { id: 'allUsers', type: 'system' } }] }, tok), tok);
  const url = 'https://functions.yandexcloud.net/' + fn.id;
  console.log('адрес', url);
  const ping = await (await fetch(url + '?a=ping')).json();
  console.log('ping', JSON.stringify(ping));
})().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
