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

async function loadFreshData({ onProgress = null } = {}) {
    const online = navigator.onLine !== false;

    // Обёртка: если пришёл свежий source — прогресс без изменений,
    // если fallback — сбрасываем в «Загрузка резервной копии…».
    let currentSource = 'main';
    const safeProgress = typeof onProgress === 'function'
        ? (pct) => {
            if (currentSource === 'fallback' && pct < 50) {
                // Первый тик после сброса — переименовываем
                onProgress(pct, { fallback: true });
            } else {
                onProgress(pct, { fallback: currentSource === 'fallback' });
            }
        }
        : null;

    try {
        const data = await loadData('data.json', { onProgress: safeProgress });
        if (isValidScheduleData(data)) {
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
 * Баннер синхронизации под тулбаром.
 *
 *   showSyncBanner('loading') — «Обновление…»
 *   showSyncBanner('error')   — «Ошибка обновления» + кнопка «Повторить»
 *   hideSyncBanner()          — скрыть
 *
 * Loading показывается с задержкой 400 мс: если данные пришли раньше,
 * пользователь вообще ничего не увидит. Error — сразу.
 *
 * Если уже показан error и мы стартуем новую попытку —
 * переключаемся на loading мгновенно (без задержки).
 * Приоритет с update-banner: пока update-banner открыт, sync-banner
 * скрывается через CSS-селектор — JS об этом не думает.
 */
let syncBannerTimer = null;
let syncBannerMode  = null;   // 'loading' | 'error' | null
let pendingSyncMode = null;   // что показать, когда закроется update-banner

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

    // Пока открыт update-banner (изменения в расписании) — они
    // делят одну точку под тулбаром. Откладываем показ: как только
    // пользователь закроет update-banner, покажем отложенное.
    if (isUpdateBannerOpen()) {
        pendingSyncMode = mode;
        return;
    }

    // Уже показано то же состояние — не мигаем
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

    // Loading — с задержкой, если не идёт смена с error.
    // Error — мгновенно.
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

/**
 * Вызывается при закрытии update-banner (крестик или клик).
 * Если во время показа update-banner мы отложили sync — показываем.
 */
function flushPendingSyncBanner() {
    if (pendingSyncMode === null) return;
    const mode = pendingSyncMode;
    pendingSyncMode = null;
    // Небольшая задержка, чтобы не мигало в момент анимации
    setTimeout(() => showSyncBanner(mode), 120);
}

/* ============================================================
 *  TOP PROGRESS — тонкая полоска загрузки сверху
 *
 *  API: topProgressStart() / topProgressDone()
 *
 *  Логика роста:
 *    • 0 → 10% мгновенно (мгновенный отклик на «начало»);
 *    • 10% → 85% — плавно замедляясь, интервал 180 мс
 *      (создаёт ощущение «работает, но не знает когда конец»);
 *    • done() → 100% и fade-out за ~0.5 с.
 *
 *  Одновременные start/done не ломают друг друга: каждый start
 *  отменяет старый таймер, done — тоже.
 * ============================================================ */

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

    // 1) Убиваем всё, что могло остаться с прошлого раза
    if (topProgressInterval) {
        clearInterval(topProgressInterval);
        topProgressInterval = null;
    }
    if (topProgressHideTimer) {
        clearTimeout(topProgressHideTimer);
        topProgressHideTimer = null;
    }

    // 2) Показываем элемент и сбрасываем в 0
    //    БЕЗ transition — чтобы рестарт был мгновенным и предсказуемым.
    el.hidden = false;
    el.style.transition = 'none';
    el.style.transform  = 'scaleX(0)';
    el.style.opacity    = '1';
    topProgressValue    = 0;

    // 3) Форсируем reflow — заставляем браузер «применить»
    //    scaleX(0), прежде чем перейти к следующему значению.
    //    Без этого шага два изменения стиля могут слиться в одно,
    //    и анимации не будет вовсе (или будет резкий скачок).
    void el.offsetWidth;

    // 4) Мгновенный рывок до 10% — синхронно, без RAF.
    //    RAF не срабатывает во фоновых вкладках и на некоторых
    //    мобильных браузерах — именно из-за этого полоска
    //    «не всегда появлялась».
    el.style.transition = 'transform 0.25s ease-out';
    topProgressValue     = 0.1;
    el.style.transform   = 'scaleX(0.1)';

    // 5) Дальше — медленный рост к 85% с асимптотическим замедлением
    topProgressInterval = setInterval(() => {
        if (topProgressValue >= 0.85) return;
        topProgressValue += (0.85 - topProgressValue) * 0.08;
        el.style.transform = `scaleX(${topProgressValue.toFixed(4)})`;
    }, 180);
}

function topProgressDone() {
    const el = _topProgressEl();
    if (!el) return;

    // 1) Останавливаем рост
    if (topProgressInterval) {
        clearInterval(topProgressInterval);
        topProgressInterval = null;
    }
    if (topProgressHideTimer) {
        clearTimeout(topProgressHideTimer);
        topProgressHideTimer = null;
    }

    // 2) Форсируем reflow — чтобы transition точно сработал
    //    от текущего значения, а не «слипся» с предыдущим.
    void el.offsetWidth;

    // 3) Догоняем до 100% и плавно прячем
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

    // Когда пользователь закрывает баннер изменений — показываем
    // отложенный баннер синхронизации (если он был отложен).
    const updateBannerClose = document.getElementById('updateBannerClose');
    if (updateBannerClose) {
        updateBannerClose.addEventListener('click', () => {
            setTimeout(flushPendingSyncBanner, 60);
        });
    }
    const updateBannerEl = document.getElementById('updateBanner');
    if (updateBannerEl) {
        // Клик по баннеру (не по крестику) тоже закрывает его
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

    // Кнопки баннера синхронизации
    const syncAction = document.getElementById('syncBannerAction');
    if (syncAction) {
        syncAction.addEventListener('click', (e) => {
            e.stopPropagation();
            // Новая попытка. showSyncBanner('loading') сам
            // переключит текущий error → loading мгновенно.
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
        topProgressStart();

        // Кэшируем ссылку на hint один раз — не дёргаем DOM на каждом тике
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
    const online = navigator.onLine !== false;
    const trackProgress = showIndicator && online;

    // Показываем loading только если онлайн: в оффлайне
    // кнопка «Обновлено» и так переключится в «Оффлайн»,
    // а баннер ошибки был бы лишним шумом.
    if (trackProgress) {
        showSyncBanner('loading');
        topProgressStart();
    }

    let result;
    try {
        const fresh = await loadFreshData();

        if (!fresh) {
            // Данных не получили. Если онлайн — это ошибка сети/сервера,
            // выставляем fallbackActive, чтобы кнопка стала «Ошибка · обновить».
            if (online) {
                state.fallbackActive = true;
                updateOnlineStatus();
            }
            result = { ok: false, reason: 'no data' };
        } else {
            const incoming = fresh.data;
            const usedFallback = !!fresh.usedFallback;

            // state.fallbackActive управляет видом кнопки «Обновлено/Ошибка».
            state.fallbackActive = usedFallback;
            updateOnlineStatus();

            // ВАЖНО: fallback (данные из old_data.json) — это тоже
            // «неуспех» с точки зрения баннера. Пользователь должен
            // видеть, что свежая версия не пришла, даже если старые
            // данные успешно подгружены.
            if (usedFallback) {
                result = {
                    ok: false,
                    reason: 'fallback',
                    changed: false,
                };
                // НЕ трогаем state.currentData и не сохраняем снимок —
                // оставляем базу такой, какой её видел пользователь.
                // Fallback-копия не должна перетирать UI.
                // ⚠️ Без return: управление должно дойти до финального
                // блока, который переключит баннер loading → error.
            } else if (incoming.generated_at === state.displayedIso) {
                result = { ok: true, changed: false };
            } else {
                const oldSnapshot = loadSnapshot();
                const changes = oldSnapshot && !state.urlContext
                    ? compareEvents(oldSnapshot, incoming.events || [])
                    : [];

                state.currentData = incoming;
                state.allEvents = expandEvents(incoming.events || []);
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
                    savePendingChanges(state.pendingChanges);
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

    // Финальное состояние баннера синхронизации
    if (trackProgress) {
        topProgressDone();
        if (result.ok) hideSyncBanner();
        else           showSyncBanner('error');
    }

    return result;
}

window.__checkForUpdates = fetchAndApply;

setInterval(() => fetchAndApply({ showIndicator: false }), UPDATE_INTERVAL);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}