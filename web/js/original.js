'use strict';

import { fetchSheetHtml } from './sheets.js';
import { mountSheetFrame, findCellInFrame, focusCellInFrame } from './sheet-render.js';

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

function defaultZoom() { return window.innerWidth <= 900 ? 0.85 : 1.0; }
function getZoom() {
    try {
        const v = parseFloat(localStorage.getItem(ZOOM_KEY));
        if (Number.isFinite(v) && v >= 0.3 && v <= 2.0) return v;
    } catch {}
    return defaultZoom();
}
function saveZoom(v) { try { localStorage.setItem(ZOOM_KEY, String(v)); } catch {} }

let sheetsPromise = null;
let sheets = [];
let currentGid = null;
let currentFrame = null;      // { iframe, doc, win }

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

    const internalUrl   = getMeta('original-schedule-url');
    const externalUrl   = getMeta('original-schedule-external') || internalUrl;
    const spreadsheetId = extractSpreadsheetId(internalUrl);

    if (!btn || !modal || !renderEl || !wrapEl) {
        return { open: () => {}, focusOn: () => {}, close: () => {} };
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
        const iframe = currentFrame && currentFrame.iframe;
        if (!iframe || !wrapEl) return;

        const scale = getZoom();
        const w = wrapEl.clientWidth / scale;
        const h = wrapEl.clientHeight / scale;

        iframe.style.width  = w + 'px';
        iframe.style.height = h + 'px';
        iframe.style.transformOrigin = '0 0';
        iframe.style.transform = `scale(${scale})`;

        if (zoomBox) zoomBox.hidden = false;
    }

    function setupZoomControls() {
        if (!zoomBox) return;
        zoomBox.querySelectorAll('.original-zoom-btn').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const dir = b.dataset.zoom;
                const cur = getZoom();
                const z = dir === 'in'
                    ? Math.min(2.0, +(cur + 0.1).toFixed(2))
                    : Math.max(0.3, +(cur - 0.1).toFixed(2));
                if (z === cur) return;
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

    async function showSheet(gid, { focusPosition, focusText } = {}) {
        if (!spreadsheetId || !gid) return;
        currentGid = gid;
        try { localStorage.setItem(LAST_GID_KEY, gid); } catch {}
        setActiveTab(gid);

        if (dialog) dialog.classList.remove('is-loaded');

        try {
            const html = await fetchSheetHtml(spreadsheetId, gid);
            if (currentGid !== gid) return;   // гонка: успели переключиться

            const mounted = await mountSheetFrame(renderEl, html);
            currentFrame = mounted;

            applyZoom();
            if (dialog) dialog.classList.add('is-loaded');

            if (focusPosition || focusText) {
                // Даём Google CSS доехать, чтобы координаты устоялись
                setTimeout(() => {
                    const td = findCellInFrame(mounted.doc, focusPosition, focusText);
                    if (td) focusCellInFrame(mounted.iframe, td);
                }, 60);
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
        if (!spreadsheetId) return Promise.resolve([]);

        sheetsPromise = fetchSheetList(spreadsheetId)
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

        let gid = currentGid;
        if (!gid) {
            try { gid = localStorage.getItem(LAST_GID_KEY); } catch {}
        }
        if (!gid) gid = '0';

        ensureSheets().then(() => setActiveTab(currentGid || gid));
        showSheet(gid);
    }

    function close() {
        modal.classList.remove('open');
        document.body.classList.remove('modal-open');
    }

    /* ---------- фокус на событии из поповера ---------- */

    async function focusOn(ev) {
        if (!ev) return;
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

        const gid = findGidByGroup(ev.group) || currentGid || '0';

        await showSheet(gid, {
            focusPosition: ev.position || null,
            focusText:     ev.discipline || null,
        });
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