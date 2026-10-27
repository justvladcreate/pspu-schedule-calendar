'use strict';

/* ============================================================
 *  Источники «Оригинала».
 *
 *  Google Sheets — htmlview-страница (см. sheets.js).
 *  XLSX-факультеты — предрендеренные на бэкенде листы
 *  (web/data/faculties/<id>/sheets.json + sheets/*.html):
 *  openpyxl сохраняет шрифты, цвета, рамки и объединённые ячейки,
 *  поэтому таблица выглядит как в Excel.
 * ============================================================ */

export function createGoogleSource(spreadsheetId) {
    return {
        type: 'google',
        async list(fetchSheetList) {
            return fetchSheetList(spreadsheetId);
        },
        async htmlFor(fetchSheetHtml, gid) {
            return fetchSheetHtml(spreadsheetId, gid);
        },
    };
}

/**
 * Предрендеренные листы факультета.
 * folder — путь относительно web/, например «data/faculties/01».
 */
export function createStaticSource(folder) {
    const base = String(folder || '').replace(/\/+$/, '');
    let indexPromise = null;

    function loadIndex() {
        if (!indexPromise) {
            indexPromise = (async () => {
                const resp = await fetch(`${base}/sheets.json`, { cache: 'no-store' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                return Array.isArray(data?.sheets) ? data.sheets : [];
            })().catch((error) => {
                indexPromise = null;
                throw error;
            });
        }
        return indexPromise;
    }

    return {
        type: 'static',
        async list() {
            const sheets = await loadIndex();
            return sheets.map((sheet) => ({
                name: sheet.name,
                gid: sheet.name,
                file: sheet.file,
            }));
        },
        async htmlFor(_fetchSheetHtml, gid) {
            const sheets = await loadIndex();
            const sheet = sheets.find((item) => item.name === gid);
            if (!sheet) {
                throw new Error(`Лист «${gid}» не найден`);
            }
            const resp = await fetch(`${base}/${sheet.file}`, { cache: 'force-cache' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.text();
        },
    };
}
