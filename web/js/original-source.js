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

function workbookHtml(XLSX, workbook, sheetName) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
        return `<html><body><p style="padding:16px">Лист «${escapeHtml(sheetName)}» не найден</p></body></html>`;
    }

    const table = XLSX.utils.sheet_to_html(sheet, {
        id: 'xlsx-sheet',
        header: '',
        footer: '',
    });

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SHEET_CSS}</style></head>`
         + `<body>${table}</body></html>`;
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
