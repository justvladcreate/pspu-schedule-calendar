'use strict';

/**
 * Модалка «Оригинал» — просмотр исходной Google Таблицы.
 *
 *   • iframe остаётся как есть (preview-эндпоинт);
 *   • список листов автоматически тянется из htmlview и кэшируется;
 *   • над iframe строится горизонтальная панель вкладок;
 *   • смена листа = подмена gid в src;
 *   • оффлайн — заглушка с кнопкой «Открыть в новой вкладке»;
 *   • последний открытый лист запоминается в localStorage.
 */

const SHEETS_CACHE_KEY = 'pspu-original-sheets';
const SHEETS_CACHE_TTL = 24 * 60 * 60 * 1000; // сутки
const LAST_GID_KEY     = 'pspu-original-last-gid';
const ZOOM_KEY         = 'pspu-original-zoom';

/** Дефолтный масштаб: 0.5 = «отдалено в 2 раза». 1.0 = обычный размер. */
function defaultZoom() {
    return window.innerWidth <= 900 ? 0.45 : 1.0;
}
function getZoom() {
    try {
        const v = parseFloat(localStorage.getItem(ZOOM_KEY));
        if (Number.isFinite(v) && v >= 0.2 && v <= 1.5) return v;
    } catch {}
    return defaultZoom();
}
function saveZoom(v) {
    try { localStorage.setItem(ZOOM_KEY, String(v)); } catch {}
}

const URL_META_SELECTOR      = 'meta[name="original-schedule-url"]';
const EXTERNAL_META_SELECTOR = 'meta[name="original-schedule-external"]';

let sheetsPromise = null;   // единый промис загрузки списка листов
let sheets = [];            // [{ name, gid }, ...]
let currentGid = null;      // активный лист

/* ============================================================ */

function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : '';
}

function isOnline() {
    return navigator.onLine !== false;
}

function extractSpreadsheetId(url) {
    const m = String(url || '').match(/\/d\/([^/]+)/);
    return m ? m[1] : '';
}

/**
 * URL отдельного листа для iframe.
 * Оставляем preview-эндпоинт (как было), но добавляем gid.
 * Если вдруг переключение не сработает — замените на:
 *   .../htmlview/sheet?headers=true&gid=${gid}
 */
function buildSheetUrl(spreadsheetId, gid) {
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
         + `/htmlview/sheet?headers=true&gid=${gid}`;
}

/**
 * Тянет список листов из htmlview. Внутри HTML есть блок:
 *   items.push({name: "1211", pageUrl: "...", gid: "365716770", ...});
 */
async function fetchSheetList(spreadsheetId) {
    // 1) Кэш
    try {
        const raw = localStorage.getItem(SHEETS_CACHE_KEY);
        if (raw) {
            const { at, id, list } = JSON.parse(raw);
            if (id === spreadsheetId &&
                Array.isArray(list) && list.length &&
                Date.now() - at < SHEETS_CACHE_TTL) {
                return list;
            }
        }
    } catch {}

    // 2) Сеть
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview`;
    const html = await (await fetch(url)).text();

    const re = /items\.push\(\{name:\s*"([^"]+)"[^}]*?gid:\s*"(\d+)"/g;
    const list = [];
    const seen = new Set();
    for (const m of html.matchAll(re)) {
        const name = m[1];
        const gid  = m[2];
        if (seen.has(gid)) continue;
        seen.add(gid);
        list.push({ name, gid });
    }

    if (list.length) {
        try {
            localStorage.setItem(SHEETS_CACHE_KEY,
                JSON.stringify({ at: Date.now(), id: spreadsheetId, list }));
        } catch {}
    }
    return list;
}

/* ============================================================ */

export function setupOriginalModal() {
    const btn      = document.getElementById('originalBtn');
    const modal    = document.getElementById('originalModal');
    const dialog   = modal && modal.querySelector('.original-modal');
    const closeBtn = modal && modal.querySelector('.original-close');
    const frame    = document.getElementById('originalFrame');
    const offline  = document.getElementById('originalOffline');
    const external = document.getElementById('originalExternal');
    const tabsBox  = document.getElementById('originalSheetTabs');
    const zoomBox  = document.getElementById('originalZoomControls');

    const internalUrl   = getMeta('original-schedule-url');
    const externalUrl   = getMeta('original-schedule-external') || internalUrl;
    const spreadsheetId = extractSpreadsheetId(internalUrl);

    if (!btn || !modal || !frame) return;

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
                    behavior: 'smooth',
                    block: 'nearest',
                    inline: 'center',
                });
            } catch {}
        }
    }

    function buildTabs() {
        if (!tabsBox) return;
        tabsBox.innerHTML = '';

        if (sheets.length === 0) {
            tabsBox.hidden = true;
            return;
        }
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

    /* ---------- кнопки зума (плавающие поверх iframe) ---------- */

    function setupZoomControls() {
        if (!zoomBox) return;

        zoomBox.querySelectorAll('.original-zoom-btn').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const dir = b.dataset.zoom;
                const cur = getZoom();
                let z;
                if (dir === 'in') {
                    z = Math.min(1.5, +(cur + 0.1).toFixed(2));
                } else {
                    z = Math.max(0.2, +(cur - 0.1).toFixed(2));
                }
                if (z === cur) return;
                saveZoom(z);
                applyZoom();
            });
        });
    }

    setupZoomControls();

    /* ---------- показ листа ---------- */

    function showSheet(gid) {
        if (!spreadsheetId || !gid) return;
        currentGid = gid;
        try { localStorage.setItem(LAST_GID_KEY, gid); } catch {}
        frame.src = buildSheetUrl(spreadsheetId, gid);
        setActiveTab(gid);
    }

    /* ---------- зум: iframe больше контейнера + scale вниз ---------- */

    function applyZoom() {
        const body = frame.parentElement;   // .original-body
        if (!body) return;

        const scale = getZoom();
        const w = body.clientWidth  / scale;
        const h = body.clientHeight / scale;

        Object.assign(frame.style, {
            position:        'absolute',
            top:             '0',
            left:            '0',
            right:           'auto',
            bottom:          'auto',
            width:           w + 'px',
            height:          h + 'px',
            transformOrigin: '0 0',
            transform:       `scale(${scale})`,
            border:          'none',
        });

        // Плавающие кнопки зума показываем только когда есть iframe
        if (zoomBox) zoomBox.hidden = !frame.src || frame.src === 'about:blank';
    }

    // Пересчёт при ресайзе/повороте экрана
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        if (!modal.classList.contains('open')) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(applyZoom, 120);
    });

    /* ---------- загрузка списка ---------- */

    function ensureSheets() {
        if (sheetsPromise) return sheetsPromise;
        if (!spreadsheetId) return Promise.resolve([]);

        sheetsPromise = fetchSheetList(spreadsheetId)
            .catch((e) => {
                console.warn('[original] не удалось получить список листов:', e);
                return [];
            })
            .then((list) => {
                sheets = list || [];
                buildTabs();
                return sheets;
            });
        return sheetsPromise;
    }

    /* ---------- открытие / закрытие ---------- */

    async function open() {
        modal.classList.add('open');
        document.body.classList.add('modal-open');

        // Оффлайн — заглушка
        if (!isOnline()) {
            if (offline) offline.hidden = false;
            frame.style.display = 'none';
            if (zoomBox) zoomBox.hidden = true;
            return;
        }
        if (offline) offline.hidden = true;
        frame.style.display = '';
        if (zoomBox) zoomBox.hidden = false;

        // Тянем список листов (один раз за сессию)
        await ensureSheets();

        // Что показываем: последний открытый → первый из списка → gid=0
        let gid = currentGid;
        if (!gid) {
            try { gid = localStorage.getItem(LAST_GID_KEY); } catch {}
        }
        if (!gid && sheets.length > 0) gid = sheets[0].gid;
        if (!gid) gid = '0';

        // Подменяем src только если реально меняется
        if (frame.dataset.gid !== gid) {
            frame.dataset.gid = gid;
            showSheet(gid);
        }

        // Применяем зум к контейнеру iframe
        applyZoom();

        dialog.classList.add('is-loaded');
    }

    function close() {
        modal.classList.remove('open');
        document.body.classList.remove('modal-open');
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        open();
    });
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', (e) => {
        // На мобилке модалка во весь экран — подложки не видно.
        if (e.target === modal && window.innerWidth > 900) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });
}