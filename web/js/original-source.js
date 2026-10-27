'use strict';

/* ============================================================
 *  Источники «Оригинала»: Google Sheets и XLSX с cloud.mail.
 *
 *  Google отдаёт htmlview-страницу (см. sheets.js).
 *  XLSX скачивается с нашего же сайта (файл публикует парсер) и
 *  разбирается SheetJS прямо в браузере — без сторонних доменов.
 * ============================================================ */

let libPromise = null;

function loadXlsxLib() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (libPromise) return libPromise;

    libPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'vendor/xlsx.mini.min.js';
        script.async = true;
        script.onload = () => {
            if (window.XLSX) resolve(window.XLSX);
            else reject(new Error('XLSX не инициализировался'));
        };
        script.onerror = () => reject(new Error('Не удалось загрузить XLSX-библиотеку'));
        document.head.appendChild(script);
    });

    return libPromise;
}

const SHEET_CSS = `
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    font: 13px/1.35 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    color: #111;
  }
  table {
    border-collapse: collapse;
    background: #fff;
  }
  td, th {
    border: 1px solid #d7d7d7;
    padding: 4px 7px;
    vertical-align: top;
    white-space: pre-wrap;
    max-width: 420px;
  }
  tr:first-child td { background: #f4f6f9; font-weight: 600; }
`;

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Один проход по ячейкам листа: реальные границы (форматирование
 * растягивает «!ref» на сотни пустых строк) и длины текста по колонкам.
 */
function scanSheet(XLSX, sheet) {
    const ref = sheet['!ref'];
    if (!ref) {
        return { lastRow: 0, lastCol: 0, lengths: [] };
    }

    const range = XLSX.utils.decode_range(ref);
    let lastRow = range.s.r;
    let lastCol = range.s.c;
    const lengths = [];

    // Объединённые заголовки («Расписание…», «Направление…») лежат в одной
    // ячейке и раздувают ширину первой колонки — их в расчёт не берём.
    const mergedTitles = new Set(
        (sheet['!merges'] || [])
            .filter((merge) => merge.e.c > merge.s.c)
            .map((merge) => `${merge.s.r}:${merge.s.c}`),
    );

    for (let column = range.s.c; column <= range.e.c; column += 1) {
        const columnLengths = [];
        for (let row = range.s.r; row <= range.e.r; row += 1) {
            if (mergedTitles.has(`${row}:${column}`)) continue;
            const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
            if (!cell || cell.v === undefined || cell.v === null) continue;
            const text = String(cell.v);
            if (!text.trim()) continue;
            if (row > lastRow) lastRow = row;
            if (column > lastCol) lastCol = column;
            columnLengths.push(
                Math.max(...text.split('\n').map((line) => line.length)),
            );
        }
        lengths.push(columnLengths);
    }

    return { lastRow, lastCol, lengths };
}

function percentile(values, share) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * share),
    );
    return sorted[index];
}

function columnWidths(lengths) {
    return lengths.map((columnLengths) => {
        const typical = percentile(columnLengths, 0.9);
        return Math.min(Math.max(typical * 7 + 16, 56), 380);
    });
}

function clippedRef(XLSX, base, lastRow, lastCol) {
    const range = XLSX.utils.decode_range(base);
    range.e.r = Math.max(lastRow, range.s.r);
    range.e.c = Math.max(lastCol, range.s.c);
    return XLSX.utils.encode_range(range);
}

function workbookHtml(XLSX, workbook, sheetName) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
        return `<html><body><p style="padding:16px">Лист «${escapeHtml(sheetName)}» не найден</p></body></html>`;
    }

    const { lastRow, lastCol, lengths } = scanSheet(XLSX, sheet);
    const clipped = {
        ...sheet,
        '!ref': clippedRef(XLSX, sheet['!ref'] || 'A1', lastRow, lastCol),
    };

    const html = XLSX.utils.sheet_to_html(clipped, {
        id: 'xlsx-sheet',
        header: '',
        footer: '',
    });

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;

    const table = wrapper.querySelector('table');
    if (table) {
        const widths = columnWidths(lengths);
        const colgroup = document.createElement('colgroup');
        let total = 0;
        for (const width of widths) {
            const col = document.createElement('col');
            col.style.width = `${width}px`;
            colgroup.appendChild(col);
            total += width;
        }
        table.insertBefore(colgroup, table.firstChild);
        table.style.tableLayout = 'fixed';
        table.style.width = `${total}px`;
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SHEET_CSS}</style></head>`
         + `<body>${wrapper.innerHTML}</body></html>`;
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

export function createXlsxSource(file) {
    let workbookPromise = null;

    function workbook() {
        if (!workbookPromise) {
            workbookPromise = (async () => {
                const XLSX = await loadXlsxLib();
                const resp = await fetch(file, { cache: 'force-cache' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const buffer = await resp.arrayBuffer();
                return { XLSX, book: XLSX.read(buffer, { type: 'array' }) };
            })().catch((error) => {
                workbookPromise = null;
                throw error;
            });
        }
        return workbookPromise;
    }

    return {
        type: 'xlsx',
        async list() {
            const { book } = await workbook();
            return (book.SheetNames || []).map((name) => ({ name, gid: name }));
        },
        async htmlFor(_fetchSheetHtml, gid) {
            const { XLSX, book } = await workbook();
            return workbookHtml(XLSX, book, gid);
        },
    };
}
