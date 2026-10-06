'use strict';

import {
  state, saveSetToStorage,
  loadDayColWidth, loadSnapshot, saveSnapshot,
  saveScrollMemory, saveGeneratedAt, loadGeneratedAt,
  saveCurrentDate, savePendingChanges,
  applyUrlContext, resolveUrlContext, disarmUrlContext,
} from './state.js';
import { escapeHtml, toISO } from './utils.js';
import { loadData, expandEvents } from './data.js';

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
import { compareEvents, sortChanges } from './changes.js';
import { setupChangesModal } from './changes-modal.js';
import { setupUpdateBanner, getVisibleChanges } from './update-banner.js';
import { setupReadmeModal } from './readme.js';
import { showToast } from './toast.js';
import { openShareMenu, buildTextForView } from './share.js';
import { setupExportModal } from './export.js';
import { setupCalendarGestures, setupPullToRefresh } from './gestures.js';
import { setupMoreMenu } from './more-menu.js';
import { setupOriginalModal } from './original.js';
import { openDatePicker, closeDatePicker, renderPicker, pickerState } from './datepicker.js';
import { hideEventDetails, showEventDetails } from './popover.js';

let changesModalApi = null;
let updateBannerApi = null;

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

function isValidScheduleData(data) {
    return data && typeof data === 'object' && Array.isArray(data.events);
}

function loadCachedData() {
    const events = loadSnapshot();
    if (!Array.isArray(events) || events.length === 0) return null;

    return {
        events,
        generated_at: loadGeneratedAt() || null,
    };
}

async function loadFreshData() {
    const online = navigator.onLine !== false;

    try {
        const data = await loadData('data.json', { timeout: 20000 });
        if (isValidScheduleData(data)) {
            return { data, usedFallback: false };
        }
        console.warn('[load] data.json невалиден');
    } catch (e) {
        console.warn('[load] data.json недоступен:', e.message || e);
    }

    try {
        const data = await loadData('old_data.json', { timeout: 20000 });
        if (isValidScheduleData(data)) {
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
    state.allEvents = expandEvents(data.events || []);
    state.fallbackActive = !!usedFallback;

    updateUpdatedLabel(state.displayedIso);
    updateOnlineStatus();
}

function rebuildGroups() {
    const groups = new Set();
    const teachers = new Set();
    for (const ev of state.allEvents) {
        if (ev.group) groups.add(ev.group);
        (ev.teachers || []).forEach(t => teachers.add(t));
    }
    state.groups = [...groups].sort();
    state.teachers = [...teachers].sort();

    for (const g of [...state.selectedGroups]) {
        if (!state.groups.includes(g)) state.selectedGroups.delete(g);
    }
    for (const t of [...state.selectedTeachers]) {
        if (!state.teachers.includes(t)) state.selectedTeachers.delete(t);
    }
    saveSetToStorage('schedule-selected-groups', state.selectedGroups);
    saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);
}

/**
 * Индикатор «Обновление…»:
 *   • показывается с задержкой 400 мс — если данные пришли раньше,
 *     пользователь вообще ничего не увидит (никаких миганий);
 *   • перед показом выставляем [hidden]=false, потом в следующем
 *     кадре добавляем .is-visible — так срабатывает CSS-переход.
 */
let updatingHintTimer = null;

function showUpdatingHint() {
    const el = document.getElementById('updatingHint');
    if (!el) return;

    if (updatingHintTimer) clearTimeout(updatingHintTimer);
    updatingHintTimer = setTimeout(() => {
        updatingHintTimer = null;
        el.hidden = false;
        requestAnimationFrame(() => el.classList.add('is-visible'));
    }, 400);
}

function hideUpdatingHint() {
    const el = document.getElementById('updatingHint');
    if (!el) return;

    if (updatingHintTimer) {
        clearTimeout(updatingHintTimer);
        updatingHintTimer = null;
    }
    el.classList.remove('is-visible');

    // Даём анимации доиграть, потом прячем совсем
    setTimeout(() => {
        if (!el.classList.contains('is-visible')) el.hidden = true;
    }, 200);
}

function showLoadingState() {
    const cal = document.getElementById('calendar');
    cal.innerHTML = `
        <div class="empty-state empty-state--loading">
            <div class="empty-state-spinner" aria-hidden="true"></div>
            <p class="empty-state-title">Загрузка расписания…</p>
            <p class="empty-state-hint">Это может занять несколько секунд</p>
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

/* ============================================================
 *  init
 * ============================================================ */

/* ============================================================
 *  UI, независимый от данных
 * ============================================================ */

function setupAllUI() {
    const exportModal = setupExportModal();
    document.getElementById('exportIcsBtn').addEventListener('click', exportModal.open);

    document.getElementById('prevBtn').addEventListener('click', () => navigate(-1));
    document.getElementById('nextBtn').addEventListener('click', () => navigate(1));
    document.getElementById('todayBtn').addEventListener('click', goToToday);
    document.getElementById('viewBtn').addEventListener('click', cycleView);
    document.getElementById('calendarModeBtn').addEventListener('click', switchToCalendar);
    document.getElementById('loadBtn').addEventListener('click', switchToLoad);
    document.getElementById('themeBtn').addEventListener('click', toggleTheme);
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
        hideEventDetails();
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

    const cal = document.getElementById('calendar');
    let scrollTimer = null;
    cal.addEventListener('scroll', () => {
        const viewAtScroll = state.view;
        if (scrollTimer) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
            if (viewAtScroll === 'week' || viewAtScroll === 'day') {
                saveScrollMemory(viewAtScroll, {
                    top: cal.scrollTop,
                    left: cal.scrollLeft,
                });
            }
        }, 200);
    }, { passive: true });

    setupReadmeModal();
    setupOriginalModal();

    changesModalApi = setupChangesModal();
    updateBannerApi = setupUpdateBanner({
        onOpen: () => changesModalApi.open(getVisibleChanges()),
    });

    setupUpdatedButton({
        onOpen: () => changesModalApi.open(getVisibleChanges()),
    });

    setupUnifiedFilter();
    setupFavoritesButton();

    setupShareButton();
    setupUrlContextBanner();

    document.addEventListener('click', () => {
        disarmUrlContext();
    }, true);

    setInterval(updateOnlineStatus, 60 * 1000);
}

/* ============================================================
 *  Пост-обработка после того, как данные уже в state
 * ============================================================ */

function finalizeWithData() {
    const currentEvents = (state.currentData && state.currentData.events) || [];

    // Снимок и сравнение — только когда мы не в fallback
    if (!state.fallbackActive) {
        const oldSnapshot = loadSnapshot();
        if (oldSnapshot && !state.urlContext) {
            const changes = compareEvents(oldSnapshot, currentEvents);
            if (changes.length > 0) {
                state.pendingChanges = sortChanges(changes);
                savePendingChanges(state.pendingChanges);
            }
        }
        saveSnapshot(currentEvents);
        if (state.displayedIso) saveGeneratedAt(state.displayedIso);
    }

    // Ширина колонки дня
    const savedColWidth = loadDayColWidth();
    if (savedColWidth) {
        document.documentElement.style.setProperty('--m-day-col', savedColWidth + 'px');
    }

    // Применяем фильтры к свежим данным
    applyFilters();
    updateTriggerLabel();
    updateCounter();

    // Баннер изменений
    if (!state.fallbackActive && updateBannerApi) {
        updateBannerApi.refresh();
    }

    render();

    // Баннер «вы смотрите по ссылке» (мог обновиться после resolveUrlContext)
    setupUrlContextBanner();

    // Открыть попап события, если пришли по deep-link
    openUrlContextEvent();
}

/* ============================================================
 *  init
 * ============================================================ */

async function init() {
    stripReloadMarker();
    initTheme();

    state.displayedIso = loadGeneratedAt();
    applyUrlContext();
    updateViewButton();
    setupMoreMenu();
    setupOnlineStatus();

    // Настраиваем UI — независимо от того, есть ли уже данные
    setupAllUI();

    const cached = loadCachedData();

    if (cached) {
        // === Мгновенный старт с кэша ===
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

        // Фоновое обновление — только если сеть вроде как есть
        if (navigator.onLine !== false) {
            fetchAndApply({ showIndicator: true }).then(result => {
                if (!result.ok) {
                    state.fallbackActive = true;
                    updateOnlineStatus();
                }
            });
        }
    } else {
        // === Холодный старт: нет кэша — спиннер в календаре, блокирующий fetch ===
        showLoadingState();

        let loaded = null;
        try {
            loaded = await loadFreshData();
        } catch (e) {
            console.warn('[init] load failed:', e);
        }

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

/* ============================================================
 *  DEEP LINKS / SHARE
 * ============================================================ */

function buildShareUrl() {
    const params = new URLSearchParams();
    const g = [...state.selectedGroups];
    const t = [...state.selectedTeachers];

    if (g.length) params.set('g', g.join(','));
    if (t.length) params.set('t', t.join(','));
    params.set('v', state.view);
    params.set('d', toISO(state.currentDate));

    return location.origin + location.pathname + '?' + params.toString();
}

async function shareLink(url, title) {
    try {
        if (navigator.share) {
            await navigator.share({ url, title: title || 'Расписание' });
        } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(url);
            showToast('Ссылка скопирована');
        } else {
            showToast('Не удалось скопировать ссылку');
        }
    } catch (e) {
        if (e && e.name !== 'AbortError') {
            console.warn('[share] failed:', e);
        }
    }
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
            onLink: () => shareLink(buildShareUrl(), 'Расписание'),
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

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        if (!hadController) {
            console.info('[SW] Первичный claim — перезагрузка не требуется.');
            return;
        }
        refreshing = true;
        console.info('[SW] Получил контроль — перезагружаю страницу.');
        location.reload();
    });

    navigator.serviceWorker.register('sw.js').then((reg) => {
        console.info('[SW] Зарегистрирован. scope:', reg.scope);
    }).catch((err) => {
        console.warn('[SW] Регистрация не удалась:', err);
    });
}

const UPDATE_INTERVAL = 30 * 60 * 1000;

/**
 * Загружает свежие данные и, если они отличаются от текущих,
 * обновляет state и перерисовывает.
 *
 * @param {Object}  [opts]
 * @param {boolean} [opts.showIndicator=false] — показывать ли «Обновление…»
 * @returns {Promise<{ok: boolean, changed?: boolean, count?: number, reason?: string}>}
 */
async function fetchAndApply({ showIndicator = false } = {}) {
    if (showIndicator) showUpdatingHint();

    try {
        const fresh = await loadFreshData();
        if (!fresh) {
            return { ok: false, reason: 'no data' };
        }

        const incoming = fresh.data;

        if (incoming.generated_at === state.displayedIso) {
            return { ok: true, changed: false };
        }

        const oldSnapshot = loadSnapshot();
        const changes = oldSnapshot && !state.urlContext
            ? compareEvents(oldSnapshot, incoming.events || [])
            : [];

        state.currentData = incoming;
        state.allEvents = expandEvents(incoming.events || []);
        state.displayedIso = incoming.generated_at;
        state.fallbackActive = !!fresh.usedFallback;

        updateUpdatedLabel(state.displayedIso);
        updateOnlineStatus();
        saveGeneratedAt(state.displayedIso);

        rebuildGroups();
        applyFilters();
        updateTriggerLabel();
        updateCounter();
        render();
        saveSnapshot(incoming.events || []);

        if (changes.length > 0) {
            state.pendingChanges = sortChanges(changes);
            savePendingChanges(state.pendingChanges);
            if (updateBannerApi) updateBannerApi.refresh();
        }

        return { ok: true, changed: true, count: changes.length };
    } catch (e) {
        console.warn('[refresh] failed:', e);
        return { ok: false, reason: e.message || String(e) };
    } finally {
        if (showIndicator) hideUpdatingHint();
    }
}

window.__checkForUpdates = fetchAndApply;

setInterval(() => fetchAndApply({ showIndicator: false }), UPDATE_INTERVAL);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}