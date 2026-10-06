#!/usr/bin/env node
/**
 * Считает SHA-1 от содержимого всех кэшируемых файлов
 * и записывает его в CACHE-константу sw.js.
 *
 * Использование:
 *   node tools/bump-sw.mjs                # root = текущая папка
 *   node tools/bump-sw.mjs --root web     # root = ./web
 *   node tools/bump-sw.mjs web            # тоже root = ./web (короче)
 *
 * Не требует зависимостей — только стандартный Node ≥ 16.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* --- парсим аргументы --- */
const args = process.argv.slice(2);
let rootArg = '.';
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
        rootArg = args[++i];
    } else if (!args[i].startsWith('-')) {
        rootArg = args[i];
    }
}
const ROOT = resolve(__dirname, '..', rootArg);

/**
 * Список файлов, чей контент влияет на версию кэша.
 * Пути — относительно ROOT (т.е. относительно web/).
 *
 * НЕ включаем: sw.js (сам себя), data.json / old_data.json
 * (они network-first, версия SW их не касается).
 */
const WATCHED = [
    'index.html',
    'manifest.json',
    'css/base.css',
    'css/toolbar.css',
    'css/filter.css',
    'css/calendar.css',
    'css/load.css',
    'css/popover.css',
    'css/modals.css',
    'css/mobile.css',
    'css/export-toast.css',
    'css/changes.css',
    'css/url-context.css',
    'js/main.js',
    'js/state.js',
    'js/config.js',
    'js/utils.js',
    'js/data.js',
    'js/render.js',
    'js/load-view.js',
    'js/layout.js',
    'js/navigation.js',
    'js/datepicker.js',
    'js/filters.js',
    'js/popover.js',
    'js/gestures.js',
    'js/export.js',
    'js/version.js',
    'js/online.js',
    'js/readme.js',
    'js/markdown.js',
    'js/toast.js',
    'js/changes.js',
    'js/changes-modal.js',
    'js/update-banner.js',
    'js/share.js',
    'js/more-menu.js',
    'js/original.js',
];

async function hashFiles() {
    const h = createHash('sha1');
    let count = 0;
    for (const rel of WATCHED) {
        try {
            const buf = await readFile(join(ROOT, rel));
            h.update(rel);
            h.update(buf);
            count++;
        } catch (e) {
            console.warn(`[bump-sw] ⚠ пропущен ${rel} (${e.code || e.message})`);
        }
    }
    if (count === 0) {
        throw new Error(`Ни один файл не найден в ${ROOT}. Проверьте --root.`);
    }
    return h.digest('hex').slice(0, 8);
}

async function main() {
    const hash = await hashFiles();
    const swPath = join(ROOT, 'sw.js');

    let src;
    try {
        src = await readFile(swPath, 'utf8');
    } catch (e) {
        throw new Error(`Не читается ${swPath}: ${e.message}`);
    }

    const re = /const CACHE = 'pspu-schedule-v[\w.-]+';/;
    if (!re.test(src)) {
        throw new Error(`В ${swPath} не найдена строка \`const CACHE = ...\``);
    }

    const before = src.match(re)[0];
    const next   = `const CACHE = 'pspu-schedule-v${hash}';`;

    if (before === next) {
        console.log(`✓ sw.js уже актуален: ${next}`);
        return;
    }

    src = src.replace(re, next);
    await writeFile(swPath, src, 'utf8');

    console.log(`✅ sw.js обновлён (root=${rootArg}):`);
    console.log(`   было:  ${before}`);
    console.log(`   стало: ${next}`);
}

main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
});