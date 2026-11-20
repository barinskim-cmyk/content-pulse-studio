/* Проверка живой прослойки на настоящем облаке: node tools/smoke.js <папка с ключами> <адрес функции>
   Создаёт временный проект, заливает два кадра, правит отбор по ссылке редактирования,
   проверяет запреты ссылки скачивания, собирает архив, скачивает и сверяет его,
   затем удаляет проект целиком. Ключ владельца не печатает. */
'use strict';
const fs = require('fs');
const path = require('path');
const [dir, url] = process.argv.slice(2);
const owner = fs.readFileSync(path.join(dir, 'owner-key.txt'), 'utf8').trim();
const ORIGIN = 'https://barinskim-cmyk.github.io';
let n = 0;
function ok(c, m, extra) { if (!c) throw new Error('FAIL ' + m + (extra ? ' ' + JSON.stringify(extra) : '')); n++; console.log('  ok  ' + m); }
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return (c ^ -1) >>> 0; }
async function call(a, body, auth, q) {
  const h = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (auth.owner) h['X-Owner-Key'] = auth.owner; if (auth.token) h['X-Share-Token'] = auth.token;
  const r = await fetch(url + '?a=' + a + (q ? '&' + new URLSearchParams(q) : ''), { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), cors: r.headers.get('access-control-allow-origin') };
}
(async () => {
  const O = { owner };
  /* остатки прошлых прогонов */
  for (const p of (await call('projects', null, { owner })).data.projects || []) if (/^Проверка /.test(p.name)) await call('delete', { pid: p.id }, { owner });
  const w = await call('whoami', null, O);
  ok(w.data.role === 'owner' && w.cors === ORIGIN, 'ключ владельца принят, CORS для страницы');
  ok((await call('whoami', null, {})).status === 401, 'без ключа — 401');
  const c = await call('create', { name: 'Проверка ' + new Date().toISOString().slice(0, 16) }, O);
  ok(c.status === 200, 'проект создан');
  const pid = c.data.id, E = { token: c.data.edit }, D = { token: c.data.download };
  try {
    const a = Buffer.from('кадр один ' + 'x'.repeat(3000)), b = Buffer.alloc(200000, 3);
    const up = await call('upload', { pid, op: 'start', files: [{ fid: 'a1', size: a.length }, { fid: 'b2', size: b.length }] }, O);
    for (const [f, buf] of [[up.data.files[0], a], [up.data.files[1], b]]) {
      const r = await fetch(f.put, { method: 'PUT', body: buf, headers: { Origin: ORIGIN } });
      ok(r.status === 200 && r.headers.get('access-control-allow-origin'), 'кадр ' + f.fid + ' залит по подписанной ссылке (CORS бакета ок)');
      await fetch(f.preview, { method: 'PUT', body: Buffer.from('preview') });
    }
    const st = (await call('state', null, O, { pid })).data.state;
    st.photos = [{ fid: 'a1', name: 'IMG_1.jpg', size: a.length, crc: crc32(a) }, { fid: 'b2', name: 'IMG_2.jpg', size: b.length, crc: crc32(b) }];
    st.cards = [{ id: 'c1', name: 'Карточка 1', slots: ['a1', 'b2'] }];
    const s1 = await call('save', { pid, baseRev: st.rev, state: st }, O);
    ok(s1.status === 200, 'владелец записал кадры и карточку', s1.data);
    const g = (await call('state', null, E, { pid })).data.state;
    g.cards[0].name = 'Платье 74595';
    const s2 = await call('save', { pid, baseRev: g.rev, state: g }, E);
    ok(s2.status === 200, 'ссылка редактирования переименовала карточку', s2.data);
    g.photos.push({ fid: 'zz', name: 'x' });
    ok((await call('save', { pid, baseRev: s2.data.rev, state: g }, E)).status === 403, 'ссылка редактирования не добавляет чужие кадры');
    ok((await call('save', { pid, baseRev: s2.data.rev, state: st }, D)).status === 403, 'ссылка скачивания не правит');
    const m = await call('media', { pid, fids: ['a1'] }, D);
    ok((await fetch(m.data.media.a1.preview)).status === 200, 'превью по ссылке скачивания');
    /* комментарий-картинка: браузер заливает JPEG по ссылке прослойки и передаёт его в архив */
    const noteBuf = Buffer.from('JPEG-комментарий ' + 'n'.repeat(500));
    const noteId = require('crypto').randomBytes(16).toString('hex');
    const nt = await call('note', { pid, id: noteId }, D);
    const np = await fetch(nt.data.put, { method: 'PUT', body: noteBuf, headers: { Origin: ORIGIN } });
    ok(nt.status === 200 && np.status === 200, 'комментарий-картинка залита по ссылке скачивания');
    const z = await call('zip', { pid, op: 'start' }, D);
    const p = await call('zip', { pid, op: 'part', key: z.data.key, uploadId: z.data.uploadId, n: 1, offset: 0, final: true, entries: [{ note: noteId, name: 'Платье 74595/00_КОММЕНТАРИЙ.jpg', size: noteBuf.length, crc: crc32(noteBuf) }, { fid: 'a1', name: 'Платье 74595/Платье 74595_1.jpg' }, { fid: 'b2', name: 'Платье 74595/Платье 74595_2.jpg' }] }, D);
    ok(p.status === 200, 'архив собран в облаке');
    const d = await call('zip', { pid, op: 'done', key: z.data.key, uploadId: z.data.uploadId, etags: [p.data.etag], name: 'Проверка' }, D);
    const zr = await fetch(d.data.url);
    const zip = Buffer.from(await zr.arrayBuffer());
    ok(zr.status === 200 && zip.indexOf(b) > 0 && zip.indexOf(Buffer.from('Платье 74595_2.jpg')) > 0, 'архив скачан, внутри кадры и русские имена (' + zip.length + ' байт)');
    ok(zip.indexOf(noteBuf) > 0 && zip.indexOf(Buffer.from('00_КОММЕНТАРИЙ.jpg')) > 0, 'и комментарий-картинка в папке карточки');
    const ex = await call('exif', { pid, fids: ['a1'] }, D);
    ok(ex.status === 200 && ex.data.shot.a1 === '', 'время съёмки читается (у тестового кадра его нет)');
    fs.writeFileSync('/tmp/studio-smoke.zip', zip);
  } finally {
    const del = await call('delete', { pid }, O);
    ok(del.status === 200, 'временный проект удалён (' + del.data.deleted + ' объектов)');
  }
  console.log(n + ' проверок на живом облаке прошли');
})().catch((e) => { console.error(e); process.exit(1); });
