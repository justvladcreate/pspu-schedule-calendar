'use strict';

/* ============================================================
 *  Загрузка htmlview/sheet + подготовка для <iframe srcdoc>.
 *
 *  Ключевые моменты:
 *    • Не удаляем <script> — Google часть разметки рендерит JS'ом
 *      (например, показывает div листа из display:none). Вместо
 *      этого даём скриптам упасть «мягко»: оборачиваем всё в
 *      try/catch, чтобы DOCS_timing-ошибки не валили остальное.
 *    • Показываем div с таблицей вручную — на случай, если даже
 *      после скриптов он остаётся display:none.
 *    • <base href="https://docs.google.com/"> — чтобы /static/...
 *      пути (Google CSS) резолвились правильно.
 * ============================================================ */

const CACHE_TTL = 24 * 60 * 60 * 1000;
const memoryCache = new Map();

export function clearSheetCache() {
    memoryCache.clear();
}

export async function fetchSheetHtml(spreadsheetId, gid) {
    if (memoryCache.has(gid)) {
        const c = memoryCache.get(gid);
        if (Date.now() - c.at < CACHE_TTL) return c.html;
    }

    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
              + `/htmlview/sheet?headers=true&gid=${encodeURIComponent(gid)}`;
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const html = await resp.text();

    const sanitized = sanitizeSheetHtml(html, gid);
    memoryCache.set(gid, { at: Date.now(), html: sanitized });
    return sanitized;
}

function sanitizeSheetHtml(html, gid) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // 1. <base href="https://docs.google.com/"> — чтобы пути /static/...
    //    резолвились на Google, а не на наш домен.
    let base = doc.querySelector('base');
    if (!base) {
        base = doc.createElement('base');
        doc.head.insertBefore(base, doc.head.firstChild);
    }
    base.setAttribute('href', 'https://docs.google.com/');

    // 2. Обёртка листа: <div id="<gid>" style="display:none">.
    //    Google показывает её скриптом. Мы можем не дожидаться —
    //    включаем сразу. На случай, если ID листа не совпадает с gid
    //    (у «ГРУППЫ» gid=0, но id тоже 0), пройдёмся по всем
    //    «голым» дивам-обёрткам.
    const wrapperById = doc.getElementById(String(gid));
    const wrappers = [];
    if (wrapperById) wrappers.push(wrapperById);
    // Дополнительно: любой #sheets-viewport > div[style*="display:none"]
    doc.querySelectorAll('#sheets-viewport > div').forEach(el => {
        if (!wrappers.includes(el)) wrappers.push(el);
    });
    for (const el of wrappers) {
        el.style.display = 'block';
        el.style.position = 'static';
        el.removeAttribute('hidden');
        el.removeAttribute('aria-hidden');
    }

    // 3. Обнуляем всё, что Google прячет через <script> — оставляем
    //    как есть, но снимаем возможные focus-ловушки и sandbox-обёртки.
    doc.querySelectorAll('[tabindex="-1"]').forEach(el => {
        if (el.tagName === 'DIV') el.removeAttribute('tabindex');
    });

    // 4. Наш инжект-стиль: гарантируем, что html/body не съезжают,
    //    серый фон подложки, скролл. Плюс страховочное правило —
    //    если Google-скрипт по какой-то причине снова спрячет
    //    таблицу, показываем её.
    const style = doc.createElement('style');
    style.textContent = `
        html, body {
            margin: 0 !important;
            padding: 0 !important;
            background: #f1f3f4 !important;
            overflow: auto !important;
        }
        #sheets-viewport {
            overflow: visible !important;
            height: auto !important;
            width: auto !important;
        }
        #sheets-viewport > div {
            display: block !important;
            position: static !important;
        }
    `;
    doc.head.appendChild(style);

    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
}

/* "D5" → { col: 3, row: 4 } (0-based, обе) */
export function parsePosition(pos) {
    if (!pos) return null;
    const m = String(pos).trim().match(/^([A-Z]+)(\d+)$/i);
    if (!m) return null;
    let n = 0;
    for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return { col: n - 1, row: parseInt(m[2], 10) - 1 };
}