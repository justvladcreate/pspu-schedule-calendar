'use strict';

import {
  state, saveSetToStorage,
  loadDayColWidth, loadSnapshot, saveSnapshot,
  saveScrollMemory, saveGeneratedAt, loadGeneratedAt,
  saveCurrentDate,
} from './state.js';
import { escapeHtml } from './utils.js';
import { loadData, expandEvents } from './data.js';

import { render, updateDateLabel } from './render.js';
import { applyFilters, setupUnifiedFilter, updateTriggerLabel, updateCounter } from './filters.js';
import {
    navigate, goToToday, cycleView, toggleTheme,
    updateViewButton, updateThemeButton,
} from './navigation.js';
import { setupVersionToggle, updateUpdatedLabel } from './version.js';
import { compareEvents, sortChanges } from './changes.js';
import { setupChangesModal } from './changes-modal.js';
import { setupUpdateBanner, getVisibleChanges } from './update-banner.js';
import { setupReadmeModal } from './readme.js';
import { setupExportModal } from './export.js';
import { setupCalendarGestures, setupPullToRefresh } from './gestures.js';
import { openDatePicker, closeDatePicker, renderPicker, pickerState } from './datepicker.js';
import { hideEventDetails } from './popover.js';

let changesModalApi = null;
let updateBannerApi = null;

async function init() {
    document.documentElement.setAttribute('data-theme', state.theme);
    updateViewButton();
    updateThemeButton();

    let currentData;
    try {
        currentData = await loadData('data.json');
    } catch (e) {
        document.getElementById('calendar').innerHTML =
            `<div class="empty-state">Не удалось загрузить расписание: ${escapeHtml(e.message)}</div>`;
        return;
    }

    state.currentData = currentData;
    state.allEvents = expandEvents(currentData.events || []);
    updateUpdatedLabel(currentData.generated_at || null);

    // Восстановить ширину колонки (зум недели)
    const savedColWidth = loadDayColWidth();
    if (savedColWidth) {
      document.documentElement.style.setProperty('--m-day-col', savedColWidth + 'px');
    }

    // Сравниваем generated_at с прошлым визитом
    const savedGenAt = loadGeneratedAt();
    const currentGenAt = currentData.generated_at;
    const isFirstVisit = !savedGenAt;
    const hasChanged = savedGenAt && savedGenAt !== currentGenAt;

    if (isFirstVisit || hasChanged) {
      // Сброс на сегодня + view = неделя + скролл к текущему времени
      state.currentDate = new Date();
      saveCurrentDate(state.currentDate);
      state.view = 'week';
      localStorage.setItem('schedule-view', 'week');
      updateViewButton();

      state.scrollToNow = true;

      // Сохранённые скроллы устарели — чистим, чтобы не мешали
      localStorage.removeItem('schedule-scroll-week');
      localStorage.removeItem('schedule-scroll-day');
    }

    // Сравнение с предыдущим snapshot (если он есть)
    const oldSnapshot = loadSnapshot();
    if (oldSnapshot) {
      const changes = compareEvents(oldSnapshot, currentData.events || []);
      if (changes.length > 0) {
        const sorted = sortChanges(changes);
        console.log('[changes] Найдено изменений:', sorted.length);
        state.pendingChanges = sorted;
      } else {
        console.log('[changes] Реальных изменений нет');
      }
    } else {
      console.log('[changes] Первый визит — снапшот создаётся');
    }

    saveSnapshot(currentData.events || []);
    saveGeneratedAt(currentGenAt);

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

    applyFilters();
    setupUnifiedFilter();
    const exportModal = setupExportModal();
    document.getElementById('exportIcsBtn').addEventListener('click', exportModal.open);
    setupVersionToggle();

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

    // Сохранять скролл при прокрутке календаря (debounce)
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

    // Инициализация модалки изменений и баннера
    changesModalApi = setupChangesModal();
    updateBannerApi = setupUpdateBanner({
      onOpen: () => changesModalApi.open(getVisibleChanges()),
    });

    // Показать баннер, если есть видимые изменения и они не dismissed
    updateBannerApi.refresh();

    render();

    setInterval(() => {
        if (state.displayedIso) updateUpdatedLabel(state.displayedIso);
    }, 60 * 1000);

    registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service Worker registration failed:', err);
    });
  });
}

const UPDATE_INTERVAL = 30 * 60 * 1000; // 30 минут

async function checkForUpdates() {
  if (state.viewingOld) {
    console.log('[auto-update] Пропуск: смотрим старую версию');
    return;
  }

  let fresh;
  try {
    const resp = await fetch('data.json?t=' + Date.now());
    if (!resp.ok) return;
    fresh = await resp.json();
  } catch (e) {
    console.warn('[auto-update] fetch failed:', e);
    return;
  }

  if (fresh.generated_at === state.displayedIso) {
    console.log('[auto-update] generated_at не изменился');
    return;
  }

  const oldSnapshot = loadSnapshot();
  const changes = oldSnapshot ? compareEvents(oldSnapshot, fresh.events || []) : [];

  // Тихо применяем свежие данные
  state.currentData = fresh;
  state.allEvents = expandEvents(fresh.events || []);
  state.displayedIso = fresh.generated_at;
  updateUpdatedLabel(fresh.generated_at);
  applyFilters();
  render();
  saveSnapshot(fresh.events || []);
  saveGeneratedAt(fresh.generated_at);

  if (changes.length === 0) {
    console.log('[auto-update] data.json пересобран, реальных изменений нет');
    return;
  }

  const sorted = sortChanges(changes);
  console.log('[auto-update] Найдено изменений:', sorted.length);

  state.pendingChanges = sorted;
  if (updateBannerApi) updateBannerApi.refresh();
}

// Ручной вызов из консоли: __checkForUpdates()
window.__checkForUpdates = checkForUpdates;

// Фоновый цикл
setInterval(checkForUpdates, UPDATE_INTERVAL);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}