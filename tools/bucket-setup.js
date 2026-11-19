/* Настройка бакета Content Pulse Studio (один раз; повторный запуск ничего не ломает).
   Запуск: node tools/bucket-setup.js <s3-key.json> <имя бакета> [адрес страницы]
   s3-key.json — {S3_KEY_ID, S3_SECRET} статического ключа сервисного аккаунта.
   Делает:
     1. создаёт закрытый бакет (если его ещё нет);
     2. правило жизненного цикла: exports/ (архивы скачивания) — удалять через 3 дня,
        оборванные многочастные загрузки — через 2 дня; проекты сами не удаляются;
     3. CORS: страница на GitHub Pages (и localhost для проверки) может заливать
        кадры по подписанным ссылкам и показывать превью; ETag виден странице —
        он нужен, чтобы собрать большой файл из частей;
     4. проверка: запись, чтение по подписанной ссылке, удаление. */
'use strict';
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const [keyFile, bucket, origin] = process.argv.slice(2);
if (!keyFile || !bucket) { console.error('node tools/bucket-setup.js <s3-key.json> <bucket> [origin]'); process.exit(2); }
const k = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
Object.assign(process.env, { S3_KEY_ID: k.S3_KEY_ID, S3_SECRET: k.S3_SECRET, S3_BUCKET: bucket });
const { s3Call, s3Presign } = require('../proxy/index.js')._s3;
const PAGE = origin || 'https://barinskim-cmyk.github.io';

function md5(s) { return crypto.createHash('md5').update(s).digest('base64'); }
function get(url) { return new Promise((res, rej) => https.get(url, (r) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => res({ status: r.statusCode, body: t, headers: r.headers })); }).on('error', rej)); }

(async () => {
  let r = await s3Call('PUT', '', {}, '', {});
  if (r.status === 200) console.log('бакет создан:', bucket);
  else if (/BucketAlreadyOwnedByYou/.test(r.body)) console.log('бакет уже есть и он ваш:', bucket);
  else { console.error('бакет не создан: HTTP', r.status, r.body.slice(0, 300)); process.exit(1); }

  const life = '<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration>'
    + '<Rule><ID>exports</ID><Status>Enabled</Status><Filter><Prefix>exports/</Prefix></Filter><Expiration><Days>3</Days></Expiration></Rule>'
    + '<Rule><ID>abort-uploads</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>2</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>'
    + '</LifecycleConfiguration>';
  r = await s3Call('PUT', '', { lifecycle: '' }, life, { 'content-md5': md5(life), 'content-type': 'application/xml' });
  console.log('жизненный цикл:', r.status, r.status === 200 ? 'ok' : r.body.slice(0, 300));

  const corsXml = '<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule>'
    + [PAGE, 'http://localhost:*', 'http://127.0.0.1:*'].map((o) => '<AllowedOrigin>' + o + '</AllowedOrigin>').join('')
    + '<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>'
    + '<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>'
    + '</CORSRule></CORSConfiguration>';
  r = await s3Call('PUT', '', { cors: '' }, corsXml, { 'content-md5': md5(corsXml), 'content-type': 'application/xml' });
  console.log('CORS:', r.status, r.status === 200 ? 'ok' : r.body.slice(0, 300));

  const key = 'exports/_setup-check.txt', text = 'content-pulse-studio ' + new Date().toISOString();
  r = await s3Call('PUT', key, {}, text, { 'content-type': 'text/plain' });
  const g = await get(s3Presign('GET', key, 300));
  console.log('проверка записи/чтения:', r.status, g.status, g.body === text ? 'совпало' : 'НЕ СОВПАЛО');
  const anon = await get('https://storage.yandexcloud.net/' + bucket + '/' + key);
  console.log('без подписи (должно быть 403):', anon.status);
  await s3Call('DELETE', key);
})().catch((e) => { console.error(e); process.exit(1); });
