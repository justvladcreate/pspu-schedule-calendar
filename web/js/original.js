'use strict';

import { fetchSheetHtml } from './sheets.js';
import { createGoogleSource, createStaticSource } from './original-source.js';
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
const LAST_GIDS_KEY    = 'pspu-original-last-gids';
const ZOOM_KEY         = 'pspu-original-zoom';

/* Каждый факультет запоминает свой последний лист: переключение
   между факультетами не должно сбрасывать выбор. */
function loadLastGids() {
    try {
        const raw = localStorage.getItem(LAST_GIDS_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch {}
    return {};
}
function saveLastGids(map) {
    try { localStorage.setItem(LAST_GIDS_KEY, JSON.stringify(map)); } catch {}
}
function loadLegacyGid() {
    try { return localStorage.getItem(LAST_GID_KEY) || ''; } catch { return ''; }
}

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

/** Лист похож на группу, а не на оглавление («ГРУППЫ», «Титул»). */
function isGroupSheet(sheet) {
    const name = String((sheet && sheet.name) || '').trim();
    if (!name) return false;
    for (const group of state.groups || []) {
        const g = String(group).trim();
        if (!g) continue;
        if (name === g || name.startsWith(g)) return true;
    }
    return false;
}

/** Первый лист-группа, иначе — просто первый лист. */
function fallbackGid(list) {
    if (!list || list.length === 0) return '';
    const groupSheet = list.find(isGroupSheet);
    return (groupSheet || list[0]).gid;
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

    const toolbarEl    = document.getElementById('originalToolbar');
    const facultiesBox = document.getElementById('originalFaculties');
    const sheetBar     = document.getElementById('originalSheetBar');
    const groupPicker  = document.getElementById('originalGroupPicker');
    const groupSelect  = document.getElementById('originalGroupSelect');

    let source = null;          // текущий источник («google» или «static»)
    let spreadsheetId = defaultSpreadsheetId;
    let activeFacultyId = null;
    const lastGids = loadLastGids();

    function facultyMeta(id) {
        return (state.faculties || []).find(
            item => String(item.id) === String(id)
        ) || null;
    }

    function hasOriginal(meta) {
        const original = meta && meta.original;
        if (!original) return false;
        if (original.type === 'google_sheets' && original.spreadsheet_id) return true;
        return !!original.sheets;
    }

    function availableFaculties() {
        return (state.faculties || []).filter(hasOriginal);
    }

    function rememberGid(id, gid) {
        if (!id || !gid) return;
        lastGids[String(id)] = String(gid);
        saveLastGids(lastGids);
        // Совместимость со старой версией: один общий последний лист.
        try { localStorage.setItem(LAST_GID_KEY, String(gid)); } catch {}
    }

    function updateToolbarVisibility() {
        if (toolbarEl) toolbarEl.hidden = !facultiesBox || facultiesBox.hidden;
    }

    function updateSheetBarVisibility() {
        if (!sheetBar) return;
        const noTabs = !tabsBox || tabsBox.hidden;
        const noGroups = !groupPicker || groupPicker.hidden;
        sheetBar.hidden = noTabs && noGroups;
    }

    /**
     * Какой факультет открыть: единственная выбранная группа важнее
     * всего, затем — последний активный, затем первый выбранный.
     */
    function preferredFacultyId() {
        const list = availableFaculties();
        if (!list.length) return null;

        const selectedIds = [...(state.selectedFaculties || [])].map(String);
        const inSelection = selectedIds.length
            ? list.filter(f => selectedIds.includes(String(f.id)))
            : [];
        const candidates = inSelection.length ? inSelection : list;

        const chosenGroups = [...(state.selectedGroups || [])];
        if (chosenGroups.length === 1) {
            const ids = state.groupFaculties.get(chosenGroups[0]);
            if (ids) {
                for (const id of ids) {
                    if (list.some(f => String(f.id) === String(id))) {
                        return String(id);
                    }
                }
            }
        }

        if (activeFacultyId
            && candidates.some(f => String(f.id) === String(activeFacultyId))) {
            return String(activeFacultyId);
        }
        return String(candidates[0].id);
    }

    function renderFacultyBar() {
        const list = availableFaculties();
        if (!facultiesBox) { updateToolbarVisibility(); return; }

        facultiesBox.innerHTML = '';

        // Выбранные факультеты — первыми.
        const selectedIds = new Set([...(state.selectedFaculties || [])].map(String));
        const ordered = [...list].sort((a, b) => {
            const aSel = selectedIds.has(String(a.id)) ? 0 : 1;
            const bSel = selectedIds.has(String(b.id)) ? 0 : 1;
            if (aSel !== bSel) return aSel - bSel;
            return String(a.short || a.name || '')
                .localeCompare(String(b.short || b.name || ''), 'ru');
        });

        facultiesBox.hidden = ordered.length <= 1;

        if (!facultiesBox.hidden) {
            for (const faculty of ordered) {
                const id = String(faculty.id);
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'original-faculty-chip';
                chip.classList.toggle('is-active', id === activeFacultyId);
                chip.textContent = faculty.short || faculty.name || id;
                chip.title = faculty.name || id;
                chip.setAttribute('role', 'tab');
                chip.setAttribute(
                    'aria-selected',
                    id === activeFacultyId ? 'true' : 'false'
                );
                chip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (id === activeFacultyId) return;
                    selectFaculty(id);
                });
                facultiesBox.appendChild(chip);
            }
        }

        updateToolbarVisibility();
    }

    function renderGroupPicker() {
        if (!groupPicker || !groupSelect) { updateSheetBarVisibility(); return; }

        if (sheets.length < 2) {
            groupPicker.hidden = true;
            groupSelect.innerHTML = '';
            updateSheetBarVisibility();
            return;
        }

        groupPicker.hidden = false;
        groupSelect.innerHTML = '';

        // В «Группе» показываем листы-группы, а не оглавление/титул.
        const groupSheets = sheets.filter(isGroupSheet);
        const options = (groupSheets.length ? groupSheets : sheets).slice();

        // Текущий лист может быть не группой (например, «ГРУППЫ»):
        // добавляем его, чтобы select не показывал чужое значение.
        if (currentGid && !options.some(s => String(s.gid) === String(currentGid))) {
            const current = sheets.find(s => String(s.gid) === String(currentGid));
            if (current) options.unshift(current);
        }

        for (const sheet of options) {
            const option = document.createElement('option');
            option.value = sheet.gid;
            option.textContent = sheet.name;
            groupSelect.appendChild(option);
        }
        if (currentGid) groupSelect.value = currentGid;

        updateSheetBarVisibility();
    }

    function activateFaculty(facultyId, { force = false } = {}) {
        const id = String(facultyId || '12');
        const meta = facultyMeta(id);
        const original = (meta && meta.original) || null;

        if (!force && id === activeFacultyId && source) {
            renderFacultyBar();
            return;
        }

        activeFacultyId = id;
        sheetsPromise = null;
        sheets = [];
        currentGid = null;
        buildTabs();
        renderGroupPicker();

        if (original && original.type === 'google_sheets' && original.spreadsheet_id) {
            spreadsheetId = original.spreadsheet_id;
            source = createGoogleSource(spreadsheetId);
        } else if (original && original.type === 'cloud_mail' && original.sheets) {
            spreadsheetId = '';
            const folder = (meta && meta.folder) || `faculties/${id}`;
            source = createStaticSource(`data/${folder}`);
        } else if (original && original.type === 'cloud_mail') {
            // Старые опубликованные данные без предрендеренных листов.
            spreadsheetId = '';
            source = null;
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

        renderFacultyBar();
    }

    async function selectFaculty(facultyId, { group = null } = {}) {
        if (!facultyId) return;

        activateFaculty(facultyId, { force: true });

        const list = await ensureSheets();
        renderGroupPicker();

        let gid = group ? findGidByGroup(group) : null;

        if (!gid) {
            // Группа из основного фильтра важнее запомненного листа.
            for (const selected of state.selectedGroups || []) {
                const found = findGidByGroup(selected);
                if (found) { gid = found; break; }
            }
        }

        if (!gid) gid = lastGids[String(facultyId)] || '';
        if (!gid || !list.some(s => String(s.gid) === String(gid))) {
            gid = fallbackGid(list);
        }

        if (!gid) {
            showFallback('Таблица факультета недоступна на сайте.');
            return;
        }

        showSheet(gid);
    }

    if (groupSelect) {
        groupSelect.addEventListener('change', () => {
            if (groupSelect.value) showSheet(groupSelect.value);
        });
        groupSelect.addEventListener('click', (e) => e.stopPropagation());
    }

    if (external) external.setAttribute('href', externalUrl);

    /* ---------- вкладки ---------- */

    function setActiveTab(gid) {
        if (tabsBox) {
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
        if (groupSelect) {
            const value = String(gid);
            const exists = [...groupSelect.options]
                .some(option => String(option.value) === value);
            if (!exists && currentGid) renderGroupPicker();
            groupSelect.value = value;
        }
    }

    function buildTabs() {
        if (!tabsBox) return;
        tabsBox.innerHTML = '';
        if (sheets.length === 0) {
            tabsBox.hidden = true;
            updateSheetBarVisibility();
            return;
        }
        tabsBox.hidden = false;
        updateSheetBarVisibility();

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

    function showFallback(reason) {
        const original = (facultyMeta(activeFacultyId) || {}).original || null;
        const link = original && original.url
            ? `<a href="${original.url}" target="_blank" rel="noopener">Открыть оригинал в новой вкладке</a>`
            : '';
        renderEl.innerHTML =
            '<div style="padding:20px;color:#444;font:14px/1.5 Arial,sans-serif">'
          + `<p>${reason || 'Не удалось загрузить таблицу.'}</p>`
          + (link ? `<p>${link}</p>` : '')
          + '</div>';
        if (dialog) dialog.classList.add('is-loaded');
    }

    async function showSheet(gid, { focusEvent } = {}) {
        if (!source || !gid) return;
        currentGid = gid;
        rememberGid(activeFacultyId, gid);
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
            showFallback('Не удалось загрузить лист с сайта.');
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
                renderGroupPicker();
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
        const facultyId = preferredFacultyId()
            || String((state.faculties && state.faculties[0] && state.faculties[0].id) || '12');
        activateFaculty(facultyId);
        renderFacultyBar();

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

        let gid = '';
        const selectedGids = [];
        for (const group of state.selectedGroups || []) {
            const found = findGidByGroup(group);
            if (found) selectedGids.push(found);
        }

        if (selectedGids.length > 0) {
            // Если последний открытый лист входит в выбранные группы —
            // оставляем его, иначе прыгаем на первую выбранную группу.
            gid = selectedGids.includes(currentGid)
                ? currentGid
                : selectedGids[0];
        }

        if (!gid) gid = currentGid;
        if (!gid) gid = lastGids[String(facultyId)] || '';
        if (!gid) gid = loadLegacyGid();
        if (!gid || !list.some(s => String(s.gid) === String(gid))) {
            gid = fallbackGid(list);
        }
        if (!gid) {
            showFallback('Таблица факультета недоступна на сайте.');
            return;
        }

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

        const facultyId = String(ev.faculty_id || preferredFacultyId() || '12');
        activateFaculty(facultyId, { force: activeFacultyId !== facultyId });
        renderFacultyBar();

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
            || lastGids[facultyId]
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