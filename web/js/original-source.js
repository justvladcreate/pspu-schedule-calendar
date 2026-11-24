'use strict';

/* ============================================================
 *  Источники «Оригинала».
 *
 *  Google Sheets — htmlview-страница (см. sheets.js).
 *  XLSX-факультеты — предрендеренные на бэкенде листы
 *  (web/data/faculties/<id>/sheets.json + sheets/*.html):
 *  openpyxl сохраняет шрифты, цвета, рамки и объединённые ячейки,
 *  поэтому таблица выглядит как в Excel.
 *
 *  У факультета может быть несколько исходных файлов (очное,
 *  заочное, экзамены, ГИА) — тогда в списке листов лежат все.
 *  Имя файла листа содержит хэш содержимого, поэтому новый лист
 *  всегда приходит по новому адресу и не залипает в кэше браузера.
 * ============================================================ */

/** Короткая подпись типа листа — только для не-очных файлов. */
const KIND_LABEL = {
    zo: 'заочно',
    oo_exams: 'зачёты',
    zo_exams: 'зачёты, заочно',
    exams: 'зачёты',
    gia: 'ГИА',
};

/** Подпись листа: у ГИА она своя, у остальных — по типу занятий. */
export function sheetKindLabel(sheet) {
    const source = (sheet && sheet.source) || '';
    if (source === 'gia') return KIND_LABEL.gia;
    const kind = (sheet && sheet.kind) || '';
    if (kind === 'oo' || kind === '') return '';
    return KIND_LABEL[source] || KIND_LABEL[kind] || '';
}

/** Подпись листа в полосе вкладок: «Z152 · заочно», «152 · ГИА». */
export function sheetTitle(sheet) {
    const label = sheetKindLabel(sheet);
    return label ? `${sheet.name} · ${label}` : String((sheet && sheet.name) || '');
}

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
                // id уникален даже для одинаковых имён листов из разных
                // файлов (например, «152» в очном и в сессии).
                gid: sheet.id || sheet.name,
                file: sheet.file,
                kind: sheet.kind || '',
                source: sheet.source || '',
            }));
        },
        async htmlFor(_fetchSheetHtml, gid) {
            const sheets = await loadIndex();
            const sheet = sheets.find(
                (item) => String(item.id || item.name) === String(gid)
            ) || sheets.find((item) => String(item.name) === String(gid));
            if (!sheet) {
                throw new Error(`Лист «${gid}» не найден`);
            }
            // В имени файла лежит хэш содержимого, поэтому кэш безопасен:
            // изменился лист — изменилось имя.
            const resp = await fetch(`${base}/${sheet.file}`, { cache: 'force-cache' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.text();
        },
    };
}
