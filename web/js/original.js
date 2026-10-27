'use strict';

import { fetchSheetHtml } from './sheets.js';
import { createGoogleSource, createXlsxSource } from './original-source.js';
import { state } from './state.js';
import {
    mountSheetFrame, findCellInFrame, focusCellInFrame,
    setupFrameGestures,
} from './sheet-render.js';

/**
 * Модалка «Оригинал» — просмотр исходной Google Таблицы.
 *
 * Раньше: iframe.src = htmlview/sheet — кросс-домен, никакого контроля.
 * Сейчас: fetch htmlview → санитайз → srcdoc-iframe. Origin свой,
 * поэтому можно фокусировать и подсвечивать ячейки.
 *
 * Список листов кэшируется в localStorage (ogлавление htmlview).
 * Содержимое листов кэшируется в памяти до перезагрузки.
 */

const SHEETS_CACHE_KEY = 'pspu-original-sheets';
const SHEETS_CACHE_TTL = 24 * 60 * 60 * 1000;
const LAST_GID_KEY     = 'pspu-original-last-gid';
const ZOOM_KEY         = 'pspu-original-zoom';

/* Дефолт — «золотая середина»: с одной стороны видно несколько
   колонок листа сразу, с другой стороны текст остаётся читаемым.
   Пользователь свободно уходит и дальше (0.15) и ближе (2.5). */
function defaultZoom() {
    return window.innerWidth <= 900 ? 0.5 : 0.85;
}
function getZoom() {
    try {
        const v = parseFloat(localStorage.getItem(ZOOM_KEY));
        if (Number.isFinite(v) && v >= 0.15 && v <= 2.5) return v;
    } catch {}
    return defaultZoom();
}
function saveZoom(v) { try { localStorage.setItem(ZOOM_KEY, String(v)); } catch {} }

let sheetsPromise = null;
let sheets = [];
let currentGid = null;
let currentFrame = null;      // { iframe, doc, win }
let currentGestureCleanup = null;

function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : '';
}
function isOnline() { return navigator.onLine !== false; }
function extractSpreadsheetId(url) {
    const m = String(url || '').match(/\/d\/([^/]+)/);
    return m ? m[1] : '';
}

/* ---------- список листов ---------- */

async function fetchSheetList(spreadsheetId) {
    let cachedList = null;
    try {
        const raw = localStorage.getItem(SHEETS_CACHE_KEY);
        if (raw) {
            const { at, id, list } = JSON.parse(raw);
            if (id === spreadsheetId && Array.isArray(list) && list.length) {
                cachedList = list;
                if (Date.now() - at < SHEETS_CACHE_TTL) return list;
            }
        }
    } catch {}
    if (cachedList) {
        fetchSheetListFromNetwork(spreadsheetId).catch(() => {});
        return cachedList;
    }
    return fetchSheetListFromNetwork(spreadsheetId);
}

async function fetchSheetListFromNetwork(spreadsheetId) {
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview`;
    const html = await (await fetch(url)).text();

    const re = /items\.push\(\{name:\s*"([^"]+)"[^}]*?gid:\s*"(\d+)"/g;
    const list = [];
    const seen = new Set();
    for (const m of html.matchAll(re)) {
        if (seen.has(m[2])) continue;
        seen.add(m[2]);
        list.push({ name: m[1], gid: m[2] });
    }

    if (list.length) {
        try {
            localStorage.setItem(SHEETS_CACHE_KEY,
                JSON.stringify({ at: Date.now(), id: spreadsheetId, list }));
        } catch {}
    }
    return list;
}

function findGidByGroup(group) {
    if (!group) return null;
    const g = String(group).trim();
    if (!g) return null;
    for (const s of sheets) if (String(s.name).trim() === g) return s.gid;
    for (const s of sheets) if (String(s.name).trim().startsWith(g)) return s.gid;
    return null;
}

/* ============================================================ */

export function setupOriginalModal() {
    const btn      = document.getElementById('originalBtn');
    const modal    = document.getElementById('originalModal');
    const dialog   = modal && modal.querySelector('.original-modal');
    const closeBtn = modal && modal.querySelector('.original-close');
    const renderEl = document.getElementById('originalSheetRender');
    const wrapEl   = document.getElementById('originalSheetWrap');
    const offline  = document.getElementById('originalOffline');
    const external = document.getElementById('originalExternal');
    const tabsBox  = document.getElementById('originalSheetTabs');
    const zoomBox  = document.getElementById('originalZoomControls');

    // Текущий zoom в памяти. touchmove меняет его, но в localStorage
    // не пишет — иначе 60 записей в секунду на каждом кадре жеста.
    // Единственный момент сохранения — onCommit в setupFrameGestures
    // (см. touchend), либо кнопки +/-.
    let currentZoom = getZoom();

    const internalUrl   = getMeta('original-schedule-url');
    const externalUrl   = getMeta('original-schedule-external') || internalUrl;
    const defaultSpreadsheetId = extractSpreadsheetId(internalUrl);

    if (!btn || !modal || !renderEl || !wrapEl) {
        return { open: () => {}, focusOn: () => {}, close: () => {} };
    }

    /* ---------- выбор факультета ---------- */

    let source = null;          // текущий источник («google» или «xlsx»)
    let spreadsheetId = defaultSpreadsheetId;
    let activeFacultyId = null;

    function facultyMeta(id) {
        return (state.faculties || []).find(
            item => String(item.id) === String(id)
        ) || null;
    }

    function pickFacultyId(ev) {
        if (ev && ev.faculty_id) return String(ev.faculty_id);
        const selected = [...(state.selectedFaculties || [])];
        if (selected.length) return String(selected[0]);
        return activeFacultyId || '12';
    }

    function activateFaculty(facultyId) {
        const id = String(facultyId || '12');
        const meta = facultyMeta(id);
        const original = (meta && meta.original) || null;

        if (id === activeFacultyId && source) return;

        activeFacultyId = id;
        sheetsPromise = null;
        sheets = [];
        currentGid = null;
        buildTabs();

        if (original && original.type === 'google_sheets' && original.spreadsheet_id) {
            spreadsheetId = original.spreadsheet_id;
            source = createGoogleSource(spreadsheetId);
        } else if (original && original.type === 'cloud_mail' && original.file) {
            spreadsheetId = '';
            source = createXlsxSource(`data/${original.file}`);
        } else if (defaultSpreadsheetId) {
            // Старые данные без блока original — ведём себя как раньше.
            spreadsheetId = defaultSpreadsheetId;
            source = createGoogleSource(spreadsheetId);
        } else {
            spreadsheetId = '';
            source = null;
        }

        if (external) {
            external.setAttribute(
                'href',
                (original && (original.url || original.file)) || externalUrl
            );
        }
    }

    if (external) external.setAttribute('href', externalUrl);

    /* ---------- вкладки ---------- */

    function setActiveTab(gid) {
        if (!tabsBox) return;
        tabsBox.querySelectorAll('.original-sheet-tab').forEach(el => {
            el.classList.toggle('is-active', el.dataset.gid === gid);
        });
        const active = tabsBox.querySelector('.original-sheet-tab.is-active');
        if (active) {
            try {
                active.scrollIntoView({
                    behavior: 'smooth', block: 'nearest', inline: 'center',
                });
            } catch {}
        }
    }

    function buildTabs() {
        if (!tabsBox) return;
        tabsBox.innerHTML = '';
        if (sheets.length === 0) { tabsBox.hidden = true; return; }
        tabsBox.hidden = false;

        for (const sheet of sheets) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'original-sheet-tab';
            b.dataset.gid = sheet.gid;
            b.textContent = sheet.name;
            b.setAttribute('role', 'tab');
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                if (currentGid === sheet.gid) return;
                showSheet(sheet.gid);
            });
            tabsBox.appendChild(b);
        }
    }

    /* ---------- зум ---------- */
    function applyZoom() {
        const frame = currentFrame;
        if (!frame || !wrapEl) return;

        const { iframe, stage, nativeW, nativeH } = frame;

        // Размер stage = визуальный размер iframe с учётом scale.
        // Сам iframe НЕ трогаем — его width/height фиксированы
        // по натуральному размеру контента. Zoom — чисто transform,
        // layout внутри iframe не пересчитывается.
        stage.style.width  = (nativeW * currentZoom) + 'px';
        stage.style.height = (nativeH * currentZoom) + 'px';
        iframe.style.transformOrigin = '0 0';
        iframe.style.transform = `scale(${currentZoom})`;

        if (zoomBox) zoomBox.hidden = false;
    }

    function setupZoomControls() {
        if (!zoomBox) return;
        zoomBox.querySelectorAll('.original-zoom-btn').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const dir = b.dataset.zoom;
                const cur = currentZoom;
                let z;
                if (dir === 'in') {
                    z = Math.min(2.5, +(cur + 0.1).toFixed(2));
                } else {
                    z = Math.max(0.15, +(cur - 0.1).toFixed(2));
                }
                if (z === cur) return;
                currentZoom = z;
                saveZoom(z);
                applyZoom();
            });
        });
    }
    setupZoomControls();

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        if (!modal.classList.contains('open')) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(applyZoom, 120);
    });

    /* ---------- рендер листа ---------- */

    async function showSheet(gid, { focusEvent } = {}) {
        if (!source || !gid) return;
        currentGid = gid;
        try { localStorage.setItem(LAST_GID_KEY, gid); } catch {}
        setActiveTab(gid);

        if (dialog) dialog.classList.remove('is-loaded');

        try {
            const html = await source.htmlFor(fetchSheetHtml, gid);
            if (currentGid !== gid) return;   // гонка: успели переключиться

            if (currentGestureCleanup) {
                currentGestureCleanup();
                currentGestureCleanup = null;
            }

            currentZoom = getZoom();

            // Сбрасываем скролл wrap'а — новый лист начинается сверху.
            if (wrapEl) {
                wrapEl.scrollLeft = 0;
                wrapEl.scrollTop  = 0;
            }

            const mounted = await mountSheetFrame(renderEl, html);
            currentFrame = mounted;

            // Pinch-to-zoom. Работаем через wrap, потому что скролл
            // теперь живёт в родителе, а не в iframe.
            currentGestureCleanup = setupFrameGestures(
                mounted.iframe,
                wrapEl,
                {
                    getZoom: () => currentZoom,
                    setZoom: (z) => {
                        currentZoom = z;
                        applyZoom();
                    },
                    onCommit: (z) => {
                        saveZoom(z);
                    },
                }
            );

            applyZoom();
            if (dialog) dialog.classList.add('is-loaded');

            if (focusEvent) {
                setTimeout(() => {
                    const td = findCellInFrame(mounted.doc, {
                        position:   focusEvent.position,
                        discipline: focusEvent.discipline,
                        dates:      focusEvent.dates,
                        teachers:   focusEvent.teachers,
                        weekday:    focusEvent.weekday,
                        pairNumber: focusEvent.pair_number,
                        timeStart:  focusEvent.time_start,
                    });
                    if (td) focusCellInFrame(wrapEl, mounted.iframe, td, currentZoom);
                }, 80);
            }
        } catch (e) {
            console.warn('[original] render failed:', e);
            renderEl.innerHTML =
                '<div style="padding:20px;color:#c62828;font:14px Arial,sans-serif">'
              + 'Не удалось загрузить лист. Проверьте подключение к интернету.</div>';
            if (dialog) dialog.classList.add('is-loaded');
        }
    }

    /* ---------- список листов ---------- */

    function ensureSheets() {
        if (sheetsPromise) return sheetsPromise;
        if (!source) return Promise.resolve([]);

        sheetsPromise = source.list(fetchSheetList)
            .then((list) => {
                sheets = list || [];
                buildTabs();
                return sheets;
            })
            .catch((e) => {
                console.warn('[original] не удалось получить список листов:', e);
                sheetsPromise = null;
                return [];
            });
        return sheetsPromise;
    }

    /* ---------- open / close ---------- */

    async function open() {
        activateFaculty(pickFacultyId());
        modal.classList.add('open');
        document.body.classList.add('modal-open');

        if (!isOnline()) {
            if (offline) offline.hidden = false;
            if (wrapEl) wrapEl.style.display = 'none';
            if (zoomBox) zoomBox.hidden = true;
            return;
        }
        if (offline) offline.hidden = true;
        if (wrapEl) wrapEl.style.display = '';

        const list = await ensureSheets();

        let gid = currentGid;
        if (!gid) {
            try { gid = localStorage.getItem(LAST_GID_KEY); } catch {}
        }
        if (!gid || !list.some(s => String(s.gid) === String(gid))) {
            gid = list.length ? list[0].gid : '';
        }
        if (!gid) return;

        setActiveTab(gid);
        showSheet(gid);
    }

    function close() {
        modal.classList.remove('open');
        document.body.classList.remove('modal-open');
    }

    /* ---------- фокус на событии из поповера ---------- */

    async function focusOn(ev) {
        if (!ev) return;
        activateFaculty(pickFacultyId(ev));
        modal.classList.add('open');
        document.body.classList.add('modal-open');

        if (!isOnline()) {
            if (offline) offline.hidden = false;
            if (wrapEl) wrapEl.style.display = 'none';
            return;
        }
        if (offline) offline.hidden = true;
        if (wrapEl) wrapEl.style.display = '';

        try { await ensureSheets(); } catch {}

        const gid = findGidByGroup(ev.group)
            || currentGid
            || (sheets.length ? sheets[0].gid : '');

        if (!gid) return;
        await showSheet(gid, { focusEvent: ev });
    }

    /* ---------- handlers ---------- */

    btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', (e) => {
        if (e.target === modal && window.innerWidth > 900) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });

    const warmup = () => { ensureSheets(); };
    if ('requestIdleCallback' in window) {
        requestIdleCallback(warmup, { timeout: 3000 });
    } else {
        setTimeout(warmup, 1500);
    }

    return { open, focusOn, close };
}