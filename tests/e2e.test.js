/* Проверка страницы в настоящем Chrome: node tests/e2e.test.js
   Локально поднимаются подменное хранилище (tests/fake-s3.js), прослойка (proxy/index.js)
   и сама страница. Сценарий Маши целиком:
     владелец входит по ключу, создаёт съёмку, загружает кадры, собирает карточки;
     по ссылке редактирования клиент называет себя, переименовывает карточку, согласует;
     владелец правит одновременно — правки склеиваются, ничего не теряется;
     по ссылке скачивания ретушёр видит текущий отбор и скачивает архив
     с разными галками (папками / одной кучей, переименовать / нет). */
'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const fake = require('./fake-s3');

const ROOT = path.join(__dirname, '..');
const OWNER = 'owner-key-for-e2e-test-123';
const UTF = Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
let pass = 0;
const SHOT = (page, name) => process.env.SHOTS ? page.screenshot({ path: path.join(__dirname, 'shot-' + name + '.png') }) : null;
function ok(c, m, extra) { if (!c) throw new Error('FAIL ' + m + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); pass++; console.log('  ok  ' + m); }

/* PNG с цветной заливкой нужного размера — настоящая картинка для превью */
function png(w, h, rgb) {
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(t), d])) >>> 0, 8 + d.length); return b; };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = (x * 7 + y) & 255; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function serve(proxy) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/proxy') {
      const ch = []; req.on('data', (c) => ch.push(c));
      req.on('end', async () => {
        const r = await proxy.handler({ httpMethod: req.method, headers: req.headers, queryStringParameters: Object.fromEntries(u.searchParams), body: Buffer.concat(ch).toString('utf8') });
        res.writeHead(r.statusCode, r.headers); res.end(r.body);
      });
      return;
    }
    const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

(async () => {
  const s3 = await fake.start();
  Object.assign(process.env, { S3_ENDPOINT: 'http://127.0.0.1:' + s3.port, S3_KEY_ID: 'k', S3_SECRET: 's', S3_BUCKET: 'b', OWNER_KEY: OWNER });
  const proxy = require('../proxy/index.js');
  const srv = await serve(proxy);
  const BASE = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined });
  const errors = [];
  async function newPage() {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 900 } });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await ctx.addInitScript((u) => { window.ST_PROXY_OVERRIDE = u; }, BASE + 'proxy');
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    return page;
  }
  const stateOf = (pid) => JSON.parse(s3.objects.get('projects/' + pid + '/state.json').toString());
  const waitSaved = (page) => page.waitForFunction(() => !App.dirty && !ST.saving, null, { timeout: 15000 });

  try {
    console.log('владелец');
    const owner = await newPage();
    await owner.goto(BASE);
    await owner.waitForSelector('#stKey');
    await owner.fill('#stKey', 'wrong-key-wrong');
    await owner.click('[data-st=login]');
    await owner.waitForSelector('.st-err');
    ok(true, 'неверный ключ — ошибка, внутрь не пускает');
    await owner.fill('#stKey', OWNER);
    await owner.click('[data-st=login]');
    await owner.waitForSelector('#stNewName');
    ok(true, 'вход по ключу — список съёмок');
    await owner.fill('#stNewName', '18.11 MSGM тест');
    await owner.press('#stNewName', 'Enter');
    await owner.waitForFunction(() => ST.pid && !document.body.classList.contains('st-booting'));
    const pid = await owner.evaluate(() => ST.pid);
    ok(/^\d{4}-\d\d-\d\d-/.test(pid) && (await owner.textContent('#stProjName')) === '18.11 MSGM тест', 'съёмка создана и открыта', pid);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-e2e-'));
    const files = [['IMG_0001.png', 1200, 1800, [200, 40, 40]], ['IMG_0002.png', 1800, 1200, [40, 200, 40]], ['IMG_0003.png', 1000, 1500, [40, 40, 200]], ['notes.txt']];
    const paths = files.map(([n, w, h, c]) => { const p = path.join(dir, n); fs.writeFileSync(p, n.endsWith('.txt') ? 'не картинка' : png(w, h, c)); return p; });
    await owner.setInputFiles('#stFileInput', paths);
    await owner.waitForFunction(() => App.photos.length === 3 && !ST.uploading, null, { timeout: 30000 });
    await waitSaved(owner);
    let st = stateOf(pid);
    ok(st.photos.length === 3 && st.photos.every((p) => p.fid && p.size > 0 && typeof p.crc === 'number' && !p.dataUrl), 'загружены 3 кадра (txt пропущен), в отборе — размер и CRC, без встроенных картинок');
    ok(st.photos.every((p) => s3.objects.has('projects/' + pid + '/o/' + p.fid) && s3.objects.has('projects/' + pid + '/p/' + p.fid + '.jpg')), 'в хранилище оригиналы и превью');
    ok(st.photos.map((p) => p.name).join('|') === 'IMG_0001.png|IMG_0002.png|IMG_0003.png', 'кадры в галерее по порядку имён, хотя грузились параллельно');
    const orig1 = s3.objects.get('projects/' + pid + '/o/' + st.photos.find((p) => p.name === 'IMG_0001.png').fid);
    ok(Buffer.compare(orig1, fs.readFileSync(paths[0])) === 0, 'оригинал в хранилище байт в байт');
    const thumbs = await owner.$$eval('#cbTrayGrid img', (a) => a.length);
    ok(thumbs === 3, 'превью видны в галерее', thumbs);
    await owner.setInputFiles('#stFileInput', [paths[0]]);
    await owner.waitForTimeout(400);
    ok((await owner.evaluate(() => App.photos.length)) === 3, 'повторная загрузка того же файла — пропущен');

    /* две карточки: в одной два кадра, во второй один; вторая без названия */
    await owner.evaluate(() => {
      const ids = App.photos.map((p) => p.id);
      App.cards.push({ id: cbId(), title: 'Платье 74595', category: '', tplName: 'авто', canvas: 'v', mode: 'auto', hasHero: false, pids: [ids[1], ids[0]], slots: [] });
      App.cards.push({ id: cbId(), title: '', category: '', tplName: 'авто', canvas: 'v', mode: 'auto', hasHero: false, pids: [ids[2]], slots: [] });
      cbMarkDirty(); cbRenderCards();
    });
    await owner.waitForTimeout(1700);
    await waitSaved(owner);
    st = stateOf(pid);
    ok(st.cards.length === 2 && st.cards[0].title === 'Платье 74595', 'карточки сохранились в облако сами (автосохранение)');

    await SHOT(owner, '1-owner');
    await owner.click('.st-bar-right [data-st=links]');
    await owner.waitForSelector('.st-link-in');
    await SHOT(owner, '2-links');
    const [editUrl, dlUrl] = await owner.$$eval('.st-link-in', (a) => a.map((x) => x.value));
    ok(/#t=/.test(editUrl) && /#t=/.test(dlUrl) && editUrl !== dlUrl, 'две ссылки: редактирование и скачивание');
    await owner.click('[data-st=close]');

    console.log('клиент по ссылке редактирования');
    const client = await newPage();
    await client.goto(editUrl);
    await client.waitForSelector('#stName');
    await SHOT(client, '3-name');
    ok(!(await client.isVisible('[data-st=upload]')) && !(await client.isVisible('.st-bar-right [data-st=links]')), 'гостю не видно «Загрузить» и «Ссылки»');
    await client.fill('#stName', 'Анна');
    await client.press('#stName', 'Enter');
    await client.waitForSelector('.cb-card .cb-title');
    ok((await client.$$eval('.cb-card .cb-title', (a) => a.map((x) => x.value))).join('|') === 'Платье 74595|', 'клиент видит карточки владельца');
    ok((await client.$$eval('.cb-card img', (a) => a.filter((i) => i.naturalWidth > 0).length)) === 3, 'и превью кадров по подписанным ссылкам');
    const t2 = (await client.$$('.cb-card .cb-title'))[1];
    await t2.fill('Юбка 100');
    await client.click('.cb-card:first-child .st-approve');
    await client.locator('body').click({ position: { x: 5, y: 5 } });
    await client.waitForTimeout(1700);
    await waitSaved(client);
    st = stateOf(pid);
    ok(st.cards[1].title === 'Юбка 100' && st.cards[0].approved && st.cards[0].approved.by === 'Анна', 'клиент переименовал карточку и согласовал другую');
    ok(st.log.some((e) => e.who === 'Анна' && /согласовал/.test(e.what)), 'в журнале: Анна согласовала');

    console.log('одновременные правки');
    /* владелец ещё на старой ревизии: добавляет карточку и меняет фон первой */
    await owner.evaluate(() => {
      App.cards[0].bg = '#eeeeee';
      App.cards.push({ id: cbId(), title: 'Новая от владельца', category: '', tplName: 'авто', canvas: 'v', mode: 'auto', hasHero: false, pids: [App.photos[2].id], slots: [] });
      cbMarkDirty(); cbRenderCards();
    });
    await owner.waitForTimeout(1700);
    await waitSaved(owner);
    st = stateOf(pid);
    ok(st.cards.length === 3 && st.cards[1].title === 'Юбка 100' && st.cards[0].approved && st.cards[0].bg === '#eeeeee' && st.cards[2].title === 'Новая от владельца',
      'конфликт склеен: правки клиента и владельца обе на месте', st.cards.map((c) => [c.title, c.bg, !!c.approved]));
    await client.waitForTimeout(200);
    await SHOT(client, '4-client');
    const ownerSees = await owner.$$eval('.cb-card .cb-title', (a) => a.map((x) => x.value));
    ok(ownerSees.indexOf('Юбка 100') !== -1, 'владелец видит переименование клиента');

    console.log('ретушёр по ссылке скачивания');
    const ret = await newPage();
    await ret.goto(dlUrl);
    await ret.waitForSelector('.st-v-card');
    await ret.waitForTimeout(300);
    await SHOT(ret, '5-retoucher');
    ok(!(await ret.isVisible('.cb-topbar')) && !(await ret.isVisible('#stName')), 'без редактора и без вопроса об имени');
    const titles = await ret.$$eval('.st-v-title', (a) => a.map((x) => x.firstChild.textContent.trim()));
    ok(titles.join('|') === 'Платье 74595|Юбка 100|Новая от владельца', 'видит текущий отбор с подписями', titles);
    const save = await ret.evaluate(() => fetch(ST_PROXY + '?a=save', { method: 'POST', headers: { 'X-Share-Token': ST.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: ST.pid, baseRev: ST.rev, state: { photos: [], cards: [] } }) }).then((r) => r.status));
    ok(save === 403, 'по ссылке скачивания отбор не сохранить даже вручную');

    async function download(page, opts) {
      await page.click('[data-st=download]:visible');
      await page.waitForSelector('[data-st=dl-go]');
      await page.check('input[name=stScope][value=' + opts.scope + ']');
      if (opts.shot) await SHOT(page, opts.shot);
      if (opts.scope !== 'all') { await page.setChecked('#stDlFolders', opts.folders); await page.setChecked('#stDlRename', opts.rename); }
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('[data-st=dl-go]')]);
      const f = path.join(dir, 'z' + Date.now() + '.zip');
      await dl.saveAs(f);
      /* имя архива — из заголовка ответа хранилища (Chrome в тестовом режиме русские имена показывает как «download») */
      const href = await page.getAttribute('a.st-btnlink', 'href');
      const cd = (await fetch(href)).headers.get('content-disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      await page.click('[data-st=close]');
      execFileSync('unzip', ['-tq', f], { env: UTF });
      return { file: f, suggested: m ? decodeURIComponent(m[1]) : cd, names: execFileSync('unzip', ['-Z1', f], { env: UTF }).toString().trim().split('\n') };
    }
    let z = await download(ret, { scope: 'selection', folders: true, rename: true, shot: '6-download' });
    ok(z.names.join('|') === 'Платье 74595/Платье 74595_1.png|Платье 74595/Платье 74595_2.png|Юбка 100/Юбка 100_1.png|Новая от владельца/Новая от владельца_1.png', 'папками + переименовать: «карточка/карточка_позиция»', z.names);
    ok(z.suggested === '18.11 MSGM тест — отбор.zip', 'имя архива — съёмка и «отбор»', z.suggested);
    const x = fs.mkdtempSync(path.join(os.tmpdir(), 'st-x-'));
    execFileSync('unzip', ['-q', z.file, '-d', x], { env: UTF });
    ok(Buffer.compare(fs.readFileSync(path.join(x, 'Платье 74595/Платье 74595_2.png')), fs.readFileSync(paths[0])) === 0, 'позиция 2 в карточке — тот кадр, что стоит вторым, байт в байт');
    z = await download(ret, { scope: 'selection', folders: false, rename: false });
    ok(z.names.join('|') === 'IMG_0002.png|IMG_0001.png|IMG_0003.png|IMG_0003 (2).png', 'одной кучей, без переименования: исходные имена, повтор — с (2)', z.names);
    z = await download(ret, { scope: 'selection', folders: true, rename: false });
    ok(z.names[0] === 'Платье 74595/IMG_0002.png', 'папками, без переименования', z.names);
    z = await download(ret, { scope: 'all' });
    ok(z.names.join('|') === 'IMG_0001.png|IMG_0002.png|IMG_0003.png', 'все кадры съёмки', z.names);

    console.log('клиент тоже может скачать');
    z = await download(client, { scope: 'selection', folders: false, rename: true });
    ok(z.names.join('|') === 'Платье 74595_1.png|Платье 74595_2.png|Юбка 100_1.png|Новая от владельца_1.png', 'по ссылке редактирования — тоже, одной кучей с переименованием', z.names);

    console.log('смена ссылки');
    await owner.click('.st-bar-right [data-st=links]');
    await owner.waitForSelector('.st-link[data-mode=download] [data-st=rotate]');
    await owner.click('.st-link[data-mode=download] [data-st=rotate]');
    await owner.click('.st-link[data-mode=download] [data-st=rotate]');
    await owner.waitForFunction((old) => document.querySelector('.st-link[data-mode=download] .st-link-in').value !== old, dlUrl);
    const ret2 = await newPage();
    await ret2.goto(dlUrl);
    await ret2.waitForSelector('.st-panel h2');
    ok((await ret2.textContent('.st-panel h2')) === 'Ссылка не работает', 'старая ссылка скачивания больше не открывается');
    const cl2 = await newPage();
    await cl2.goto(editUrl);
    await cl2.waitForSelector('#stName');
    ok(true, 'ссылка редактирования при этом работает');

    console.log('время съёмки');
    /* настоящие JPEG с EXIF: имена нарочно в обратном порядке относительно времени */
    execFileSync('python3', ['-c', [
      'from PIL import Image', 'import sys',
      'd = sys.argv[1]',
      'for name, t, sub in [("B_0001.jpg", "2026:11:18 12:00:03", "0"), ("A_0002.jpg", "2026:11:18 12:00:01", "5"), ("C_0003.jpg", "2026:11:18 12:00:01", "25"), ("0004 1.jpg", None, None)]:',
      '    im = Image.new("RGB", (300, 400), (90, 90, 160)); ex = Image.Exif(); e = ex.get_ifd(0x8769)',
      '    if t: e[0x9003] = t; e[0x9291] = sub',
      '    im.save(d + "/" + name, "JPEG", exif=ex.tobytes())',
    ].join('\n'), dir]);
    await owner.click('#stModalPanel [data-st=close]');
    await owner.click('.st-bar-right [data-st=projects]');
    await owner.waitForSelector('#stNewName');
    await owner.fill('#stNewName', 'EXIF тест');
    await owner.press('#stNewName', 'Enter');
    await owner.waitForFunction(() => App.projectName === 'EXIF тест' && !document.body.classList.contains('st-booting'));
    const pid2 = await owner.evaluate(() => ST.pid);
    await owner.setInputFiles('#stFileInput', ['B_0001.jpg', 'A_0002.jpg', 'C_0003.jpg', '0004 1.jpg'].map((n) => path.join(dir, n)));
    await owner.waitForFunction(() => App.photos.length === 4 && !ST.uploading, null, { timeout: 30000 });
    await waitSaved(owner);
    const trayOrder = (page) => page.$$eval('#cbTrayGrid .cb-thumb', (a) => a.map((x) => cbPhotoById(x.getAttribute('data-pid')).name));
    let order = await trayOrder(owner);
    ok(order.join('|') === 'C_0003.jpg|A_0002.jpg|B_0001.jpg|0004 1.jpg', 'галерея по времени съёмки: доли секунды решают, без времени — в конце', order);
    st = stateOf(pid2);
    ok(st.photos.find((p) => p.name === 'C_0003.jpg').shot === '2026-11-18T12:00:01.250' && st.photos.find((p) => p.name === '0004 1.jpg').shot === '', 'время съёмки сохранено в отборе');

    /* кадры, загруженные раньше (без времени в отборе): страница дочитывает время через прослойку */
    const legacy = stateOf(pid2);
    legacy.photos.forEach((p) => { delete p.shot; });
    legacy.rev += 1;
    s3.objects.set('projects/' + pid2 + '/state.json', Buffer.from(JSON.stringify(legacy)));
    await owner.reload();
    await owner.waitForFunction(() => ST.pid && App.photos.length === 4 && App.photos.every((p) => p.shot !== undefined), null, { timeout: 15000 });
    await waitSaved(owner);
    order = await trayOrder(owner);
    st = stateOf(pid2);
    ok(order.join('|') === 'C_0003.jpg|A_0002.jpg|B_0001.jpg|0004 1.jpg' && st.photos.find((p) => p.name === 'B_0001.jpg').shot === '2026-11-18T12:00:03.000',
      'старые кадры: время дочитано в облаке, сохранено, галерея по времени', order);
    const dlNames = await owner.evaluate(() => stEntries({ scope: 'all' }).map((e) => e.name));
    ok(dlNames.join('|') === 'C_0003.jpg|A_0002.jpg|B_0001.jpg|0004 1.jpg', '«все кадры» в архиве — тоже по времени', dlNames);

    console.log('просмотр крупно и звёздочки');
    await owner.dblclick('#cbTrayGrid .cb-thumb >> nth=0');
    await owner.waitForSelector('#stLb.st-open');
    ok((await owner.textContent('#stLbName')) === 'C_0003.jpg' && (await owner.textContent('#stLbCount')) === '1 / 4', 'двойной клик по кадру галереи — просмотр крупно, тот же порядок');
    await owner.keyboard.press('ArrowRight');
    ok((await owner.textContent('#stLbName')) === 'A_0002.jpg', 'стрелка вправо — следующий кадр');
    await owner.keyboard.press('1');
    ok((await owner.textContent('#stLbStar')) === '★', 'клавиша 1 — отмечен');
    await SHOT(owner, '7-lightbox');
    await owner.keyboard.press('ArrowRight');
    await owner.keyboard.press('1');
    await owner.keyboard.press('0');
    ok((await owner.textContent('#stLbStar')) === '', 'клавиша 0 — отметка снята');
    await owner.click('#stLbImg');
    await owner.waitForFunction(() => /oригинал|\/o\//.test(document.getElementById('stLbImg').src) || /\/o\//.test(document.getElementById('stLbImg').src), null, { timeout: 8000 });
    ok(await owner.$eval('#stLbBody', (b) => b.classList.contains('st-full')), 'клик по кадру — оригинал в 100 %');
    await owner.keyboard.press('Escape');
    ok(!(await owner.isVisible('#stLb')), 'Esc — закрыть');
    await owner.hover('#cbTrayGrid .cb-thumb >> nth=3');
    await owner.keyboard.press('1');
    const starred = await owner.$$eval('#cbTrayGrid .cb-thumb', (a) => a.filter((x) => x.querySelector('.st-star')).map((x) => cbPhotoById(x.getAttribute('data-pid')).name));
    ok(starred.join('|') === 'A_0002.jpg|0004 1.jpg', 'навели мышь на кадр в галерее и нажали 1 — тоже отмечен; звёздочки видны в галерее', starred);
    await owner.click('#stStarOnly');
    ok((await owner.$$eval('#cbTrayGrid .cb-thumb', (a) => a.length)) === 2 && /· 2$/.test(await owner.textContent('#stStarOnly')), '«только отмеченные» — в галерее 2 кадра');

    console.log('новая карточка в поле карточек');
    const nCards = await owner.evaluate(() => App.cards.length);
    await owner.click('.st-addcard');
    ok((await owner.evaluate(() => App.cards.length)) === nCards + 1 && (await owner.evaluate(() => document.activeElement.classList.contains('cb-title'))), '«+ Новая карточка» — карточка-автолента, курсор в названии');
    await owner.keyboard.type('Сумка 555');
    await owner.dragAndDrop('#cbTrayGrid .cb-thumb >> nth=0', '.st-addcard');
    await owner.waitForFunction((n) => App.cards.length === n + 2, nCards);
    ok((await owner.evaluate(() => App.cards[App.cards.length - 1].pids.map((id) => cbPhotoById(id).name).join('|'))) === 'A_0002.jpg', 'кадр брошен на «+» — новая карточка сразу с ним');
    await owner.evaluate(() => { const c = App.cards[App.cards.length - 2]; c.pids = App.photos.filter((p) => p.star).map((p) => p.id); cbMarkDirty(); cbRenderCards(); });
    ok((await owner.$$eval('.cb-card .st-star', (a) => a.length)) === 0, 'в карточках звёздочек нет');
    await owner.click('#stStarOnly');
    await owner.waitForTimeout(1700);
    await waitSaved(owner);
    st = stateOf(pid2);
    ok(st.photos.filter((p) => p.star).map((p) => p.name).sort().join('|') === '0004 1.jpg|A_0002.jpg' && st.photos.find((p) => p.star).star.by, 'отметки сохранены в отборе (кто отметил)');

    console.log('комментарии к карточке');
    await owner.click('#stModalPanel [data-st=close]').catch(() => {});
    await owner.click('.cb-card:has(.cb-title[value="Сумка 555"]) [data-st=com]').catch(async () => {
      const cid = await owner.evaluate(() => App.cards.find((c) => c.title === 'Сумка 555').id);
      await owner.click('.cb-card[data-cid="' + cid + '"] .st-com-btn');
    });
    await owner.waitForSelector('#stComText');
    await owner.fill('#stComText', 'Поправить синенький на ручке\nи убрать складку слева');
    await owner.press('#stComText', 'Meta+Enter');
    await owner.waitForSelector('.st-com-text');
    ok((await owner.textContent('.st-com-text')).indexOf('Поправить синенький') === 0, 'комментарий добавлен (⌘+Enter)');
    await owner.click('#stModalPanel [data-st=close]');
    ok((await owner.textContent('.st-com-line')).indexOf('Поправить синенький на ручке') !== -1, 'на карточке видно строку комментария');
    await owner.evaluate(() => { const el = document.querySelector('.st-com-line'); el.scrollIntoView({ block: 'center' }); });
    await SHOT(owner, '8-card-comment');
    await owner.waitForTimeout(1700);
    await waitSaved(owner);
    const cidBag = await owner.evaluate(() => App.cards.find((c) => c.title === 'Сумка 555').id);

    /* клиент по ссылке пишет свой комментарий к той же карточке одновременно с владельцем */
    await owner.click('.st-bar-right [data-st=links]');
    await owner.waitForSelector('.st-link-in');
    const edit2 = (await owner.$$eval('.st-link-in', (a) => a.map((x) => x.value)))[0];
    await owner.click('#stModalPanel [data-st=close]');
    const cli2 = await newPage();
    await cli2.goto(edit2);
    await cli2.waitForSelector('#stName');
    await cli2.fill('#stName', 'Анна');
    await cli2.press('#stName', 'Enter');
    await cli2.waitForSelector('.cb-card[data-cid="' + cidBag + '"] .st-com-btn');
    await cli2.click('.cb-card[data-cid="' + cidBag + '"] .st-com-btn');
    await cli2.fill('#stComText', 'Фон чуть теплее');
    await cli2.click('[data-st=com-add]');
    await owner.evaluate((cid) => { const c = cbCardById(cid); c.comments.push({ id: 'cx1', by: 'Маша', at: new Date().toISOString(), text: 'Ретушь лёгкая' }); cbMarkDirty(); cbRenderCards(); }, cidBag);
    await cli2.waitForTimeout(1700); await waitSaved(cli2);
    await owner.waitForTimeout(1700); await waitSaved(owner);
    st = stateOf(pid2);
    const coms = st.cards.find((c) => c.id === cidBag).comments.map((c) => c.by + ': ' + c.text.split('\n')[0]);
    ok(coms.length === 3 && coms.indexOf('Анна: Фон чуть теплее') !== -1 && coms.indexOf('Маша: Ретушь лёгкая') !== -1, 'одновременные комментарии двух людей — оба сохранились', coms);

    const zc = await download(owner, { scope: 'selection', folders: true, rename: true });
    const noteName = 'Сумка 555/00_КОММЕНТАРИЙ.jpg';
    ok(zc.names.indexOf(noteName) !== -1 && zc.names.indexOf('Сумка 555/Сумка 555_1.jpg') !== -1, 'в архиве в папке карточки — 00_КОММЕНТАРИЙ.jpg', zc.names);
    const xd = fs.mkdtempSync(path.join(os.tmpdir(), 'st-n-'));
    execFileSync('unzip', ['-q', zc.file, '-d', xd], { env: UTF });
    const dims = execFileSync('python3', ['-c', 'from PIL import Image;import sys;im=Image.open(sys.argv[1]);print(im.format, im.size[0], im.size[1])', path.join(xd, noteName)]).toString().trim();
    ok(/^JPEG 1600 \d+$/.test(dims), 'комментарий — настоящий JPEG 1600 px', dims);
    fs.copyFileSync(path.join(xd, noteName), path.join(__dirname, 'shot-note.jpg'));
    const zf = await download(owner, { scope: 'selection', folders: false, rename: false });
    ok(zf.names.indexOf('Сумка 555_00_КОММЕНТАРИЙ.jpg') !== -1, 'одной кучей — «карточка_00_КОММЕНТАРИЙ.jpg»', zf.names);

    console.log('обрыв загрузки превью');
    /* первый запрос каждого превью рвётся (как при ERR_CERT_VERIFIER_CHANGED или смене сети) — страница догружает сама */
    const flaky = await newPage();
    const seen = {};
    let aborted = 0;
    await flaky.context().route(/\/p\/[A-Za-z0-9_-]+\.jpg/, (route) => {
      const k = new URL(route.request().url()).pathname;
      if (!seen[k]) { seen[k] = 1; aborted++; return route.abort('failed'); }
      return route.continue();
    });
    await flaky.goto(BASE.replace(/\/$/, '') + new URL(editUrl).pathname + new URL(editUrl).hash);
    await flaky.waitForSelector('#stName');
    await flaky.fill('#stName', 'Ретушёр');
    await flaky.press('#stName', 'Enter');
    await flaky.waitForSelector('.cb-card img');
    const reqLog = [];
    flaky.on('request', (r) => { if (/\/p\//.test(r.url())) reqLog.push(new URL(r.url()).pathname.slice(-12) + ' ' + (new URL(r.url()).hash || '')); });
    try {
      await flaky.waitForFunction(() => {
        /* видимые на экране (остальные грузятся лениво, когда до них долистают) */
        const imgs = Array.from(document.querySelectorAll('.cb-card img, #cbTrayGrid img')).filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; });
        return imgs.length >= 3 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      }, null, { timeout: 20000 });
    } catch (e) {
      console.log('requests:', reqLog.join(' | '));
      console.log(await flaky.evaluate(() => Array.from(document.querySelectorAll('.cb-card img')).map((i) => i.getAttribute('data-st-retry') + ':' + i.complete + ':' + i.naturalWidth + ':' + i.src.slice(-20)).join(' | ')));
      throw e;
    }
    ok(aborted >= 3, 'превью, оборванные с первого раза, догрузились сами (оборвано: ' + aborted + ')');

    ok(errors.length === 0, 'без ошибок JavaScript на страницах', errors);
    console.log('\n' + pass + ' проверок в браузере прошли');
  } finally {
    await browser.close();
    srv.close(); s3.server.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
