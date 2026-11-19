/* ============================================================
   Content Pulse Studio — облачная часть страницы поверх Cardboard.

   Без Яндекс Диска: съёмка = проект в закрытом бакете Yandex Cloud.
   Кадры, превью и отбор ходят через прослойку (proxy/index.js).

   Кто открывает страницу:
     владелец         — по своему ключу (вводится один раз, хранится в этом браузере):
                        съёмки, загрузка кадров, две ссылки, удаление;
     ссылка «#t=...»  — режим берётся у прослойки:
                        edit     — Cardboard целиком: карточки, подписи, согласование, скачивание;
                        download — только просмотр текущего отбора и скачивание.

   Состояние отбора — файл state.json в бакете с номером ревизии. Сохраняем с той
   ревизией, с которой начинали; если кто-то успел раньше (409) — склеиваем три
   версии (исходную, нашу, их) по карточкам и сохраняем ещё раз.

   Префикс функций — st*. ES5, без фреймворков, как Cardboard.
   ============================================================ */

var ST_VERSION = '0.1.0';
var ST_PROXY = 'https://functions.yandexcloud.net/d4e00ctqnc5ki2n86c7c';
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && window.ST_PROXY_OVERRIDE) ST_PROXY = window.ST_PROXY_OVERRIDE;

var ST = {
  role: '',          /* owner | guest */
  mode: '',          /* edit | download (для владельца — edit) */
  ownerKey: '',
  token: '',
  pid: '',
  meta: null,        /* {id, name, edit, download} — у владельца */
  rev: 0,            /* ревизия отбора, с которой мы работаем */
  base: null,        /* отбор этой ревизии — для склейки при конфликте */
  saving: false,
  again: false,
  editSeq: 0,
  media: {},         /* fid -> ссылка на превью */
  mediaAt: 0,
  uploading: false,
  name: '',
  pollTimer: 0
};

/* ---------- мелочи ---------- */

function stEsc(s) { return cbEsc(s); }
function stClone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
function stSame(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
function stGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function stSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { } }
function stNow() { return new Date().toISOString(); }
function stTime(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('ru-RU').slice(0, 5);
}
function stRandId(prefix) {
  var a = new Uint8Array(8);
  (window.crypto || window.msCrypto).getRandomValues(a);
  var s = '';
  for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
  return (prefix || 'f') + s;
}
function stSize(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' ГБ';
  if (n >= 1048576) return Math.round(n / 1048576) + ' МБ';
  return Math.max(1, Math.round(n / 1024)) + ' КБ';
}

/* ---------- прослойка ---------- */

function stCall(action, body, query) {
  var headers = { 'Content-Type': 'application/json' };
  if (ST.token) headers['X-Share-Token'] = ST.token;
  else if (ST.ownerKey) headers['X-Owner-Key'] = ST.ownerKey;
  var url = ST_PROXY + '?a=' + action;
  Object.keys(query || {}).forEach(function (k) { url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); });
  return fetch(url, { method: body ? 'POST' : 'GET', headers: headers, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; });
    });
}

/** Тот же вызов, но ошибка (не 2xx) — исключение с текстом от прослойки. */
function stCallOk(action, body, query) {
  return stCall(action, body, query).then(function (r) {
    if (r.status >= 200 && r.status < 300) return r.data;
    var e = new Error(r.data.error || ('Ошибка ' + r.status));
    e.status = r.status; e.data = r.data;
    throw e;
  });
}

/* ---------- модальное окно Studio ---------- */

function stModal(html, opts) {
  var m = document.getElementById('stModal');
  var p = document.getElementById('stModalPanel');
  p.className = 'cb-panel st-panel' + (opts && opts.wide ? ' st-wide' : '');
  p.innerHTML = (opts && opts.closable === false ? '' : '<button class="cb-modal-x" data-st="close" title="Закрыть">×</button>') + html;
  m.classList.add('cb-open');
  m.setAttribute('data-closable', opts && opts.closable === false ? '0' : '1');
  var first = p.querySelector('input[autofocus]');
  if (first) setTimeout(function () { first.focus(); }, 30);
  return p;
}
function stModalClose() { document.getElementById('stModal').classList.remove('cb-open'); }

/* ---------- вход ---------- */

function stBoot() {
  document.body.classList.add('st-booting');
  var h = location.hash.replace(/^#/, '');
  var m = /(?:^|&)t=([A-Za-z0-9_-]{20,64})/.exec(h);
  if (m) { ST.token = m[1]; return stBootGuest(); }
  ST.ownerKey = stGet('st_owner', '');
  if (!ST.ownerKey) return stLoginForm('');
  stCall('whoami').then(function (r) {
    if (r.status === 200 && r.data.role === 'owner') return stOwnerReady();
    stSet('st_owner', null); ST.ownerKey = '';
    stLoginForm(r.status === 401 ? 'Ключ не подошёл — введите заново.' : (r.data.error || 'Прослойка не отвечает'));
  }).catch(function () { stLoginForm('Нет связи с облаком. Проверьте интернет и обновите страницу.'); });
}

function stLoginForm(err) {
  stModal('<div class="cb-eyebrow">CONTENT PULSE STUDIO</div><h2>Вход</h2>'
    + '<p class="st-note">Ключ владельца — в файле <span class="cb-mono">owner-key.txt</span> в папке studio-keys. Вводится один раз в этом браузере. '
    + 'Клиенты и ретушёры входят по своим ссылкам, ключ им не нужен.</p>'
    + '<input type="password" id="stKey" autofocus placeholder="Ключ владельца" class="st-input">'
    + (err ? '<div class="st-err">' + stEsc(err) + '</div>' : '')
    + '<div class="st-row"><button class="cb-primary" data-st="login">Войти</button></div>', { closable: false });
}

function stLogin() {
  var v = (document.getElementById('stKey').value || '').trim();
  if (!v) return;
  ST.ownerKey = v;
  stCall('whoami').then(function (r) {
    if (r.status === 200 && r.data.role === 'owner') { stSet('st_owner', v); stOwnerReady(); }
    else { ST.ownerKey = ''; stLoginForm('Ключ не подошёл.'); }
  }).catch(function () { ST.ownerKey = ''; stLoginForm('Нет связи с облаком.'); });
}

function stOwnerReady() {
  ST.role = 'owner'; ST.mode = 'edit';
  ST.name = stGet('st_name', '') || 'владелец';
  document.body.classList.add('st-owner');
  var m = /(?:^|&)p=([a-z0-9-]{6,64})/.exec(location.hash.replace(/^#/, ''));
  if (m) stOpenProject(m[1]);
  else stProjectsOpen();
}

function stBootGuest() {
  stCall('whoami').then(function (r) {
    if (r.status !== 200 || r.data.role !== 'guest') {
      stModal('<h2>Ссылка не работает</h2><p class="st-note">Её могли заменить на новую. Попросите у фотографа актуальную ссылку.</p>', { closable: false });
      return;
    }
    ST.role = 'guest'; ST.mode = r.data.mode; ST.pid = r.data.pid;
    document.body.classList.add(ST.mode === 'download' ? 'st-dl' : 'st-guest');
    if (ST.mode === 'download') return stOpenProject(ST.pid);
    ST.name = stGet('st_name', '');
    if (ST.name) return stOpenProject(ST.pid);
    stNameForm(function () { stOpenProject(ST.pid); });
  }).catch(function () {
    stModal('<h2>Нет связи с облаком</h2><p class="st-note">Проверьте интернет и обновите страницу.</p>', { closable: false });
  });
}

function stNameForm(done) {
  ST._nameDone = done;
  stModal('<div class="cb-eyebrow">ОТБОР</div><h2>Как вас подписать?</h2>'
    + '<p class="st-note">Имя увидят в журнале: кто согласовал, переименовал, скачал.</p>'
    + '<input type="text" id="stName" autofocus class="st-input" placeholder="Например: Анна, контент-менеджер" value="' + stEsc(ST.name) + '">'
    + '<div class="st-row"><button class="cb-primary" data-st="name">Готово</button></div>', { closable: !!ST.pid && !!ST.name });
}

function stNameSave() {
  var v = (document.getElementById('stName').value || '').trim().slice(0, 60);
  if (!v) return;
  ST.name = v; stSet('st_name', v);
  stModalClose();
  stUpdateBar();
  if (ST._nameDone) { var d = ST._nameDone; ST._nameDone = null; d(); }
}

/* ---------- съёмки владельца ---------- */

function stProjectsOpen() {
  stModal('<div class="cb-eyebrow">CONTENT PULSE STUDIO</div><h2>Съёмки</h2><div class="st-note">Загрузка списка…</div>', { wide: true, closable: !!ST.pid });
  stCallOk('projects').then(function (d) {
    var html = '<div class="cb-eyebrow">CONTENT PULSE STUDIO</div><h2>Съёмки</h2>'
      + '<div class="st-row st-create"><input type="text" id="stNewName" class="st-input" autofocus placeholder="Название новой съёмки, например 18.11 MSGM муж">'
      + '<button class="cb-primary" data-st="create">Создать съёмку</button></div>';
    if (!d.projects.length) html += '<div class="st-note">Съёмок пока нет.</div>';
    html += '<div class="st-plist">';
    d.projects.forEach(function (p) {
      html += '<div class="st-prow" data-pid="' + stEsc(p.id) + '">'
        + '<div class="st-pname">' + stEsc(p.name) + '<div class="st-pdate cb-mono">' + stTime(p.created) + '</div></div>'
        + '<button class="cb-primary" data-st="open">Открыть</button>'
        + '<button data-st="links">Ссылки</button>'
        + '<button class="cb-danger" data-st="del">Удалить</button></div>';
    });
    html += '</div><div class="st-row st-foot"><span class="st-note">Вы: ' + stEsc(ST.name) + '</span> <button class="cb-mini" data-st="rename-me">Сменить имя</button>'
      + ' <button class="cb-mini" data-st="logout">Выйти из этого браузера</button></div>';
    ST._projects = d.projects;
    stModal(html, { wide: true, closable: !!ST.pid });
  }).catch(function (e) { stModal('<h2>Съёмки</h2><div class="st-err">' + stEsc(e.message) + '</div>', { wide: true }); });
}

function stCreateProject() {
  var name = (document.getElementById('stNewName').value || '').trim();
  if (!name) { document.getElementById('stNewName').focus(); return; }
  stCallOk('create', { name: name }).then(function (meta) {
    ST._projects = [meta].concat(ST._projects || []);
    stOpenProject(meta.id, meta);
  }).catch(function (e) { cbToast('Не создалось: ' + e.message); });
}

function stDeleteProject(btn, pid) {
  if (btn.getAttribute('data-armed') !== '1') {
    btn.setAttribute('data-armed', '1');
    btn.textContent = 'Удалить навсегда?';
    btn.classList.add('st-armed');
    setTimeout(function () { if (btn.isConnected) { btn.removeAttribute('data-armed'); btn.textContent = 'Удалить'; btn.classList.remove('st-armed'); } }, 4000);
    return;
  }
  btn.disabled = true; btn.textContent = 'Удаляю…';
  stCallOk('delete', { pid: pid }).then(function () {
    if (ST.pid === pid) { ST.pid = ''; location.hash = ''; stResetApp(); }
    stProjectsOpen();
  }).catch(function (e) { cbToast('Не удалилось: ' + e.message); stProjectsOpen(); });
}

function stResetApp() {
  App.photos = []; App.cards = []; App.containers = [];
  cbSetProjectName('Content Pulse Studio');
  cbClearDirty(); cbHistoryReset();
  cbRenderTray(); cbRenderCards(); cbRenderConts();
  stUpdateBar();
}

/* ---------- ссылки ---------- */

function stLinkUrl(token) { return location.origin + location.pathname + '#t=' + token; }

function stLinksOpen(pid) {
  pid = pid || ST.pid;
  var meta = (ST._projects || []).filter(function (p) { return p.id === pid; })[0] || (ST.meta && ST.meta.id === pid ? ST.meta : null);
  if (!meta) {
    return stCallOk('projects').then(function (d) { ST._projects = d.projects; stLinksOpen(pid); })
      .catch(function (e) { cbToast(e.message); });
  }
  ST._linksPid = pid;
  var row = function (mode, title, note) {
    return '<div class="st-link" data-mode="' + mode + '"><div class="cb-lbl">' + title + '</div>'
      + '<div class="st-note">' + note + '</div>'
      + '<div class="st-row"><input type="text" readonly class="st-input st-link-in" value="' + stEsc(stLinkUrl(meta[mode])) + '">'
      + '<button class="cb-primary" data-st="copy">Скопировать</button><button data-st="rotate">Сменить</button></div></div>';
  };
  stModal('<div class="cb-eyebrow">ССЫЛКИ · ' + stEsc(meta.name) + '</div><h2>Кому что отправить</h2>'
    + row('edit', 'Редактирование', 'Клиенту и контент-менеджеру: править отбор, подписывать и согласовывать карточки, скачивать.')
    + row('download', 'Только скачивание', 'Ретушёрам: всегда текущий отбор, скачать всё или отбор. Править нельзя.')
    + '<div class="st-note st-small">Ссылки бессрочные. «Сменить» — старая ссылка перестанет работать, вторая останется.</div>', { wide: true });
}

function stCopy(btn) {
  var inp = btn.parentNode.querySelector('input');
  var done = function () { btn.textContent = 'Скопировано'; setTimeout(function () { btn.textContent = 'Скопировать'; }, 1600); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(inp.value).then(done, function () { inp.select(); document.execCommand('copy'); done(); });
  else { inp.select(); document.execCommand('copy'); done(); }
}

function stRotate(btn) {
  var mode = btn.closest('.st-link').getAttribute('data-mode');
  if (btn.getAttribute('data-armed') !== '1') {
    btn.setAttribute('data-armed', '1'); btn.textContent = 'Старая перестанет работать — сменить?'; btn.classList.add('st-armed');
    return;
  }
  stCallOk('share', { pid: ST._linksPid, mode: mode }).then(function (r) {
    (ST._projects || []).forEach(function (p) { if (p.id === ST._linksPid) p[mode] = r.token; });
    if (ST.meta && ST.meta.id === ST._linksPid) ST.meta[mode] = r.token;
    stLinksOpen(ST._linksPid);
  }).catch(function (e) { cbToast('Не сменилась: ' + e.message); });
}

/* ---------- открыть съёмку ---------- */

function stOpenProject(pid, meta) {
  stModalClose();
  if (ST.pid && ST.pid !== pid && App.dirty) stSave();
  ST.pid = pid; ST.media = {}; ST.mediaAt = 0;
  if (meta) ST.meta = meta;
  else if (ST.role === 'owner') ST.meta = (ST._projects || []).filter(function (p) { return p.id === pid; })[0] || null;
  if (ST.role === 'owner') location.hash = 'p=' + pid;
  cbBusyShow('Открываю съёмку…', 0.2);
  stCallOk('state', null, { pid: pid }).then(function (d) {
    var s = d.state;
    return stLoadMedia(s.photos).then(function () { return s; });
  }).then(function (s) {
    cbBusyHide();
    ST.rev = +s.rev || 0;
    ST.base = stClone(s);
    stApplyState(s);
    document.body.classList.remove('st-booting');
    stUpdateBar();
    stStartPoll();
    if (ST.mode === 'download') stRenderViewer();
  }).catch(function (e) {
    cbBusyHide();
    stModal('<h2>Съёмка не открылась</h2><div class="st-err">' + stEsc(e.message) + '</div>'
      + (ST.role === 'owner' ? '<div class="st-row"><button data-st="projects">К списку съёмок</button></div>' : ''));
  });
}

/** Ссылки на превью для кадров (бакет закрыт — ссылки подписанные, живут 6 часов). */
function stLoadMedia(photos) {
  var fids = (photos || []).filter(function (p) { return p && p.fid && !ST.media[p.fid]; }).map(function (p) { return p.fid; });
  var chunks = [];
  for (var i = 0; i < fids.length; i += 1500) chunks.push(fids.slice(i, i + 1500));
  return chunks.reduce(function (pr, ch) {
    return pr.then(function () {
      return stCallOk('media', { pid: ST.pid, fids: ch }).then(function (d) {
        Object.keys(d.media).forEach(function (f) { ST.media[f] = d.media[f].preview; });
      });
    });
  }, Promise.resolve()).then(function () { if (fids.length) ST.mediaAt = Date.now(); });
}

/** Подставить отбор из облака в Cardboard (превью — по ссылкам). */
function stApplyState(s) {
  var data = stClone(s);
  (data.photos || []).forEach(function (p) {
    if (p.fid) p.dataUrl = ST.media[p.fid] || (cbPhotoById(p.id) || {})._localUrl || null;
  });
  var keepLocal = {};
  App.photos.forEach(function (p) { if (p._localUrl) keepLocal[p.id] = p._localUrl; });
  cbApplyProject(data);
  App.photos.forEach(function (p) { if (keepLocal[p.id]) { p._localUrl = keepLocal[p.id]; if (!p.dataUrl) p.dataUrl = p._localUrl; } });
  App.studioLog = data.log || [];
  if (ST.meta && data.name) ST.meta.name = data.name;
  cbRenderTray(); cbRenderCards(); cbRenderConts();
}

/* ---------- данные отбора для сохранения ---------- */

var _stProjectDataOrig = cbProjectData;
cbProjectData = function () {
  var d = _stProjectDataOrig();
  d.app = 'content-pulse-studio';
  d.studio = 1;
  d.photos = App.photos.map(function (p) {
    var o = { id: p.id, name: p.name, w: p.w, h: p.h, kind: p.kind || 'photo' };
    if (p.fid) { o.fid = p.fid; o.size = p.size; o.crc = p.crc; o.type = p.type || ''; o.added = p.added || null; }
    else o.dataUrl = p.dataUrl;          /* референсы из Cardboard — внутри отбора, как раньше */
    return o;
  });
  d.log = App.studioLog || [];
  return d;
};

/* номера карточек у двух людей, правящих одновременно, не пересекаются */
ST.idTag = '_' + Math.random().toString(36).slice(2, 6);
cbId = function () { return 'p' + (App.nextId++) + ST.idTag; };

cbMarkDirty = (function (orig) {
  return function () { ST.editSeq++; var r = orig.apply(this, arguments); stUpdateStatus(); return r; };
})(cbMarkDirty);

cbAutosaveNow = function () { if (App.dirty && ST.pid && ST.mode === 'edit') stSave(); };
cbSaveProject = function () { if (ST.pid && ST.mode === 'edit') stSave(true); };
cbProjModalOpen = function (mode, startup) { if (!startup && ST.role === 'owner') stProjectsOpen(); };

function stLog(what) {
  App.studioLog = App.studioLog || [];
  App.studioLog.push({ at: stNow(), who: ST.name || (ST.role === 'owner' ? 'владелец' : 'гость'), what: what });
}

/* ---------- склейка трёх версий (как в Content Pulse 2.0) ---------- */

function stMergeMap(base, local, remote) {
  base = base || {}; local = local || {}; remote = remote || {};
  var out = {}, keys = {};
  [base, local, remote].forEach(function (m) { Object.keys(m).forEach(function (k) { keys[k] = true; }); });
  Object.keys(keys).forEach(function (k) {
    var v = !stSame(local[k], base[k]) ? local[k] : remote[k];
    if (v !== undefined) out[k] = v;
  });
  return out;
}

function stMergeById(base, local, remote) {
  var idx = function (arr) { var m = {}; (arr || []).forEach(function (x) { if (x && x.id != null) m[x.id] = x; }); return m; };
  var B = idx(base), L = idx(local), R = idx(remote);
  var out = [], used = {};
  function pick(id) {
    var inB = id in B, inL = id in L, inR = id in R;
    if (inL && inR) {
      if (!inB) return L[id];
      if (stSame(L[id], B[id])) return R[id];
      if (stSame(R[id], B[id])) return L[id];
      return stMergeMap(B[id], L[id], R[id]);   /* правили оба — по полям: наше, если мы меняли */
    }
    if (inL) return (!inB || !stSame(L[id], B[id])) ? L[id] : null;
    if (inR) return (!inB || !stSame(R[id], B[id])) ? R[id] : null;
    return null;
  }
  (remote || []).forEach(function (x) { if (!x || used[x.id]) return; used[x.id] = true; var v = pick(x.id); if (v) out.push(v); });
  (local || []).forEach(function (x) { if (!x || used[x.id]) return; used[x.id] = true; var v = pick(x.id); if (v) out.push(v); });
  return out;
}

/** base может быть null — тогда просто объединяем. Порядок карточек — как у них, наши новые — в конце. */
function stMerge3(base, local, remote) {
  base = base || {}; local = local || {}; remote = remote || {};
  var out = stClone(remote);
  ['cards', 'containers', 'templates'].forEach(function (k) { out[k] = stMergeById(base[k], local[k], remote[k]); });
  var ph = {}, photos = [];
  (remote.photos || []).concat(local.photos || []).forEach(function (p) { if (p && !ph[p.id]) { ph[p.id] = true; photos.push(p); } });
  out.photos = photos;
  out.nextId = Math.max(+local.nextId || 0, +remote.nextId || 0);
  var seen = {}, log = [];
  (remote.log || []).concat(local.log || []).forEach(function (e) {
    var key = e.at + '|' + e.who + '|' + e.what;
    if (!seen[key]) { seen[key] = true; log.push(e); }
  });
  log.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
  out.log = log;
  return out;
}

/* ---------- сохранение ---------- */

function stSave(now) {
  if (!ST.pid || ST.mode !== 'edit') return Promise.resolve();
  if (ST.saving) { ST.again = true; return ST._savePromise; }
  ST.saving = true; ST.again = false;
  var seq = ST.editSeq;
  var data = cbProjectData();
  stStatus('сохраняю…');
  ST._savePromise = stCall('save', { pid: ST.pid, baseRev: ST.rev, state: data }).then(function (r) {
    if (r.status === 200) {
      ST.rev = r.data.rev;
      ST.base = stClone(data); ST.base.rev = r.data.rev;
      if (ST.editSeq === seq) cbClearDirty();
      stStatus('сохранено ' + new Date().toLocaleTimeString('ru-RU').slice(0, 5));
      return;
    }
    if (r.status === 409 && r.data.state) {
      /* кто-то сохранил раньше: склеиваем и пишем ещё раз */
      var merged = stMerge3(ST.base, data, r.data.state);
      ST.rev = +r.data.state.rev;
      ST.base = stClone(r.data.state);
      return stLoadMedia(merged.photos).then(function () {
        var typing = stTyping();
        if (!typing) stApplyState(merged);
        else { App.cards = merged.cards; App.containers = merged.containers; App.studioLog = merged.log; }
        App.dirty = true;
        ST.again = true;
      });
    }
    stStatus('не сохранилось: ' + (r.data.error || r.status) + ' — повторю');
    setTimeout(function () { if (App.dirty) stSave(); }, 5000);
  }).catch(function () {
    stStatus('нет связи — повторю');
    setTimeout(function () { if (App.dirty) stSave(); }, 5000);
  }).then(function () {
    ST.saving = false;
    if (ST.again) { ST.again = false; return stSave(); }
  });
  return ST._savePromise;
}

function stTyping() {
  var a = document.activeElement;
  return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.closest('#cbCards, #cbConts, .cb-tray'));
}

/* Чужие правки видны сами: раз в 20 секунд смотрим, не сохранил ли кто-то новую ревизию. */
function stStartPoll() {
  clearInterval(ST.pollTimer);
  ST.pollTimer = setInterval(function () {
    if (!ST.pid || ST.saving || ST.uploading || App.dirty || stTyping() || document.hidden) return;
    var pid = ST.pid;
    stCall('state', null, { pid: pid }).then(function (r) {
      if (r.status !== 200 || pid !== ST.pid || App.dirty || ST.saving) return;
      var s = r.data.state;
      var stale = Date.now() - ST.mediaAt > 5 * 3600 * 1000;
      if (stale) ST.media = {};
      if (+s.rev === ST.rev && !stale) return;
      return stLoadMedia(s.photos).then(function () {
        if (App.dirty || ST.saving || stTyping()) return;
        ST.rev = +s.rev; ST.base = stClone(s);
        stApplyState(s);
        if (ST.mode === 'download') stRenderViewer();
        stStatus('обновлено ' + new Date().toLocaleTimeString('ru-RU').slice(0, 5));
      });
    }).catch(function () { });
  }, 20000);
}

/* ---------- загрузка кадров (владелец) ---------- */

var ST_CRC = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();

/** CRC32 файла кусками по 8 МБ — нужен прослойке, чтобы собрать ZIP за один проход. */
function stCrcFile(file) {
  var CH = 8 * 1024 * 1024, pos = 0, c = -1;
  function step() {
    if (pos >= file.size) return Promise.resolve((c ^ -1) >>> 0);
    var part = file.slice(pos, pos + CH);
    pos += CH;
    return part.arrayBuffer().then(function (buf) {
      var a = new Uint8Array(buf);
      for (var i = 0; i < a.length; i++) c = ST_CRC[(c ^ a[i]) & 0xFF] ^ (c >>> 8);
      return step();
    });
  }
  return step();
}

/** Превью ~1400 px JPEG и размеры исходника. Не картинка для браузера (TIFF и т. п.) — без превью. */
function stPreview(file) {
  return new Promise(function (resolve) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      var cw = Math.round(w * scale), ch = Math.round(h * scale);
      var cnv = document.createElement('canvas');
      cnv.width = cw; cnv.height = ch;
      var ctx = cnv.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);
      cnv.toBlob(function (blob) { resolve({ blob: blob, w: w, h: h }); }, 'image/jpeg', 0.85);
    };
    img.onerror = function () { URL.revokeObjectURL(url); resolve({ blob: null, w: 0, h: 0 }); };
    img.src = url;
  });
}

function stPut(url, body) {
  return fetch(url, { method: 'PUT', body: body }).then(function (r) {
    if (!r.ok) throw new Error('хранилище ответило ' + r.status);
    return (r.headers.get('ETag') || '').replace(/"/g, '');
  });
}

function stUploadFiles(fileList) {
  if (ST.role !== 'owner') { cbToast('Кадры добавляет только фотограф'); return; }
  if (!ST.pid) { cbToast('Сначала создайте или откройте съёмку'); return; }
  if (ST.uploading) { cbToast('Загрузка уже идёт'); return; }
  var have = {};
  App.photos.forEach(function (p) { if (p.fid) have[p.name + '|' + p.size] = true; });
  var all = Array.prototype.slice.call(fileList);
  var files = all.filter(function (f) { return IMG_EXT.test(f.name) && !have[f.name + '|' + f.size]; });
  var skipped = all.length - files.length;
  if (!files.length) { cbToast(skipped ? 'Новых кадров нет (уже загружены или не картинки)' : 'Нет файлов'); return; }
  files.sort(function (a, b) { return a.name.localeCompare(b.name, 'ru', { numeric: true }); });
  var total = files.reduce(function (s, f) { return s + f.size; }, 0), sent = 0, done = 0, failed = [];
  ST.uploading = true;
  var progress = function () { cbBusyShow('Загружаю кадры: ' + done + ' из ' + files.length + ' · ' + stSize(sent) + ' из ' + stSize(total), total ? sent / total : 0); };
  progress();

  var order = {};
  function one(f) {
    var fid = stRandId('f');
    order[fid] = files.indexOf(f);
    return Promise.all([stPreview(f), stCrcFile(f)]).then(function (res) {
      var pv = res[0], crc = res[1];
      return stCallOk('upload', { pid: ST.pid, op: 'start', files: [{ fid: fid, size: f.size, type: f.type || 'image/jpeg' }] }).then(function (d) {
        var u = d.files[0];
        var jobs = [];
        if (pv.blob) jobs.push(stPut(u.preview, pv.blob));
        if (u.put) jobs.push(stPut(u.put, f).then(function () { sent += f.size; progress(); }));
        else {
          var etags = [], chain = Promise.resolve();
          u.parts.forEach(function (url, i) {
            chain = chain.then(function () {
              var part = f.slice(i * u.partSize, (i + 1) * u.partSize);
              return stPut(url, part).then(function (et) { etags[i] = et; sent += part.size; progress(); });
            });
          });
          jobs.push(chain.then(function () { return stCallOk('upload', { pid: ST.pid, op: 'done', fid: fid, uploadId: u.uploadId, etags: etags }); }));
        }
        return Promise.all(jobs);
      }).then(function () {
        var local = pv.blob ? URL.createObjectURL(pv.blob) : null;
        App.photos.push({ id: fid, fid: fid, name: f.name, size: f.size, crc: crc, type: f.type || '', added: stNow(),
          w: pv.w, h: pv.h, kind: 'photo', missing: false, dataUrl: local, _localUrl: local });
        done++; progress();
        if (done % 10 === 0) { cbRenderTray(); }
      });
    }).catch(function (e) { failed.push(f.name + ': ' + e.message); });
  }

  /* три файла параллельно */
  var next = 0;
  function worker() { if (next >= files.length) return Promise.resolve(); var f = files[next++]; return one(f).then(worker); }
  Promise.all([worker(), worker(), worker()]).then(function () {
    ST.uploading = false;
    /* загружаются по три сразу — в галерее раскладываем новые кадры по порядку имён */
    var olds = App.photos.filter(function (p) { return !(p.id in order); });
    var news = App.photos.filter(function (p) { return p.id in order; }).sort(function (a, b) { return order[a.id] - order[b.id]; });
    App.photos = olds.concat(news);
    cbBusyHide();
    if (done) { stLog('загрузил(а) кадров: ' + done); cbMarkDirty(); cbRenderTray(); stSave(); }
    var msg = 'Загружено кадров: ' + done + (skipped ? ' · пропущено (уже есть или не картинки): ' + skipped : '');
    if (failed.length) {
      stModal('<h2>Часть кадров не загрузилась</h2><div class="st-note">' + stEsc(msg) + '</div><div class="st-err">' + failed.map(stEsc).join('<br>') + '</div>'
        + '<div class="st-note">Перетащите эти файлы ещё раз — загруженные пропустятся.</div>');
    } else cbToast(msg);
  });
}

/* ---------- согласование карточек ---------- */

cbRenderCards = (function (orig) {
  return function () {
    var r = orig.apply(this, arguments);
    if (!ST.pid) return r;
    var host = document.getElementById('cbCards');
    Array.prototype.forEach.call(host.querySelectorAll('.cb-card'), function (el) {
      var card = cbCardById(el.getAttribute('data-cid'));
      if (!card) return;
      var head = el.querySelector('.cb-card-head');
      var sp = head.querySelector('.cb-spacer');
      var a = card.approved;
      var b = document.createElement('button');
      b.className = 'cb-mini st-approve' + (a ? ' st-on' : '');
      b.setAttribute('data-st-card', card.id);
      b.textContent = a ? 'Согласовано · ' + a.by : 'Согласовать';
      if (a) b.title = 'Согласовал(а) ' + a.by + ' ' + stTime(a.at) + '. Нажмите, чтобы снять.';
      head.insertBefore(b, sp);
      el.classList.toggle('st-approved', !!a);
    });
    stUpdateBar();
    return r;
  };
})(cbRenderCards);

function stCardName(card, i) { return (card.title || '').trim() || ('Карточка ' + (i + 1)); }

function stToggleApprove(cid) {
  var card = cbCardById(cid), i = App.cards.indexOf(card);
  if (!card) return;
  if (card.approved) { delete card.approved; stLog('снял(а) согласование: ' + stCardName(card, i)); }
  else { card.approved = { by: ST.name, at: stNow() }; stLog('согласовал(а): ' + stCardName(card, i)); }
  cbMarkDirty(); cbRenderCards(); stUpdateBar();
}

function stApproveAll() {
  var n = 0;
  App.cards.forEach(function (c) { if (!c.approved && stCardPhotos(c).length) { c.approved = { by: ST.name, at: stNow() }; n++; } });
  if (!n) { cbToast('Все карточки с кадрами уже согласованы'); return; }
  stLog('согласовал(а) все карточки: ' + n);
  cbMarkDirty(); cbRenderCards(); stUpdateBar();
  cbToast('Согласовано карточек: ' + n);
}

/* ---------- скачивание ---------- */

/** Кадры карточки по порядку (только облачные — у референсов нет файла в бакете). */
function stCardPhotos(card) {
  var ids = card.mode === 'auto' ? (card.pids || []) : (card.slots || []).map(function (s) { return s.pid; });
  return ids.map(function (id) { return id ? cbPhotoById(id) : null; }).filter(function (p) { return p && p.fid; });
}
function stContPhotos(c) { return (c.photoIds || []).map(cbPhotoById).filter(function (p) { return p && p.fid; }); }

function stSafe(s) { return String(s || '').replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'без названия'; }
function stExt(name) { var m = /\.[A-Za-z0-9]{1,6}$/.exec(name || ''); return m ? m[0] : '.jpg'; }

/** Список файлов архива по галкам: scope all|selection, folders, rename. */
function stEntries(opts) {
  var out = [], used = {};
  var uniq = function (path) {
    var p = path, n = 2, dot = path.lastIndexOf('.');
    while (used[p.toLowerCase()]) { p = dot > 0 ? path.slice(0, dot) + ' (' + n + ')' + path.slice(dot) : path + ' (' + n + ')'; n++; }
    used[p.toLowerCase()] = true;
    return p;
  };
  if (opts.scope === 'all') {
    App.photos.forEach(function (p) { if (p.fid) out.push({ fid: p.fid, name: uniq(stSafe(p.name)), size: p.size }); });
    return out;
  }
  var groups = [], names = {};
  App.cards.forEach(function (c, i) { groups.push({ name: stCardName(c, i), photos: stCardPhotos(c) }); });
  App.containers.forEach(function (c, i) { groups.push({ name: (c.title || '').trim() || ('Доп. контент ' + (i + 1)), photos: stContPhotos(c) }); });
  groups.forEach(function (g) {
    if (!g.photos.length) return;
    var base = stSafe(g.name), folder = base, n = 2;
    while (names[folder.toLowerCase()]) folder = base + ' (' + (n++) + ')';
    names[folder.toLowerCase()] = true;
    g.photos.forEach(function (p, k) {
      var file = opts.rename ? folder + '_' + (k + 1) + stExt(p.name) : stSafe(p.name);
      out.push({ fid: p.fid, name: uniq(opts.folders ? folder + '/' + file : file), size: p.size });
    });
  });
  return out;
}

/** Свежий отбор из облака перед скачиванием: свои правки — сохранить (со склейкой), чужие — подтянуть. */
function stRefresh() {
  if (!ST.pid) return Promise.resolve();
  if (App.dirty && ST.mode === 'edit') return stSave();
  return stCallOk('state', null, { pid: ST.pid }).then(function (d) {
    var s = d.state;
    if (+s.rev === ST.rev || App.dirty) return;
    return stLoadMedia(s.photos).then(function () {
      ST.rev = +s.rev; ST.base = stClone(s);
      stApplyState(s);
      if (ST.mode === 'download') stRenderViewer();
    });
  });
}

function stDownloadOpen() {
  cbBusyShow('Сверяю отбор с облаком…', 0.3);
  stRefresh().then(function () { cbBusyHide(); stDownloadModal(); }, function () { cbBusyHide(); stDownloadModal(); });
}

function stDownloadModal() {
  var o = { scope: stGet('st_dl_scope', 'selection'), folders: stGet('st_dl_folders', '1') === '1', rename: stGet('st_dl_rename', '0') === '1' };
  var sel = stEntries({ scope: 'selection', folders: true, rename: false }), all = stEntries({ scope: 'all' });
  var sz = function (list) { return list.reduce(function (s, e) { return s + (e.size || 0); }, 0); };
  stModal('<div class="cb-eyebrow">СКАЧАТЬ · ' + stEsc(App.projectName) + '</div><h2>Что скачать</h2>'
    + '<label class="cb-check"><input type="radio" name="stScope" value="selection"' + (o.scope !== 'all' ? ' checked' : '') + '> Отбор — кадры в карточках <span class="cb-check-note">' + sel.length + ' · ' + stSize(sz(sel)) + '</span></label>'
    + '<label class="cb-check"><input type="radio" name="stScope" value="all"' + (o.scope === 'all' ? ' checked' : '') + '> Все кадры съёмки <span class="cb-check-note">' + all.length + ' · ' + stSize(sz(all)) + '</span></label>'
    + '<div class="cb-lbl">Как разложить</div>'
    + '<label class="cb-check st-sel-only"><input type="checkbox" id="stDlFolders"' + (o.folders ? ' checked' : '') + '> Папками — по папке на карточку с её названием</label>'
    + '<label class="cb-check st-sel-only"><input type="checkbox" id="stDlRename"' + (o.rename ? ' checked' : '') + '> Переименовать файлы: <span class="cb-mono">название карточки_позиция</span></label>'
    + '<div class="st-note st-small" id="stDlExample"></div>'
    + '<div class="st-row"><button class="cb-primary" data-st="dl-go">Скачать архив</button></div>'
    + '<div class="st-note st-small">Архив собирается в облаке, ссылка на него живёт 3 дня.</div>', { wide: false });
  stDownloadSync();
}

function stDownloadOpts() {
  var scope = (document.querySelector('input[name=stScope]:checked') || {}).value || 'selection';
  return { scope: scope, folders: document.getElementById('stDlFolders').checked, rename: document.getElementById('stDlRename').checked };
}

function stDownloadSync() {
  var o = stDownloadOpts();
  Array.prototype.forEach.call(document.querySelectorAll('.st-sel-only'), function (el) {
    el.classList.toggle('st-off', o.scope === 'all');
    el.querySelector('input').disabled = o.scope === 'all';
  });
  var ex = stEntries(o).slice(0, 3).map(function (e) { return stEsc(e.name); });
  document.getElementById('stDlExample').innerHTML = ex.length ? 'Например: <span class="cb-mono">' + ex.join('<br>') + '</span>' : 'В отборе пока нет кадров.';
}

function stDownloadGo() {
  var o = stDownloadOpts();
  stSet('st_dl_scope', o.scope); stSet('st_dl_folders', o.folders ? '1' : '0'); stSet('st_dl_rename', o.rename ? '1' : '0');
  var entries = stEntries(o);
  if (!entries.length) { cbToast('Нечего скачивать'); return; }
  stModalClose();
  var total = entries.reduce(function (s, e) { return s + (e.size || 0); }, 0);
  /* куски архива по ~600 МБ: каждый вызов прослойки укладывается в её время */
  var PART = 600 * 1024 * 1024, parts = [], cur = [], acc = 0;
  entries.forEach(function (e) {
    cur.push({ fid: e.fid, name: e.name }); acc += e.size || 0;
    if (acc >= PART) { parts.push(cur); cur = []; acc = 0; }
  });
  if (cur.length) parts.push(cur);
  var zipName = stSafe(App.projectName) + (o.scope === 'all' ? ' — все кадры' : ' — отбор');
  var z, etags = [], prev = [], offset = 0, doneBytes = 0;
  cbBusyShow('Собираю архив: ' + entries.length + ' файлов, ' + stSize(total), 0.02);
  var flush = (App.dirty && ST.mode === 'edit') ? stSave() : Promise.resolve();
  flush.then(function () { return stCallOk('zip', { pid: ST.pid, op: 'start' }); }).then(function (d) {
    z = d;
    return parts.reduce(function (pr, list, i) {
      return pr.then(function () {
        return stCallOk('zip', { pid: ST.pid, op: 'part', key: z.key, uploadId: z.uploadId, n: i + 1, offset: offset,
          entries: list, final: i === parts.length - 1, prev: i === parts.length - 1 ? prev : [] })
          .then(function (r) {
            etags.push(r.etag); offset = r.next; prev = prev.concat(r.done);
            r.done.forEach(function (x) { doneBytes += x.size; });
            cbBusyShow('Собираю архив: ' + prev.length + ' из ' + entries.length + ' · ' + stSize(doneBytes) + ' из ' + stSize(total), total ? doneBytes / total : 1);
          });
      });
    }, Promise.resolve());
  }).then(function () {
    return stCallOk('zip', { pid: ST.pid, op: 'done', key: z.key, uploadId: z.uploadId, etags: etags, name: zipName });
  }).then(function (r) {
    cbBusyHide();
    var a = document.createElement('a');
    a.href = r.url; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    if (ST.mode === 'edit') { stLog('скачал(а) ' + (o.scope === 'all' ? 'все кадры' : 'отбор') + ': ' + entries.length); cbMarkDirty(); }
    stModal('<h2>Архив готов</h2><div class="st-note">' + entries.length + ' файлов, ' + stSize(total) + '. Скачивание должно было начаться само.</div>'
      + '<div class="st-row"><a class="st-btnlink cb-primary" href="' + stEsc(r.url) + '">Скачать ещё раз</a></div>'
      + '<div class="st-note st-small">Ссылка на этот архив действует до ' + stTime(r.expires) + '.</div>');
  }).catch(function (e) {
    cbBusyHide();
    stModal('<h2>Архив не собрался</h2><div class="st-err">' + stEsc(e.message) + '</div><div class="st-row"><button data-st="download">Попробовать ещё раз</button></div>');
  });
}

/* ---------- журнал ---------- */

function stLogOpen() {
  var log = (App.studioLog || []).slice().reverse();
  stModal('<div class="cb-eyebrow">ЖУРНАЛ · ' + stEsc(App.projectName) + '</div><h2>Кто что сделал</h2>'
    + (log.length ? '<div class="st-log">' + log.map(function (e) {
      return '<div class="st-log-row"><span class="cb-mono st-log-at">' + stTime(e.at) + '</span><b>' + stEsc(e.who) + '</b> ' + stEsc(e.what) + '</div>';
    }).join('') + '</div>' : '<div class="st-note">Пока пусто.</div>'), { wide: true });
}

/* ---------- верхняя панель ---------- */

function stStatus(text) { Array.prototype.forEach.call(document.querySelectorAll('.st-status'), function (el) { el.textContent = text; }); }
function stUpdateStatus() { if (App.dirty) stStatus('есть несохранённые правки'); }

function stUpdateBar() {
  var n = document.getElementById('stProjName');
  if (n) n.textContent = ST.pid ? App.projectName : '';
  var who = document.getElementById('stWho');
  if (who) who.textContent = ST.name ? 'вы: ' + ST.name : '';
  var cnt = App.cards.filter(function (c) { return stCardPhotos(c).length; }).length;
  var ok = App.cards.filter(function (c) { return c.approved; }).length;
  var ap = document.getElementById('stApproveAll');
  if (ap) ap.textContent = cnt ? 'Согласовать все · ' + ok + '/' + cnt : 'Согласовать все';
}

function stInjectBar() {
  var bar = document.querySelector('.cb-topbar');
  var spacer = bar.querySelector('.cb-spacer');
  var left = document.createElement('div');
  left.className = 'st-bar-left';
  left.innerHTML = '<span class="st-proj" id="stProjName"></span><span class="st-status cb-mono" id="stStatus"></span>';
  bar.insertBefore(left, spacer);
  var right = document.createElement('div');
  right.className = 'st-bar-right';
  right.innerHTML = '<span class="st-who cb-mono" id="stWho" data-st="rename-me" title="Сменить имя"></span>'
    + '<button class="st-owner-only" data-st="projects">Съёмки</button>'
    + '<button class="st-owner-only" data-st="upload">Загрузить кадры</button>'
    + '<button class="st-owner-only" data-st="links">Ссылки</button>'
    + '<button data-st="log">Журнал</button>'
    + '<button id="stApproveAll" data-st="approve-all">Согласовать все</button>'
    + '<button class="cb-primary" data-st="download">Скачать</button>';
  bar.insertBefore(right, spacer.nextSibling);
  var fi = document.createElement('input');
  fi.type = 'file'; fi.id = 'stFileInput'; fi.multiple = true; fi.accept = 'image/*'; fi.style.display = 'none';
  fi.onchange = function () { if (this.files.length) stUploadFiles(this.files); this.value = ''; };
  document.body.appendChild(fi);
  var modal = document.createElement('div');
  modal.id = 'stModal'; modal.className = 'cb-modal';
  modal.innerHTML = '<div class="cb-panel st-panel" id="stModalPanel"></div>';
  document.body.appendChild(modal);
  var viewer = document.createElement('div');
  viewer.id = 'stViewer';
  document.body.appendChild(viewer);
}

/* ---------- просмотр по ссылке «только скачивание» ---------- */

function stRenderViewer() {
  var v = document.getElementById('stViewer');
  var html = '<div class="st-v-head"><div><div class="cb-logo-word">CONTENT PULSE</div><div class="st-v-name">' + stEsc(App.projectName) + '</div></div>'
    + '<span class="cb-spacer"></span><span class="st-status cb-mono"></span>'
    + '<button class="cb-primary" data-st="download">Скачать</button></div>'
    + '<div class="st-note st-v-note">Это текущий отбор: если его поправят, здесь будет новая версия. Скачать можно всё или отбор, папками по карточкам.</div>';
  var any = false;
  var block = function (name, photos, approved) {
    if (!photos.length) return '';
    any = true;
    return '<div class="st-v-card"><div class="st-v-title">' + stEsc(name) + ' <span class="cb-mono st-v-count">' + photos.length + '</span>'
      + (approved ? ' <span class="st-v-ok cb-mono">согласовано · ' + stEsc(approved.by) + '</span>' : '') + '</div><div class="st-v-grid">'
      + photos.map(function (p) { return p.dataUrl ? '<img loading="lazy" src="' + stEsc(p.dataUrl) + '" title="' + stEsc(p.name) + '" alt="">' : '<div class="st-v-miss">' + stEsc(p.name) + '</div>'; }).join('')
      + '</div></div>';
  };
  App.cards.forEach(function (c, i) { html += block(stCardName(c, i), stCardPhotos(c), c.approved); });
  App.containers.forEach(function (c, i) { html += block((c.title || '').trim() || ('Доп. контент ' + (i + 1)), stContPhotos(c), null); });
  if (!any) html += '<div class="st-note">В отборе пока нет кадров.</div>';
  v.innerHTML = html;
}

/* ---------- события ---------- */

document.addEventListener('click', function (e) {
  var ap = e.target.closest('[data-st-card]');
  if (ap) { stToggleApprove(ap.getAttribute('data-st-card')); return; }
  var t = e.target.closest('[data-st]');
  if (!t) {
    var m = document.getElementById('stModal');
    if (e.target === m && m.getAttribute('data-closable') === '1') stModalClose();
    return;
  }
  var act = t.getAttribute('data-st');
  var row = t.closest('.st-prow');
  if (act === 'close') stModalClose();
  else if (act === 'login') stLogin();
  else if (act === 'name' ) stNameSave();
  else if (act === 'rename-me') stNameForm(null);
  else if (act === 'logout') { stSet('st_owner', null); location.hash = ''; location.reload(); }
  else if (act === 'projects') stProjectsOpen();
  else if (act === 'create') stCreateProject();
  else if (act === 'open') stOpenProject(row.getAttribute('data-pid'));
  else if (act === 'links') stLinksOpen(row ? row.getAttribute('data-pid') : ST.pid);
  else if (act === 'del') stDeleteProject(t, row.getAttribute('data-pid'));
  else if (act === 'copy') stCopy(t);
  else if (act === 'rotate') stRotate(t);
  else if (act === 'upload') document.getElementById('stFileInput').click();
  else if (act === 'download') stDownloadOpen();
  else if (act === 'dl-go') stDownloadGo();
  else if (act === 'log') stLogOpen();
  else if (act === 'approve-all') stApproveAll();
});

document.addEventListener('change', function (e) {
  if (e.target.name === 'stScope' || e.target.id === 'stDlFolders' || e.target.id === 'stDlRename') stDownloadSync();
});

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  var id = e.target.id;
  if (id === 'stKey') stLogin();
  else if (id === 'stName') stNameSave();
  else if (id === 'stNewName') stCreateProject();
});

/** Кадры, перетащенные на страницу (вне вкладки «Референсы»). Вызывается из обработчика drop Cardboard. */
function stDropFiles(files) {
  if (ST.role === 'owner') stUploadFiles(files);
  else cbToast('Кадры добавляет только фотограф. Сюда можно перетащить референсы — вкладка «Референсы».');
}

window.addEventListener('beforeunload', function (e) {
  if (ST.uploading) { e.preventDefault(); e.returnValue = ''; }
});

stInjectBar();
stBoot();
