'use strict';

import { fetchSheetHtml } from './sheets.js';
import {
    createGoogleSource, createStaticSource, createCompositeSource, sheetTitle,
} from './original-source.js';
import {
    createSearch, createOption, createEmptyRow, matchesQuery,
} from './filter-core.js';
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

/* Типы листов для фильтра в полосе над таблицей. Порядок — как в
   расписании: очно, заочно, зачёты, ГИА. */
const KIND_FILTERS = [
    { id: 'oo',    label: 'Очно' },
    { id: 'zo',    label: 'Заочно' },
    { id: 'exams', label: 'Зачёты' },
    { id: 'gia',   label: 'ГИА' },
];

/** Тип листа для фильтра: смотрим, из какого файла он отрендерен. */
function sheetFilterKind(sheet) {
    const kind = String((sheet && sheet.kind) || '');
    const source = String((sheet && sheet.source) || '');
    if (source === 'gia') return 'gia';
    if (source === 'oo_exams') return 'exams';
    if (source === 'zo') return 'zo';
    if (kind === 'zo' || kind === 'zo_exams') return 'zo';
    if (kind === 'oo_exams' || kind === 'exams') return 'exams';
    return 'oo';
}

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

/** Имя листа соответствует группе: «1211» или «Z151   Z152» (две группы). */
function sheetMatchesGroup(name, group) {
    const n = String(name || '').trim();
    const g = String(group || '').trim();
    if (!n || !g) return false;
    if (n === g) return true;
    // На одном листе может быть несколько групп через пробел/запятую.
    const tokens = n.split(/[\s,/;]+/).filter(Boolean);
    if (tokens.includes(g)) return true;
    return n.startsWith(g);
}

function findGidByGroup(group, kind) {
    if (!group) return null;
    const g = String(group).trim();
    if (!g) return null;

    // Если у события известен тип (очное/заочное/экзамены), сначала
    // ищем лист того же типа: группа «152» есть и в очном файле,
    // и в сессии.
    const pool = kind ? sheets.filter(s => !s.kind || s.kind === kind) : sheets;

    const search = (list) => {
        for (const s of list) if (String(s.name).trim() === g) return s.gid;
        for (const s of list) {
            const tokens = String(s.name).trim().split(/[\s,/;]+/).filter(Boolean);
            if (tokens.includes(g)) return s.gid;
        }
        for (const s of list) if (String(s.name).trim().startsWith(g)) return s.gid;
        return null;
    };

    return search(pool) || (pool === sheets ? null : search(sheets));
}

/** Лист похож на группу, а не на оглавление («ГРУППЫ», «Титул»). */
function isGroupSheet(sheet) {
    const name = String((sheet && sheet.name) || '').trim();
    if (!name) return false;
    for (const group of state.groups || []) {
        if (sheetMatchesGroup(name, group)) return true;
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
    const sourceLink = document.getElementById('originalSourceLink');
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
    const kindsBox     = document.getElementById('originalKinds');
    const sheetBar     = document.getElementById('originalSheetBar');
    const groupPicker  = document.getElementById('originalGroupPicker');
    const groupPopover = document.getElementById('originalGroupPopover');
    const groupList    = document.getElementById('originalGroupList');

    const groupSearchHost = document.getElementById('originalGroupSearchHost');
    const groupSearchUi = groupSearchHost
        ? createSearch({
            placeholder: 'Поиск группы…',
            onInput: () => renderGroupPicker(),
        })
        : null;
    if (groupSearchUi && groupSearchHost) groupSearchHost.replaceWith(groupSearchUi.element);

    let source = null;          // текущий источник («google» или «static»)
    let spreadsheetId = defaultSpreadsheetId;
    let activeFacultyId = null;
    let activeKind = '';        // '' — все листы, иначе id из KIND_FILTERS
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

    /** Прямая ссылка на исходную таблицу факультета. */
    function sourceUrlFor(original) {
        if (!original) return '';
        if (original.type === 'google_sheets' && original.spreadsheet_id) {
            return `https://docs.google.com/spreadsheets/d/${original.spreadsheet_id}/edit?usp=sharing`;
        }
        return original.url || original.file || '';
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
        if (!toolbarEl) return;
        const noFaculties = !facultiesBox || facultiesBox.hidden;
        const noKinds = !kindsBox || kindsBox.hidden;
        toolbarEl.hidden = noFaculties && noKinds;
    }

    /** Листы с учётом выбранного типа (очно/заочно/зачёты/ГИА). */
    function visibleSheets() {
        if (!activeKind) return sheets;
        return sheets.filter(sheet => sheetFilterKind(sheet) === activeKind);
    }

    function sheetKindOf(gid) {
        const sheet = sheets.find(s => String(s.gid) === String(gid));
        return sheet ? sheetFilterKind(sheet) : '';
    }

    /** Включает тип листа, к которому относится gid, и перерисовывает полосы. */
    function focusKindOfGid(gid) {
        const kind = sheetKindOf(gid);
        if (!kind) return;
        if (activeKind === kind) return;
        activeKind = kind;
        renderKindBar();
        buildTabs();
        renderGroupPicker();
    }

    function renderKindBar() {
        if (!kindsBox) { updateToolbarVisibility(); return; }

        const counts = new Map();
        for (const sheet of sheets) {
            const kind = sheetFilterKind(sheet);
            counts.set(kind, (counts.get(kind) || 0) + 1);
        }

        const present = KIND_FILTERS.filter(item => counts.has(item.id));
        if (present.length < 2) {
            kindsBox.hidden = true;
            kindsBox.innerHTML = '';
            updateToolbarVisibility();
            return;
        }
        if (activeKind && !counts.has(activeKind)) activeKind = '';

        kindsBox.hidden = false;
        kindsBox.innerHTML = '';

        const addChip = (id, label, count) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'original-kind-chip';
            chip.classList.toggle('is-active', id === activeKind);
            chip.dataset.kind = id;
            chip.setAttribute('role', 'tab');
            chip.setAttribute('aria-selected', id === activeKind ? 'true' : 'false');
            chip.append(label);

            const badge = document.createElement('span');
            badge.className = 'original-kind-chip-count';
            badge.textContent = String(count);
            chip.append(badge);

            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                if (activeKind === id) return;
                activeKind = id;
                renderKindBar();
                buildTabs();
                renderGroupPicker();
                const list = visibleSheets();
                if (list.length && !list.some(s => String(s.gid) === String(currentGid))) {
                    showSheet(fallbackGid(list));
                }
            });
            kindsBox.appendChild(chip);
        };

        addChip('', 'Все', sheets.length);
        for (const item of present) {
            addChip(item.id, item.label, counts.get(item.id));
        }

        updateToolbarVisibility();
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

    function openGroupPicker() {
        if (!groupPicker || !groupPopover) return;
        if (groupSearchUi) groupSearchUi.setValue('');
        renderGroupPicker();
        groupPopover.hidden = false;
        groupPicker.setAttribute('aria-expanded', 'true');
        if (window.innerWidth > 700 && groupSearchUi) {
            setTimeout(() => groupSearchUi.input.focus(), 30);
        }
    }

    function closeGroupPicker() {
        if (!groupPopover || groupPopover.hidden) return;
        groupPopover.hidden = true;
        if (groupPicker) groupPicker.setAttribute('aria-expanded', 'false');
    }

    function renderGroupPicker() {
        if (!groupPicker || !groupList) { updateSheetBarVisibility(); return; }

        const list = visibleSheets();
        if (list.length < 2) {
            groupPicker.hidden = true;
            closeGroupPicker();
            groupList.innerHTML = '';
            updateSheetBarVisibility();
            return;
        }

        groupPicker.hidden = false;
        groupList.innerHTML = '';

        // В «Группе» показываем листы-группы, а не оглавление/титул.
        const groupSheets = list.filter(isGroupSheet);
        const options = (groupSheets.length ? groupSheets : list).slice();

        // Текущий лист может быть не группой (например, «ГРУППЫ»):
        // добавляем его, чтобы список не терял выбранное.
        if (currentGid && !options.some(s => String(s.gid) === String(currentGid))) {
            const current = list.find(s => String(s.gid) === String(currentGid));
            if (current) options.unshift(current);
        }

        const query = groupSearchUi ? groupSearchUi.input.value : '';
        const filtered = options.filter(sheet => matchesQuery(sheetTitle(sheet), query));

        if (!filtered.length) {
            groupList.appendChild(createEmptyRow('Не найдено'));
        } else {
            for (const sheet of filtered) {
                groupList.appendChild(createOption({
                    value: String(sheet.gid),
                    label: sheetTitle(sheet),
                    hint: sheet.name,
                    checked: String(sheet.gid) === String(currentGid),
                    onToggle: () => {
                        showSheet(sheet.gid);
                        closeGroupPicker();
                    },
                }));
            }
        }

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
        activeKind = '';
        buildTabs();
        renderKindBar();
        renderGroupPicker();

        // Предрендеренные листы важнее типа источника. Если у факультета
        // есть и Google-таблица, и дополнительные файлы (заочка, сессии),
        // показываем листы обоих.
        const folder = `data/${(meta && meta.folder) || `faculties/${id}`}`;

        if (original && original.spreadsheet_id && original.sheets) {
            spreadsheetId = original.spreadsheet_id;
            source = createCompositeSource(spreadsheetId, folder);
        } else if (original && original.sheets) {
            spreadsheetId = '';
            source = createStaticSource(folder);
        } else if (original && original.spreadsheet_id) {
            spreadsheetId = original.spreadsheet_id;
            source = createGoogleSource(spreadsheetId);
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

        if (sourceLink) {
            const url = sourceUrlFor(original);
            if (url) {
                sourceLink.href = url;
                sourceLink.textContent = original && original.type === 'google_sheets'
                    ? 'Google Таблицы'
                    : 'Открыть оригинал';
                sourceLink.hidden = false;
            } else {
                sourceLink.hidden = true;
            }
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

    if (groupPicker) {
        groupPicker.addEventListener('click', (e) => {
            e.stopPropagation();
            if (groupPopover && !groupPopover.hidden) closeGroupPicker();
            else openGroupPicker();
        });
    }

    if (groupPopover) {
        groupPopover.addEventListener('click', (e) => e.stopPropagation());
    }

    document.addEventListener('click', () => closeGroupPicker());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeGroupPicker();
    });

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
        if (groupPopover && !groupPopover.hidden) {
            renderGroupPicker();
        }
    }

    function buildTabs() {
        if (!tabsBox) return;
        tabsBox.innerHTML = '';
        const list = visibleSheets();
        if (list.length === 0) {
            tabsBox.hidden = true;
            updateSheetBarVisibility();
            return;
        }
        tabsBox.hidden = false;
        updateSheetBarVisibility();

        for (const sheet of list) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'original-sheet-tab';
            b.dataset.gid = sheet.gid;
            b.dataset.kind = sheet.kind || '';
            b.textContent = sheetTitle(sheet);
            b.title = sheetTitle(sheet);
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

        const sourceRef = source;
        sheetsPromise = source.list(fetchSheetList)
            .then((list) => {
                // Пока грузились листы, могли переключить факультет.
                if (source !== sourceRef) return sheets;
                sheets = list || [];
                buildTabs();
                renderKindBar();
                renderGroupPicker();
                return sheets;
            })
            .catch((e) => {
                console.warn('[original] не удалось получить список листов:', e);
                if (source === sourceRef) sheetsPromise = null;
                return [];
            });
        return sheetsPromise;
    }

    /**
     * Обновляет список листов Google-таблицы в фоне: в localStorage
     * он может лежать сутки, а новый лист-группа должен появиться
     * сразу. Предрендеренные листы не кэшируются — там sheets.json
     * берётся с no-store.
     */
    async function refreshSheetList() {
        if (!source || typeof source.refresh !== 'function') return;

        const sourceRef = source;
        const facultyRef = activeFacultyId;

        try {
            const fresh = await source.refresh(fetchSheetListFromNetwork);
            if (!fresh || !fresh.length) return;
            // Факультет успели переключить — чужой список не применяем.
            if (source !== sourceRef || activeFacultyId !== facultyRef) return;

            const same = fresh.length === sheets.length
                && fresh.every((item, i) => (
                    String(item.gid) === String(sheets[i].gid)
                    && item.name === sheets[i].name
                ));
            if (same) return;

            const keepGid = currentGid;
            sheets = fresh;
            renderKindBar();
            buildTabs();
            renderGroupPicker();

            if (keepGid && sheets.some(s => String(s.gid) === String(keepGid))) {
                focusKindOfGid(keepGid);
                setActiveTab(keepGid);
            } else if (sheets.length) {
                showSheet(fallbackGid(visibleSheets().length ? visibleSheets() : sheets));
            }
        } catch (e) {
            // нет сети — остаёмся на закэшированном списке
        }
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
        let fromGroup = false;
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
            fromGroup = true;
        }

        if (!gid) gid = currentGid;
        if (!gid) gid = lastGids[String(facultyId)] || '';
        if (!gid) gid = loadLegacyGid();
        if (!gid || !list.some(s => String(s.gid) === String(gid))) {
            gid = fallbackGid(list);
            fromGroup = false;
        }
        if (!gid) {
            showFallback('Таблица факультета недоступна на сайте.');
            return;
        }

        // Пришли по конкретной группе — сразу показываем её тип
        // (заочка, зачёты). Иначе оставляем все листы и полосу типов.
        if (fromGroup) focusKindOfGid(gid);
        setActiveTab(gid);
        showSheet(gid);
        refreshSheetList();
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

        const gid = findGidByGroup(ev.group, ev.kind)
            || lastGids[facultyId]
            || (sheets.length ? sheets[0].gid : '');

        if (!gid) return;
        focusKindOfGid(gid);
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