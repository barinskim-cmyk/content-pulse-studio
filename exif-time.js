/* Время съёмки из EXIF JPEG — для сортировки галереи.
   Один и тот же код работает в браузере (studio.js, через <script>) и в прослойке (require).
   На вход — начало файла (Uint8Array или Buffer; 128 КБ хватает: блок EXIF стоит в начале
   и не длиннее 64 КБ). На выход — строка «2026-11-18T12:03:44.120» (сортируется как текст)
   или '' если времени нет (не JPEG, EXIF вырезан).
   Берётся DateTimeOriginal (момент спуска) с долями секунды SubSecTimeOriginal;
   если его нет — DateTime из IFD0. ES5, без зависимостей. */
(function (root) {
  function exifTime(b) {
    var n = b.length;
    if (n < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return '';
    var off = 2;
    while (off + 4 <= n) {
      if (b[off] !== 0xFF) return '';
      var marker = b[off + 1];
      if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { off += 2; continue; }
      if (marker === 0xDA || marker === 0xD9) return '';
      var len = (b[off + 2] << 8) | b[off + 3];
      if (marker === 0xE1 && off + 10 <= n && b[off + 4] === 0x45 && b[off + 5] === 0x78 && b[off + 6] === 0x69 && b[off + 7] === 0x66 && b[off + 8] === 0 && b[off + 9] === 0) {
        return fromTiff(b, off + 10, Math.min(n, off + 2 + len));
      }
      off += 2 + len;
    }
    return '';
  }

  function fromTiff(b, t, end) {
    if (t + 8 > end) return '';
    var le = b[t] === 0x49 && b[t + 1] === 0x49;
    if (!le && !(b[t] === 0x4D && b[t + 1] === 0x4D)) return '';
    function u16(o) { return o + 2 > end ? -1 : le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]; }
    function u32(o) { return o + 4 > end ? -1 : le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216 : b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
    /* записи каталога: tag -> {type, count, at (где лежит значение)} */
    function ifd(rel) {
      var o = t + rel, out = {}, cnt = u16(o);
      if (rel <= 0 || cnt < 0 || cnt > 500) return out;
      for (var i = 0; i < cnt; i++) {
        var e = o + 2 + i * 12;
        if (e + 12 > end) break;
        var count = u32(e + 4);
        out[u16(e)] = { type: u16(e + 2), count: count, at: count <= 4 ? e + 8 : t + u32(e + 8), raw: u32(e + 8) };
      }
      return out;
    }
    function ascii(x) {
      if (!x || x.type !== 2 || x.at < 0 || x.at + x.count > end) return '';
      var s = '';
      for (var i = 0; i < x.count && b[x.at + i]; i++) s += String.fromCharCode(b[x.at + i]);
      return s.trim();
    }
    var ifd0 = ifd(u32(t + 4));
    var ex = ifd0[0x8769] ? ifd(ifd0[0x8769].raw) : {};
    var dt = ascii(ex[0x9003]) || ascii(ex[0x9004]) || ascii(ifd0[0x0132]);
    var m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(dt);
    if (!m || m[1] === '0000') return '';
    var sub = (ascii(ex[0x9291]) || ascii(ex[0x9292]) || '').replace(/\D/g, '');
    sub = (sub + '000').slice(0, 3);
    return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '.' + sub;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = exifTime;
  else root.stExifTime = exifTime;
})(this);
