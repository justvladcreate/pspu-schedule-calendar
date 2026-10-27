#!/usr/bin/env node
/**
 * Скачивает исходные XLSX факультетов с cloud.mail.ru в артефакт
 * GitHub Pages, чтобы «Оригинал» открывался встроенно.
 *
 * В репозитории эти файлы не хранятся — только на собранном сайте.
 *
 * Использование:
 *   node tools/fetch-faculty-xlsx.mjs --root web
 *
 * Читает web/data/index.json: для каждой записи, где
 * original.type === 'cloud_mail' и есть original.url, кладёт файл
 * в web/data/faculties/<id>.xlsx.
 *
 * Ошибки не валят сборку: без файла фронтенд предложит открыть
 * ссылку на облако.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
let rootArg = '.';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) rootArg = args[++i];
  else if (!args[i].startsWith('-')) rootArg = args[i];
}
const ROOT = resolve(__dirname, '..', rootArg);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120 Safari/537.36';

// Python-функция quote(weblink, safe="~@#$()*!=:;,.?/\\'").
const SAFE = /%(7E|40|23|24|28|29|2A|21|3D|3A|3B|2C|2E|3F|2F|5C|27)/gi;

function quote(value) {
  return encodeURIComponent(value).replace(SAFE, (match) =>
    String.fromCharCode(parseInt(match.slice(1), 16)),
  );
}

async function getText(url, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://cloud.mail.ru/' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function getBinary(url, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://cloud.mail.ru/' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Публичная страница → { base, weblink }. */
async function resolvePublicFile(url) {
  const html = await getText(url);

  const baseMatch = html.match(/"weblink_get":\{"count":"?1"?,"url":"([^"]+)"/);
  if (!baseMatch) throw new Error('не найден weblink_get');

  const linkMatch = html.match(/"weblink":"([^"]+)"/);
  if (!linkMatch) throw new Error('не найден weblink');

  return { base: baseMatch[1], weblink: decodeURIComponent(linkMatch[1]) };
}

async function downloadOne(url) {
  const { base, weblink } = await resolvePublicFile(url);
  const data = await getBinary(`${base}/${quote(weblink)}`);
  if (data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new Error('ответ не похож на XLSX');
  }
  return data;
}

async function main() {
  const indexPath = resolve(ROOT, 'data/index.json');
  let index;
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch (error) {
    console.warn(`[xlsx] нет ${indexPath}: ${error.message}`);
    return;
  }

  const faculties = (index.faculties || []).filter(
    (item) => item.original && item.original.type === 'cloud_mail' && item.original.url,
  );
  if (!faculties.length) {
    console.log('[xlsx] нечего скачивать');
    return;
  }

  let ok = 0;
  for (const faculty of faculties) {
    const folder = faculty.folder || `faculties/${faculty.id}`;
    const target = resolve(ROOT, folder, faculty.original.file || 'source.xlsx');
    try {
      const data = await downloadOne(faculty.original.url);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
      ok++;
      console.log(`[xlsx] ${faculty.id}: ${(data.length / 1024).toFixed(0)} КБ`);
    } catch (error) {
      console.warn(`[xlsx] ${faculty.id}: не удалось (${error.message})`);
    }
  }

  console.log(`[xlsx] готово: ${ok} из ${faculties.length}`);
}

main().catch((error) => {
  console.error('[xlsx] fatal:', error);
  process.exitCode = 0;
});
