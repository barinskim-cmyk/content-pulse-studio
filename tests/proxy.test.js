/* Проверка прослойки на подменном хранилище: node tests/proxy.test.js
   Полный цикл: владелец создаёт проект и заливает кадры, гость по ссылке
   читает и правит отбор, конфликт правок, запреты, архив (обычный и ZIP64). */
'use strict';
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const fake = require('./fake-s3');

const OWNER = 'owner-key-for-tests-123';
const UTF = Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });   /* unzip читает русские имена только в UTF-8 консоли */
let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ok  ' + msg); }

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; }
  return (c ^ -1) >>> 0;
}

function httpReq(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'Content-Length': body ? body.length : 0 } }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch), headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const s3 = await fake.start();
  Object.assign(process.env, { S3_ENDPOINT: 'http://127.0.0.1:' + s3.port, S3_KEY_ID: 'k', S3_SECRET: 's', S3_BUCKET: 'b', OWNER_KEY: OWNER, UPLOAD_PART: String(1024 * 1024) });
  const proxy = require('../proxy/index.js');

  async function call(a, body, auth, query) {
    const headers = { origin: 'http://localhost:8000' };
    if (auth && auth.owner) headers['x-owner-key'] = auth.owner;
    if (auth && auth.token) headers['x-share-token'] = auth.token;
    const r = await proxy.handler({ httpMethod: body ? 'POST' : 'GET', headers, queryStringParameters: Object.assign({ a }, query || {}), body: body ? JSON.stringify(body) : '' });
    return { status: r.statusCode, data: JSON.parse(r.body || '{}') };
  }
  const O = { owner: OWNER };

  console.log('доступ');
  ok((await call('whoami', null, {})).status === 401, 'без ключа — 401');
  ok((await call('whoami', null, { owner: 'wrong-key-wrong-key' })).status === 401, 'чужой ключ — 401');
  ok((await call('whoami', null, O)).data.role === 'owner', 'ключ владельца — владелец');

  console.log('проект');
  const c = await call('create', { name: 'Тест съёмка' }, O);
  ok(c.status === 200 && c.data.id && c.data.edit && c.data.download && c.data.edit !== c.data.download, 'создан проект с двумя ссылками');
  const pid = c.data.id, G = { token: c.data.edit }, R = { token: c.data.download };
  const c2 = await call('create', { name: 'Чужая' }, O);
  ok((await call('projects', null, O)).data.projects.length === 2, 'владелец видит оба проекта');
  const wg = (await call('whoami', null, G)).data, wr = (await call('whoami', null, R)).data;
  ok(wg.pid === pid && wg.mode === 'edit', 'ссылка редактирования ведёт в свой проект');
  ok(wr.pid === pid && wr.mode === 'download', 'ссылка скачивания — режим «только скачивание»');
  ok((await call('projects', null, G)).status === 403, 'гость не видит список проектов');
  ok((await call('state', null, G, { pid: c2.data.id })).status === 403, 'гость не открывает чужой проект');
  ok((await call('upload', { pid, op: 'start', files: [] }, G)).status === 403, 'гость не загружает кадры');

  console.log('загрузка');
  const small = Buffer.from('jpeg-маленький-' + 'x'.repeat(5000));
  const big = Buffer.alloc(2.5 * 1024 * 1024 + 17, 7); big.write('большой кадр');
  const up = await call('upload', { pid, op: 'start', files: [{ fid: 'f1', size: small.length }, { fid: 'f2', size: big.length }] }, O);
  ok(up.status === 200 && up.data.files[0].put && up.data.files[1].parts.length === 3, 'маленький — одной ссылкой, большой — 3 частями');
  ok((await httpReq('PUT', up.data.files[0].put, small)).status === 200, 'маленький залит');
  await httpReq('PUT', up.data.files[0].preview, Buffer.from('preview1'));
  const f2 = up.data.files[1], etags = [];
  for (let i = 0; i < f2.parts.length; i++) {
    const r = await httpReq('PUT', f2.parts[i], big.subarray(i * f2.partSize, (i + 1) * f2.partSize));
    etags.push(r.headers.etag);
  }
  ok((await call('upload', { pid, op: 'done', fid: 'f2', uploadId: f2.uploadId, etags }, O)).status === 200, 'большой собран из частей');
  ok(Buffer.compare(s3.objects.get('projects/' + pid + '/o/f2'), big) === 0, 'большой в хранилище байт в байт');

  console.log('отбор');
  let st = (await call('state', null, G, { pid })).data.state;
  ok(st.rev === 1 && st.name === 'Тест съёмка', 'гость читает отбор');
  st.photos = [{ fid: 'f1', name: 'IMG_0001.jpg', size: small.length, crc: crc32(small) }, { fid: 'f2', name: 'IMG_0002.jpg', size: big.length, crc: crc32(big) }];
  st.cards = [{ id: 'c1', name: '74595 платье', slots: ['f1', 'f2'] }];
  const s1 = await call('save', { pid, baseRev: 1, state: st }, O);
  ok(s1.status === 200 && s1.data.rev === 2, 'владелец сохранил — rev 2');
  const g = (await call('state', null, G, { pid })).data.state;
  g.cards[0].name = '74595 платье красное'; g.cards[0].approved = true;
  ok((await call('save', { pid, baseRev: 2, state: g }, G)).data.rev === 3, 'гость подписал и согласовал — rev 3');
  const stale = await call('save', { pid, baseRev: 2, state: g }, G);
  ok(stale.status === 409 && stale.data.state.rev === 3, 'устаревшая правка — 409 и свежий отбор для склейки');
  const rs = (await call('state', null, R, { pid })).data.state;
  ok(rs.rev === 3 && rs.cards[0].name === '74595 платье красное', 'ссылка скачивания видит текущий отбор с подписью');
  ok((await call('save', { pid, baseRev: 3, state: rs }, R)).status === 403, 'ссылка скачивания не правит отбор');
  const sneaky = JSON.parse(JSON.stringify(g)); sneaky.photos.push({ fid: 'zzz', name: 'x.jpg' });
  ok((await call('save', { pid, baseRev: 3, state: sneaky }, G)).status === 403, 'гость не подсовывает чужие кадры');
  const ex = await call('exif', { pid, fids: ['f1', 'f2', 'nope'] }, G);
  ok(ex.status === 200 && ex.data.shot.f1 === '' && ex.data.shot.nope === '', 'время съёмки: у не-JPEG и несуществующего — пусто');
  const m = await call('media', { pid, fids: ['f1', '../x'] }, G);
  ok(m.data.media.f1 && !m.data.media['../x'], 'превью по ссылке, мусорный номер отброшен');

  async function zipTest(label, G) {
    const z = await call('zip', { pid, op: 'start' }, G);
    ok(z.status === 200, label + ': архив начат');
    const p1 = await call('zip', { pid, op: 'part', key: z.data.key, uploadId: z.data.uploadId, n: 1, offset: 0, entries: [{ fid: 'f1', name: '74595 платье красное/IMG_0001.jpg' }] }, G);
    ok(p1.status === 200, label + ': кусок 1');
    const p2 = await call('zip', { pid, op: 'part', key: z.data.key, uploadId: z.data.uploadId, n: 2, offset: p1.data.next, final: true, prev: p1.data.done, entries: [{ fid: 'f2', name: '../74595 платье красное/IMG_0002.jpg' }] }, G);
    ok(p2.status === 200, label + ': кусок 2 с оглавлением');
    const d = await call('zip', { pid, op: 'done', key: z.data.key, uploadId: z.data.uploadId, etags: [p1.data.etag, p2.data.etag], name: 'Тест съёмка' }, G);
    ok(d.status === 200 && /response-content-disposition/.test(d.data.url), label + ': ссылка на архив');
    const zipBuf = (await httpReq('GET', d.data.url)).body;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-'));
    fs.writeFileSync(path.join(dir, 'a.zip'), zipBuf);
    let t; try { t = execFileSync("unzip", ["-t", path.join(dir, "a.zip")], { env: UTF }).toString(); } catch (e) { console.log(String(e.stdout)); fs.copyFileSync(path.join(dir, "a.zip"), "/tmp/bad.zip"); throw e; }
    ok(/No errors detected/.test(t), label + ': unzip -t без ошибок');
    execFileSync('unzip', ['-q', path.join(dir, 'a.zip'), '-d', path.join(dir, 'x')], { env: UTF });
    ok(Buffer.compare(fs.readFileSync(path.join(dir, 'x/74595 платье красное/IMG_0002.jpg')), big) === 0, label + ': кадр в папке карточки, «..» вычищено, байт в байт');
  }
  console.log('архив');
  await zipTest('обычный', R);
  process.env.ZIP_FORCE64 = '1';
  await zipTest('ZIP64', G);
  delete process.env.ZIP_FORCE64;

  const broken = JSON.parse(JSON.stringify((await call('state', null, O, { pid })).data.state));
  s3.objects.set('projects/' + pid + '/o/f1', Buffer.from('испорчено'));
  const zb = await call('zip', { pid, op: 'start' }, O);
  const pb = await call('zip', { pid, op: 'part', key: zb.data.key, uploadId: zb.data.uploadId, n: 1, offset: 0, final: true, entries: [{ fid: 'f1' }] }, O);
  ok(pb.status >= 400 && /размер|CRC/.test(pb.data.error), 'повреждённый кадр — понятная ошибка, а не битый архив');
  void broken;

  console.log('ссылка и удаление');
  const sh = await call('share', { pid, mode: 'edit' }, O);
  ok(sh.data.token && sh.data.token !== G.token, 'новая ссылка редактирования');
  ok((await call('state', null, G, { pid })).status === 401, 'старая ссылка редактирования больше не работает');
  ok((await call('state', null, R, { pid })).status === 200, 'ссылка скачивания при этом жива');
  ok((await call('share', { pid }, R)).status === 403, 'гость ссылки не меняет');
  ok((await call('delete', { pid }, O)).data.deleted > 0, 'проект удалён');
  ok(![...s3.objects.keys()].some((k) => k.indexOf(pid) !== -1), 'в хранилище от него ничего не осталось');

  console.log('\n' + pass + ' проверок прошли');
  s3.server.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
