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
} from './navigation.js';
import { setupUpdatedButton, updateUpdatedLabel } from './version.js';
import { setupOnlineStatus, updateOnlineStatus } from './online.js';
import { compareEvents, sortChanges } from './changes.js';
import { setupChangesModal } from './changes-modal.js';
import { setupUpdateBanner, getVisibleChanges } from './update-banner.js';
import { setupReadmeModal } from './readme.js';
import { showToast } from './toast.js';
import { openShareMenu, buildTextForView } from './share.js';
import { setupExportModal } from './export.js';
import { setupCalendarGestures, setupPullToRefresh } from './gestures.js';
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

/**
 * Достаёт события из localStorage-снапшота — последний рубеж,
 * когда ни data.json, ни old_data.json не отдались.
 *
 * Снапшот пишется в формате makeSnapshotEntry (state.js): те же поля,
 * что у raw event, плюс служебный `key`. expandEvents() спокойно
 * переварит лишнее поле — просто скопирует его дальше.
 *
 * generated_at берётся из отдельного LS-ключа schedule-last-generated-at,
 * который пишется при каждой успешной загрузке data.json / old_data.json.
 */
function loadSnapshotData() {
    const events = loadSnapshot();
    if (!Array.isArray(events) || events.length === 0) return null;

    return {
        events,
        generated_at: loadGeneratedAt() || null,
    };
}

/**
 * Порядок загрузки:
 *   1. data.json      — свежак, сеть / SW-кэш.
 *   2. old_data.json  — прошлая публикация.
 *   3. LS snapshot    — последний успешный визит на этом устройстве.
 *   4. null           — совсем пусто.
 *
 * usedFallback=true только когда ОНЛАЙН и не получилось взять свежак.
 * В оффлайне всегда false: там ⚡ уже сигналит статус, не нужно дублировать.
 */
async function loadInitialData() {
    const online = navigator.onLine !== false;

    try {
        const data = await loadData('data.json');
        if (isValidScheduleData(data)) {
            return { data, usedFallback: false };
        }
        console.warn('[init] data.json невалиден');
    } catch (e) {
        console.warn('[init] data.json недоступен:', e.message || e);
    }

    try {
        const data = await loadData('old_data.json');
        if (isValidScheduleData(data)) {
            return { data, usedFallback: online };
        }
        console.warn('[init] old_data.json невалиден');
    } catch (e) {
        console.warn('[init] old_data.json недоступен:', e.message || e);
    }

    const snap = loadSnapshotData();
    if (snap) {
        console.info('[init] Использую локальный snapshot');
        return { data: snap, usedFallback: online };
    }

    return { data: null, usedFallback: online };
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
    if (!state.urlContext) {
        localStorage.setItem('schedule-view', 'week');
    }
    updateViewButton();
    state.scrollToNow = true;
}

/* ============================================================
 *  init
 * ============================================================ */

async function init() {
    stripReloadMarker();

    initTheme();

    // Подтягиваем последнюю известную версию из LS ДО setupOnlineStatus,
    // чтобы первый updateOnlineStatus() уже отрисовал корректное время,
    // а не «—».
    state.displayedIso = loadGeneratedAt();

    // Deep links: читаем URL-параметры до всего остального — они
    // перетирают то, что подгрузилось из localStorage.
    applyUrlContext();

    updateViewButton();

    setupOnlineStatus();

    let loaded;
    try {
        loaded = await loadInitialData();
    } catch (e) {
        showFatalError(e.message || String(e));
        return;
    }

    if (!loaded.data) {
        state.fallbackActive = loaded.usedFallback;
        // Данных нет — валидировать URL не с чем, просто гасим контекст,
        // чтобы плашка не висела вхолостую.
        state.urlContext = false;
        state.urlRaw     = null;
        state.urlEventId = null;
        showNoDataState();
        updateOnlineStatus();
        setupShareButton();
        setupUrlContextBanner();
        registerServiceWorker();
        return;
    }

    state.fallbackActive = loaded.usedFallback;
    state.currentData = loaded.data;
    state.displayedIso = loaded.data.generated_at || state.displayedIso;
    state.allEvents = expandEvents(loaded.data.events || []);
    updateUpdatedLabel(state.displayedIso);
    updateOnlineStatus();

    const savedColWidth = loadDayColWidth();
    if (savedColWidth) {
        document.documentElement.style.setProperty('--m-day-col', savedColWidth + 'px');
    }

    // ВАЖНО: savedGenAt читаем ДО saveGeneratedAt — иначе сравнение
    // ниже всегда даст «ничего не изменилось», и resetToToday() никогда
    // не сработает ни на первом визите, ни при смене версии data.json.
    const savedGenAt = loadGeneratedAt();
    const currentGenAt = loaded.data.generated_at;

    // Синхронизируем LS со свежим значением (переживёт reload в оффлайне).
    if (currentGenAt) {
        saveGeneratedAt(currentGenAt);
    }

    if (state.fallbackActive) {
        if (!state.urlContext) resetToToday();
    } else {
        const isFirstVisit = !savedGenAt;
        const hasChanged = savedGenAt && savedGenAt !== currentGenAt;

        if (!state.urlContext && (isFirstVisit || hasChanged)) {
            resetToToday();
            localStorage.removeItem('schedule-scroll-week');
            localStorage.removeItem('schedule-scroll-day');
        }

        const oldSnapshot = loadSnapshot();
        if (oldSnapshot) {
            const changes = compareEvents(oldSnapshot, loaded.data.events || []);
            if (changes.length > 0) {
                // Есть свежая порция — перезаписываем постоянный список.
                state.pendingChanges = sortChanges(changes);
                savePendingChanges(state.pendingChanges);
            }
            // Если изменений нет — state.pendingChanges уже подгружен
            // из localStorage в state.js, и мы его НЕ трогаем.
        }

        saveSnapshot(loaded.data.events || []);
    }

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

    // Deep links: валидируем URL-параметры против реальных данных.
    // 'empty'   — обычный заход, ничего не делаем.
    // 'none'    — параметры были, но не сматчились → откат + тост.
    // 'full'/'partial' — применяем как есть.
    const urlResult = resolveUrlContext();
    if (urlResult === 'none') {
        state.urlContext = false;
        updateViewButton();
        // Показываем тост после render — чтобы он не перекрывался
        // первой отрисовкой пустого календаря.
        setTimeout(() => showToast('Ссылка недействительна или устарела'), 300);
    }

    applyFilters();
    setupUnifiedFilter();
    setupFavoritesButton();
    const exportModal = setupExportModal();
    document.getElementById('exportIcsBtn').addEventListener('click', exportModal.open);

    document.getElementById('prevBtn').addEventListener('click', () => navigate(-1));
    document.getElementById('nextBtn').addEventListener('click', () => navigate(1));
    document.getElementById('todayBtn').addEventListener('click', goToToday);
    document.getElementById('viewBtn').addEventListener('click', cycleView);
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

    changesModalApi = setupChangesModal();
    updateBannerApi = setupUpdateBanner({
        onOpen: () => changesModalApi.open(getVisibleChanges()),
    });

    // updatedBtn: в норме — открывает модалку изменений.
    // В оффлайне и в fallback клик перехватывает online.js в capture-фазе,
    // до этого обработчика управление не доходит.
    setupUpdatedButton({
        onOpen: () => changesModalApi.open(getVisibleChanges()),
    });

    if (!state.fallbackActive) {
        updateBannerApi.refresh();
    }

    render();

    setupShareButton();
    setupUrlContextBanner();
    openUrlContextEvent();

    // Один раз на сессию: любой клик пользователя снимает urlContext,
    // после этого все save-функции снова пишут в localStorage.
    document.addEventListener('click', () => {
        disarmUrlContext();
    }, true);

    setInterval(updateOnlineStatus, 60 * 1000);

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

    // Событие может быть скрыто фильтром g/t или не совпасть по дате —
    // в этом случае молча ничего не открываем (баннер уже объясняет,
    // почему вид не такой, как в личных настройках).
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

async function checkForUpdates() {
    if (state.fallbackActive) return;

    let fresh;
    try {
        const resp = await fetch('data.json?t=' + Date.now());
        if (!resp.ok) return;
        fresh = await resp.json();
    } catch (e) {
        console.warn('[auto-update] fetch failed:', e);
        return;
    }

    if (!isValidScheduleData(fresh)) return;
    if (fresh.generated_at === state.displayedIso) return;

    const oldSnapshot = loadSnapshot();
    const changes = oldSnapshot ? compareEvents(oldSnapshot, fresh.events || []) : [];

    state.currentData = fresh;
    state.allEvents = expandEvents(fresh.events || []);
    state.displayedIso = fresh.generated_at;
    updateUpdatedLabel(fresh.generated_at);
    saveGeneratedAt(fresh.generated_at);
    applyFilters();
    render();
    saveSnapshot(fresh.events || []);

    if (changes.length === 0) return;

    state.pendingChanges = sortChanges(changes);
    savePendingChanges(state.pendingChanges);
    if (updateBannerApi) updateBannerApi.refresh();
}

window.__checkForUpdates = checkForUpdates;

setInterval(checkForUpdates, UPDATE_INTERVAL);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}