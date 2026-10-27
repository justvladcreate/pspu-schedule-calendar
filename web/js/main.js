'use strict';

import {
  state, saveSetToStorage,
  loadDayColWidth, loadSnapshot, saveSnapshot,
  saveScrollMemory, saveGeneratedAt, loadGeneratedAt,
  saveCurrentDate, savePendingChanges, savePendingChangesMeta,
  applyUrlContext, resolveUrlContext, disarmUrlContext,
} from './state.js';
import { escapeHtml, toISO } from './utils.js';
import {
    loadData, loadFacultyIndex, loadFacultyData,
} from './data.js';

import { render, updateDateLabel } from './render.js';
import {
    applyFilters, setupUnifiedFilter, updateTriggerLabel,
    updateCounter, setupFavoritesButton,
} from './filters.js';
import {
    navigate, goToToday, cycleView, toggleTheme,
    updateViewButton, initTheme,
    switchToCalendar, switchToLoad,
} from './navigation.js';
import { setupUpdatedButton, updateUpdatedLabel } from './version.js';
import {
    setupOnlineStatus,
    updateOnlineStatus,
} from './online.js';
import { compareEvents, compareRawEvents, sortChanges } from './changes.js';
import { setupChangesModal } from './changes-modal.js';
import { setupUpdateBanner, getVisibleChanges } from './update-banner.js';
import { setupReadmeModal } from './readme.js';
import { showToast } from './toast.js';
import {
    openShareMenu, buildTextForView,
    setupShareModal, openShareModal
} from './share.js';
import { setupExportModal } from './export.js';
import { setupCalendarGestures, setupPullToRefresh } from './gestures.js';
import { setupSettingsModal } from './settings.js';
import { setupOriginalModal } from './original.js';
import { setupModalHistory } from './modal-history.js';
import { openDatePicker, closeDatePicker, renderPicker, pickerState } from './datepicker.js';
import {
    hideEventDetails, showEventDetails,
    setupPopoverViewHandler,
} from './popover.js';

let changesModalApi = null;
let updateBannerApi = null;
let originalApi = null;

function stripReloadMarker() {
    const search = location.search;
    if (!search || !search.includes('_r=')) return;
    try {
        const url = new URL(location.href);
        url.searchParams.delete('_r');
        const next = url.pathname + (url.search ? url.search : '') + url.hash;
        history.replaceState(null, '', next);
    } catch (_) {}
}

/* ============================================================
 *  Загрузка данных
 * ============================================================ */

const SUPPORTED_SCHEMA_VERSION = 2;
const INDEX_CACHE_KEY = 'schedule-faculty-index';

function _isSupportedSchemaVersion(data) {
    const version = data.schema_version;
    if (version === undefined) return true;
    if (version === 1 || version === SUPPORTED_SCHEMA_VERSION) return true;
    console.warn(`[load] неподдерживаемая schema_version: ${version}`);
    return false;
}

function _loadCachedIndex() {
    try {
        const raw = localStorage.getItem(INDEX_CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function _saveCachedIndex(index) {
    try {
        if (index) localStorage.setItem(INDEX_CACHE_KEY, JSON.stringify(index));
    } catch {}
}

function _facultyMetaFromEvents(events) {
    const map = new Map();
    for (const ev of events || []) {
        const id = String(ev.faculty_id || '12');
        if (!map.has(id)) {
            map.set(id, {
                id,
                name: ev.faculty_name || (id === '12' ? 'ИНЭК' : `Факультет ${id}`),
                short: ev.faculty_name || (id === '12' ? 'ИНЭК' : id),
                file: `data/faculties/${id}.json`,
                groups: [],
            });
        }
    }
    return [...map.values()];
}

function isValidScheduleData(data) {
    return !!data
        && typeof data === 'object'
        && Array.isArray(data.events)
        && _isSupportedSchemaVersion(data);
}

function loadCachedData() {
    const events = loadSnapshot();
    if (!Array.isArray(events) || events.length === 0) return null;

    const index = _loadCachedIndex();
    return {
        events,
        generated_at: loadGeneratedAt() || null,
        faculties: index?.faculties || _facultyMetaFromEvents(events),
    };
}

async function loadFreshData({ onProgress = null } = {}) {
    const online = navigator.onLine !== false;

    let currentSource = 'main';
    const safeProgress = typeof onProgress === 'function'
        ? (pct) => {
            if (currentSource === 'fallback' && pct < 50) {
                onProgress(pct, { fallback: true });
            } else {
                onProgress(pct, { fallback: currentSource === 'fallback' });
            }
        }
        : null;

    // Новый формат: index.json + data/faculties/<id>.json
    try {
        const index = await loadFacultyIndex();
        if (index && Array.isArray(index.faculties) && index.faculties.length) {
            _saveCachedIndex(index);
            safeProgress?.(15);

            const payloads = await Promise.all(
                index.faculties.map(async (faculty) => {
                    try {
                        const payload = await loadFacultyData(faculty.id);
                        return { faculty, payload };
                    } catch (e) {
                        console.warn(`[load] факультет ${faculty.id} недоступен:`, e.message || e);
                        return null;
                    }
                }),
            );

            const events = [];
            for (const item of payloads) {
                if (!item || !Array.isArray(item.payload?.events)) continue;
                events.push(...item.payload.events);
            }
            if (events.length > 0) {
                safeProgress?.(95);
                return {
                    data: {
                        schema_version: 2,
                        generated_at: index.generated_at,
                        faculties: index.faculties,
                        events,
                    },
                    usedFallback: false,
                };
            }
        }
    } catch (e) {
        console.warn('[load] index.json недоступен:', e.message || e);
    }

    // Совместимость со старым монолитным data.json.
    try {
        const data = await loadData('data.json', { onProgress: safeProgress });
        if (isValidScheduleData(data)) {
            if (!Array.isArray(data.faculties)) {
                data.faculties = _facultyMetaFromEvents(data.events);
            }
            return { data, usedFallback: false };
        }
        console.warn('[load] data.json невалиден');
    } catch (e) {
        console.warn('[load] data.json недоступен:', e.message || e);
    }

    currentSource = 'fallback';

    try {
        const data = await loadData('old_data.json', { onProgress: safeProgress });
        if (isValidScheduleData(data)) {
            if (!Array.isArray(data.faculties)) {
                data.faculties = _facultyMetaFromEvents(data.events);
            }
            return { data, usedFallback: online };
        }
        console.warn('[load] old_data.json невалиден');
    } catch (e) {
        console.warn('[load] old_data.json недоступен:', e.message || e);
    }

    return null;
}

function applyDataToState(data, usedFallback) {
    state.currentData = data;
    state.displayedIso = data.generated_at || state.displayedIso;
    state.allEvents = data.events || [];
    state.faculties = Array.isArray(data.faculties) && data.faculties.length
        ? data.faculties
        : _facultyMetaFromEvents(data.events || []);
    state.fallbackActive = !!usedFallback;

    updateUpdatedLabel(state.displayedIso);
    updateOnlineStatus();
}

function rebuildGroups() {
    const groups = new Set();
    const teachers = new Set();
    const groupFaculties = new Map();
    const facultyMap = new Map(
        (state.faculties || []).map(item => [String(item.id), item]),
    );

    for (const ev of state.allEvents) {
        const facultyId = String(ev.faculty_id || '12');
        if (!facultyMap.has(facultyId)) {
            facultyMap.set(facultyId, {
                id: facultyId,
                name: ev.faculty_name || (facultyId === '12' ? 'ИНЭК' : `Факультет ${facultyId}`),
                short: ev.faculty_name || (facultyId === '12' ? 'ИНЭК' : facultyId),
                file: `data/faculties/${facultyId}.json`,
                groups: [],
            });
        }
        if (ev.group) {
            groups.add(ev.group);
            if (!groupFaculties.has(ev.group)) groupFaculties.set(ev.group, new Set());
            groupFaculties.get(ev.group).add(facultyId);
        }
        (ev.teachers || []).forEach(t => teachers.add(t));
    }

    state.faculties = [...facultyMap.values()].sort((a, b) =>
        String(a.name).localeCompare(String(b.name), 'ru')
    );
    state.groups = [...groups].sort();
    state.teachers = [...teachers].sort();
    state.groupFaculties = groupFaculties;

    const knownFaculties = new Set(state.faculties.map(item => String(item.id)));
    for (const id of [...state.selectedFaculties]) {
        if (!knownFaculties.has(String(id))) state.selectedFaculties.delete(id);
    }
    for (const g of [...state.selectedGroups]) {
        if (!state.groups.includes(g)) state.selectedGroups.delete(g);
    }
    for (const t of [...state.selectedTeachers]) {
        if (!state.teachers.includes(t)) state.selectedTeachers.delete(t);
    }
    saveSetToStorage('schedule-selected-faculties', state.selectedFaculties);
    saveSetToStorage('schedule-selected-groups', state.selectedGroups);
    saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);
}

let syncBannerTimer = null;
let syncBannerMode  = null;
let pendingSyncMode = null;

function isUpdateBannerOpen() {
    const el = document.getElementById('updateBanner');
    return !!el && el.classList.contains('open');
}

function showSyncBanner(mode) {
    const el = document.getElementById('syncBanner');
    if (!el) return;

    if (syncBannerTimer) {
        clearTimeout(syncBannerTimer);
        syncBannerTimer = null;
    }

    if (isUpdateBannerOpen()) {
        pendingSyncMode = mode;
        return;
    }

    if (syncBannerMode === mode && el.classList.contains('is-visible')) return;

    const apply = () => {
        syncBannerTimer = null;

        el.classList.toggle('is-loading', mode === 'loading');
        el.classList.toggle('is-error',   mode === 'error');

        const text   = document.getElementById('syncBannerText');
        const action = document.getElementById('syncBannerAction');

        if (text)   text.textContent = (mode === 'error') ? 'Ошибка обновления' : 'Обновление…';
        if (action) action.hidden    = (mode !== 'error');

        syncBannerMode = mode;
        el.classList.add('is-visible');
    };

    if (mode === 'loading' && syncBannerMode !== 'error') {
        syncBannerTimer = setTimeout(apply, 400);
    } else {
        apply();
    }
}

function hideSyncBanner() {
    const el = document.getElementById('syncBanner');
    if (!el) return;

    if (syncBannerTimer) {
        clearTimeout(syncBannerTimer);
        syncBannerTimer = null;
    }
    syncBannerMode = null;
    pendingSyncMode = null;
    el.classList.remove('is-visible', 'is-loading', 'is-error');
}

function flushPendingSyncBanner() {
    if (pendingSyncMode === null) return;
    const mode = pendingSyncMode;
    pendingSyncMode = null;
    setTimeout(() => showSyncBanner(mode), 120);
}

let topProgressEl       = null;
let topProgressInterval = null;
let topProgressHideTimer = null;
let topProgressValue    = 0;

function _topProgressEl() {
    if (!topProgressEl) {
        topProgressEl = document.getElementById('topProgress');
    }
    return topProgressEl;
}

function topProgressStart() {
    const el = _topProgressEl();
    if (!el) return;

    if (topProgressInterval) {
        clearInterval(topProgressInterval);
        topProgressInterval = null;
    }
    if (topProgressHideTimer) {
        clearTimeout(topProgressHideTimer);
        topProgressHideTimer = null;
    }

    el.hidden = false;
    el.style.transition = 'none';
    el.style.transform  = 'scaleX(0)';
    el.style.opacity    = '1';
    topProgressValue    = 0;

    void el.offsetWidth;

    el.style.transition = 'transform 0.25s ease-out';
    topProgressValue     = 0.1;
    el.style.transform   = 'scaleX(0.1)';

    topProgressInterval = setInterval(() => {
        if (topProgressValue >= 0.85) return;
        topProgressValue += (0.85 - topProgressValue) * 0.08;
        el.style.transform = `scaleX(${topProgressValue.toFixed(4)})`;
    }, 180);
}

function topProgressDone() {
    const el = _topProgressEl();
    if (!el) return;

    if (topProgressInterval) {
        clearInterval(topProgressInterval);
        topProgressInterval = null;
    }
    if (topProgressHideTimer) {
        clearTimeout(topProgressHideTimer);
        topProgressHideTimer = null;
    }

    void el.offsetWidth;

    el.style.transition =
        'transform 0.25s ease-out, opacity 0.3s ease-out 0.2s';
    el.style.transform = 'scaleX(1)';
    el.style.opacity   = '0';

    topProgressHideTimer = setTimeout(() => {
        el.hidden = true;
        el.style.transition = 'none';
        el.style.transform  = 'scaleX(0)';
        el.style.opacity    = '1';
        topProgressHideTimer = null;
    }, 600);
}

function showLoadingState() {
    const cal = document.getElementById('calendar');

    const conn = navigator.connection
              || navigator.mozConnection
              || navigator.webkitConnection;
    const slow = conn && ['slow-2g', '2g'].includes(conn.effectiveType);

    cal.innerHTML = `
        <div class="empty-state empty-state--loading">
            <div class="empty-state-spinner" aria-hidden="true"></div>
            <p class="empty-state-title">Загрузка расписания…</p>
            <p class="empty-state-hint">
                ${slow
                    ? 'Медленное соединение — это может занять до минуты'
                    : 'Это может занять несколько секунд'}
            </p>
        </div>
    `;
}

function showNoDataState() {
    const cal = document.getElementById('calendar');
    cal.innerHTML = `
        <div class="empty-state empty-state--no-data">
            <p class="empty-state-title">Нет данных о расписании</p>
            <p class="empty-state-hint">
                Попробуйте обновить страницу позже.
            </p>
        </div>
    `;
}

function showFatalError(message) {
    document.getElementById('calendar').innerHTML =
        `<div class="empty-state">Не удалось загрузить расписание: ${escapeHtml(message)}</div>`;
}

function resetToToday() {
    state.currentDate = new Date();
    saveCurrentDate(state.currentDate);
    state.view = 'week';
    state.navStep = 'week';
    if (!state.urlContext) {
        localStorage.setItem('schedule-view', 'week');
    }
    updateViewButton();
    state.scrollToNow = true;
}

function setupScrollPersistence() {
    const cal = document.getElementById('calendar');
    let lastScrollSave = 0;

    cal.addEventListener('scroll', () => {
        if (state.restoringScroll) return;
        const view = state.view;
        if (view !== 'week' && view !== 'day') return;

        const now = performance.now();
        if (now - lastScrollSave < 150) return;
        lastScrollSave = now;

        saveScrollMemory(view, {
            top: cal.scrollTop,
            left: cal.scrollLeft,
        });
    }, { passive: true });
}

function setupAllUI() {
    const exportModal = setupExportModal();
    const settingsModal = setupSettingsModal(exportModal);

    document.getElementById('settingsBtn').addEventListener('click', settingsModal.open);

    document.getElementById('prevBtn').addEventListener('click', () => navigate(-1));
    document.getElementById('nextBtn').addEventListener('click', () => navigate(1));
    document.getElementById('todayBtn').addEventListener('click', goToToday);
    document.getElementById('viewBtn').addEventListener('click', cycleView);
    document.getElementById('calendarModeBtn').addEventListener('click', switchToCalendar);
    document.getElementById('loadBtn').addEventListener('click', switchToLoad);
    document.getElementById('dateLabel').addEventListener('click', openDatePicker);

    document.getElementById('pickerPrev').addEventListener('click', () => {
        pickerState.month--;
        if (pickerState.month < 0) { pickerState.month = 11; pickerState.year--; }
        renderPicker();
    });
    document.getElementById('pickerNext').addEventListener('click', () => {
        pickerState.month++;
        if (pickerState.month > 11) { pickerState.month = 0; pickerState.year++; }
        renderPicker();
    });
    document.getElementById('dateModal').addEventListener('click', e => {
        if (e.target.id === 'dateModal') closeDatePicker();
    });

    document.addEventListener('click', (e) => {
        // Закрываем поповер только если клик был ВНЕ его
        if (!e.target.closest('#eventPopover')) {
            hideEventDetails();
        }

        if (window.innerWidth > 900) {
            const filterRoot = document.getElementById('filterRoot');
            if (filterRoot && filterRoot.classList.contains('open') && !filterRoot.contains(e.target)) {
                filterRoot.classList.remove('open');
                if (history.state && history.state.filterOpen) history.back();
            }
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            hideEventDetails();
            closeDatePicker();
        }
    });

    setupPullToRefresh();
    setupCalendarGestures();

    setupScrollPersistence();

    setupReadmeModal();
    originalApi = setupOriginalModal();
    setupModalHistory();
    setupShareModal(); // Инициализация модалки шаринга

    setupPopoverViewHandler((ev) => {
        hideEventDetails();
        if (originalApi) originalApi.focusOn(ev);
    });

    changesModalApi = setupChangesModal();
    updateBannerApi = setupUpdateBanner({
        onOpen: () => changesModalApi.open(getVisibleChanges()),
    });

    // Клик по push-уведомлению в уже открытом окне.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'OPEN_CHANGES') {
                openChangesFromNotification(event.data.version || null);
            }
        });
    }

    setupUpdatedButton({
        onOpen: () => changesModalApi.open(getVisibleChanges()),
    });

    setupUnifiedFilter();
    setupFavoritesButton();

    const updateBannerClose = document.getElementById('updateBannerClose');
    if (updateBannerClose) {
        updateBannerClose.addEventListener('click', () => {
            setTimeout(flushPendingSyncBanner, 60);
        });
    }
    const updateBannerEl = document.getElementById('updateBanner');
    if (updateBannerEl) {
        updateBannerEl.addEventListener('click', (e) => {
            if (e.target.closest('#updateBannerClose')) return;
            setTimeout(flushPendingSyncBanner, 60);
        });
    }
    setupShareButton();
    setupUrlContextBanner();

    document.addEventListener('click', () => {
        disarmUrlContext();
    }, true);

    const syncAction = document.getElementById('syncBannerAction');
    if (syncAction) {
        syncAction.addEventListener('click', (e) => {
            e.stopPropagation();
            fetchAndApply({ showIndicator: true });
        });
    }

    const syncClose = document.getElementById('syncBannerClose');
    if (syncClose) {
        syncClose.addEventListener('click', (e) => {
            e.stopPropagation();
            hideSyncBanner();
        });
    }

    setInterval(updateOnlineStatus, 60 * 1000);

    setupPeriodicUpdates();
}

function finalizeWithData() {
    const currentEvents = (state.currentData && state.currentData.events) || [];

    if (!state.fallbackActive) {
        const oldSnapshot = loadSnapshot();
        const oldVersion = loadGeneratedAt();
        if (oldSnapshot && !state.urlContext) {
            const changes = compareEvents(oldSnapshot, currentEvents);
            if (changes.length > 0) {
                state.pendingChanges = sortChanges(changes);
                state.pendingChangesMeta = {
                    oldVersion,
                    newVersion: state.displayedIso || null,
                };
                savePendingChanges(state.pendingChanges);
                savePendingChangesMeta(state.pendingChangesMeta);
            }
        }
        saveSnapshot(currentEvents);
        if (state.displayedIso) saveGeneratedAt(state.displayedIso);
    }

    const savedColWidth = loadDayColWidth();
    if (savedColWidth) {
        document.documentElement.style.setProperty('--m-day-col', savedColWidth + 'px');
    }

    applyFilters();
    updateTriggerLabel();
    updateCounter();

    if (!state.fallbackActive && updateBannerApi) {
        updateBannerApi.refresh();
    }

    render();

    setupUrlContextBanner();
    openUrlContextEvent();
    maybeOpenChangesFromPush();
}

/* ============================================================
 *  ПЕРЕХОД ИЗ PUSH-УВЕДОМЛЕНИЯ В «ИЗМЕНЕНИЯ»
 * ============================================================ */

async function openChangesFromNotification(version = null) {
    if (!changesModalApi) return;

    // Обычно pendingChanges уже посчитаны при загрузке данных.
    // Если пользователь уже видел эту версию (снимок обновлён), но
    // пришёл по уведомлению — строим diff по old_data.json.
    if ((state.pendingChanges || []).length === 0) {
        try {
            const oldData = await loadData('old_data.json');
            const current = state.currentData;

            if (
                oldData &&
                Array.isArray(oldData.events) &&
                current &&
                Array.isArray(current.events)
            ) {
                const changes = compareRawEvents(oldData.events, current.events);
                if (changes.length > 0) {
                    state.pendingChanges = sortChanges(changes);
                    state.pendingChangesMeta = {
                        oldVersion: oldData.generated_at || null,
                        newVersion: current.generated_at || null,
                    };
                }
            }
        } catch (e) {
            console.warn('[push] не удалось загрузить old_data.json:', e);
        }
    }

    // Не применяем текущие фильтры: уведомление могло прийти по группе,
    // которую пользователь сейчас не смотрит, но показать изменение нужно.
    changesModalApi.open(state.pendingChanges || []);
}

function maybeOpenChangesFromPush() {
    let params;
    try {
        params = new URLSearchParams(location.search);
    } catch {
        return;
    }

    if (params.get('open') !== 'changes') return;

    const version = params.get('cv');

    // Убираем служебные параметры, чтобы обновление страницы
    // не открывало модалку повторно.
    try {
        params.delete('open');
        params.delete('cv');
        const query = params.toString();
        history.replaceState(
            null,
            '',
            location.pathname + (query ? '?' + query : '') + location.hash,
        );
    } catch {}

    openChangesFromNotification(version);
}

async function init() {
    stripReloadMarker();
    initTheme();

    state.displayedIso = loadGeneratedAt();
    applyUrlContext();
    updateViewButton();
    setupOnlineStatus();

    setupAllUI();

    const cached = loadCachedData();

    if (cached) {
        const wasFirstVisit = !state.displayedIso;

        applyDataToState(cached, false);
        rebuildGroups();

        const urlResult = resolveUrlContext();
        if (urlResult === 'none') {
            state.urlContext = false;
            updateViewButton();
            setTimeout(() => showToast('Ссылка недействительна или устарела'), 300);
        }

        if (!state.urlContext && wasFirstVisit) {
            resetToToday();
        }

        finalizeWithData();

        if (navigator.onLine !== false) {
            fetchAndApply({ showIndicator: true }).then(result => {
                if (!result.ok) {
                    state.fallbackActive = true;
                    updateOnlineStatus();
                }
            });
        }
    } else {
        showLoadingState();
        topProgressStart();

        const hintEl = document.querySelector(
            '.empty-state--loading .empty-state-hint'
        );

        let loaded = null;
        try {
            loaded = await loadFreshData({
                onProgress: (pct, { fallback } = {}) => {
                    if (!hintEl || !hintEl.isConnected) return;

                    if (fallback) {
                        hintEl.textContent = `Резервная копия · Загружено ${pct}%`;
                    } else {
                        hintEl.textContent = `Загружено ${pct}%`;
                    }
                },
            });
        } catch (e) {
            console.warn('[init] load failed:', e);
        }

        topProgressDone();

        if (!loaded || !loaded.data) {
            state.fallbackActive = navigator.onLine !== false;
            state.urlContext = false;
            state.urlRaw     = null;
            state.urlEventId = null;
            showNoDataState();
            updateOnlineStatus();
            registerServiceWorker();
            return;
        }

        applyDataToState(loaded.data, loaded.usedFallback);
        rebuildGroups();

        const urlResult = resolveUrlContext();
        if (urlResult === 'none') {
            state.urlContext = false;
            updateViewButton();
            setTimeout(() => showToast('Ссылка недействительна или устарела'), 300);
        }

        if (!state.urlContext) {
            resetToToday();
            localStorage.removeItem('schedule-scroll-week');
            localStorage.removeItem('schedule-scroll-day');
        }

        finalizeWithData();
    }

    registerServiceWorker();
}

function buildShareUrl() {
    const params = new URLSearchParams();
    const f = [...state.selectedFaculties];
    const g = [...state.selectedGroups];
    const t = [...state.selectedTeachers];

    if (f.length) params.set('f', f.join(','));
    if (g.length) params.set('g', g.join(','));
    if (t.length) params.set('t', t.join(','));
    params.set('v', state.view);
    params.set('d', toISO(state.currentDate));

    return location.origin + location.pathname + '?' + params.toString();
}

async function copyText(text, emptyMessage) {
    if (!text) {
        showToast(emptyMessage || 'Нечего копировать');
        return;
    }
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
            showToast('Скопировано');
        } else {
            showToast('Не удалось скопировать');
        }
    } catch (e) {
        console.warn('[copy] failed:', e);
        showToast('Не удалось скопировать');
    }
}

function setupShareButton() {
    const btn = document.getElementById('shareBtn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();

        openShareMenu(btn, {
            onLink: () => openShareModal(buildShareUrl(), 'Расписание'),
            onText: () => {
                const text = buildTextForView(
                    state.view,
                    state.currentDate,
                    state.filteredEvents
                );
                copyText(text, 'Нет мероприятий для копирования');
            },
        });
    });
}

function setupUrlContextBanner() {
    const banner = document.getElementById('urlContextBanner');
    if (!banner) return;

    if (!state.urlContext) {
        banner.hidden = true;
        return;
    }

    banner.hidden = false;
    banner.setAttribute('aria-label', 'Вы смотрите расписание по чужой ссылке. Перейти к своему расписанию');
    banner.addEventListener('click', () => {
        location.replace(location.origin + location.pathname);
    });
}

function openUrlContextEvent() {
    if (!state.urlContext || !state.urlEventId) return;

    const eventId = state.urlEventId;
    const targetIso = toISO(state.currentDate);

    const target =
        state.filteredEvents.find(ev => ev.event_id === eventId && ev.dateISO === targetIso) ||
        state.filteredEvents.find(ev => ev.event_id === eventId);

    if (!target) return;

    requestAnimationFrame(() => {
        let el = null;
        try {
            el = document.querySelector(
                `[data-event-id="${CSS.escape(eventId)}"][data-date-iso="${CSS.escape(target.dateISO)}"]`
            );
        } catch (_) {}
        if (!el) {
            try {
                el = document.querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
            } catch (_) {}
        }
        if (el) showEventDetails(target, el);
    });
}

const SW_RELOAD_FLAG = 'schedule-sw-reloading';

function _swReloadGuardActive() {
    try { return sessionStorage.getItem(SW_RELOAD_FLAG) === '1'; }
    catch { return false; }
}

function _swReloadGuardSet() {
    try { sessionStorage.setItem(SW_RELOAD_FLAG, '1'); } catch {}
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    const hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        if (!navigator.serviceWorker.controller) return;
        if (_swReloadGuardActive()) return;

        _swReloadGuardSet();
        location.reload();
    });

    navigator.serviceWorker.register('sw.js').then((reg) => {
        console.info('[SW] Зарегистрирован. scope:', reg.scope);
    }).catch((err) => {
        console.warn('[SW] Регистрация не удалась:', err);
    });
}

const UPDATE_INTERVAL = 30 * 60 * 1000;

async function fetchAndApply({ showIndicator = false } = {}) {
    const online = navigator.onLine !== false;
    const trackProgress = showIndicator && online;

    if (trackProgress) {
        showSyncBanner('loading');
        topProgressStart();
    }

    let result;
    try {
        const fresh = await loadFreshData();

        if (!fresh) {
            if (online) {
                state.fallbackActive = true;
                updateOnlineStatus();
            }
            result = { ok: false, reason: 'no data' };
        } else {
            const incoming = fresh.data;
            const usedFallback = !!fresh.usedFallback;

            state.fallbackActive = usedFallback;
            updateOnlineStatus();

            if (usedFallback) {
                result = {
                    ok: false,
                    reason: 'fallback',
                    changed: false,
                };
            } else if (incoming.generated_at === state.displayedIso) {
                // Если версия совпала, но в памяти нет is_past (старый кэш) —
                // принудительно обновляем данные и перерисовываем.
                const missingPast = state.allEvents.some(ev => ev.is_past === undefined);
                if (missingPast) {
                    state.currentData = incoming;
                    state.allEvents = incoming.events || [];
                    saveSnapshot(incoming.events || []);
                    applyFilters();
                    render();
                }
                result = { ok: true, changed: false };
            } else {
                const oldSnapshot = loadSnapshot();
                const oldVersion = loadGeneratedAt();
                const changes = oldSnapshot && !state.urlContext
                    ? compareEvents(oldSnapshot, incoming.events || [])
                    : [];

                state.currentData = incoming;
                state.allEvents = incoming.events || [];
                state.displayedIso = incoming.generated_at;

                updateUpdatedLabel(state.displayedIso);
                saveGeneratedAt(state.displayedIso);

                rebuildGroups();
                applyFilters();
                updateTriggerLabel();
                updateCounter();
                render();
                saveSnapshot(incoming.events || []);

                if (changes.length > 0) {
                    state.pendingChanges = sortChanges(changes);
                    state.pendingChangesMeta = {
                        oldVersion,
                        newVersion: incoming.generated_at || null,
                    };
                    savePendingChanges(state.pendingChanges);
                    savePendingChangesMeta(state.pendingChangesMeta);
                    if (updateBannerApi) updateBannerApi.refresh();
                }

                result = { ok: true, changed: true, count: changes.length };
            }
        }
    } catch (e) {
        console.warn('[refresh] failed:', e);
        if (online) {
            state.fallbackActive = true;
            updateOnlineStatus();
        }
        result = { ok: false, reason: e.message || String(e) };
    }

    if (trackProgress) {
        topProgressDone();
        if (result.ok) hideSyncBanner();
        else           showSyncBanner('error');
    }

    return result;
}

window.__checkForUpdates = fetchAndApply;

const MIN_UPDATE_GAP = 5 * 60 * 1000;

function setupPeriodicUpdates() {
    let lastCheck = 0;

    function maybeCheck() {
        if (document.hidden) return;
        const now = Date.now();
        if (now - lastCheck < MIN_UPDATE_GAP) return;
        lastCheck = now;
        fetchAndApply({ showIndicator: false });
    }

    setInterval(maybeCheck, UPDATE_INTERVAL);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) maybeCheck();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}