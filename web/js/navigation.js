'use strict';

import { state, saveCurrentDate, saveScrollMemory, saveNavStep } from './state.js';
import { addDays, addMonths } from './utils.js';
import { render } from './render.js';

/* ============================================================
 *  НАВИГАЦИЯ
 *
 *  step = view, если вид — month/week/day.
 *  Если вид — load, шаг берётся из state.navStep
 *  (каким был последний обычный вид).
 * ============================================================ */

export function navigate(delta) {
  const step = state.view === 'load' ? state.navStep : state.view;

  if (step === 'month') {
    state.currentDate = addMonths(state.currentDate, delta);
  } else if (step === 'week') {
    state.currentDate = addDays(state.currentDate, delta * 7);
  } else {
    state.currentDate = addDays(state.currentDate, delta);
  }
  saveCurrentDate(state.currentDate);
  render(delta > 0 ? 'next' : 'prev');
}

export function goToToday() {
  state.currentDate = new Date();
  saveCurrentDate(state.currentDate);
  render('fade');
}

export function viewLabel(v) {
    return { month: 'Месяц', week: 'Неделя', day: 'День', load: 'Нагрузка' }[v];
}

/* ============================================================
 *  КНОПКА ВИДА (иконка интервала)
 *
 *  - вне нагрузки viewBtn переключает сам view (month/week/day);
 *  - в нагрузке viewBtn переключает только navStep (шаг навигации
 *    стрелками). Вид остаётся 'load'.
 * ============================================================ */

export function updateViewButton() {
    const btn = document.getElementById('viewBtn');
    if (btn) {
        const displayView = state.view === 'load' ? state.navStep : state.view;
        btn.dataset.view = displayView;

        const label = state.view === 'load'
            ? 'Шаг навигации: ' + viewLabel(displayView) + '. Нажмите, чтобы сменить'
            : 'Вид: ' + viewLabel(state.view) + '. Нажмите, чтобы сменить';
        btn.setAttribute('aria-label', label);
    }

    // Пилюля «Календарь / Нагрузка».
    const calModeBtn = document.getElementById('calendarModeBtn');
    const loadBtn = document.getElementById('loadBtn');
    const isLoad = state.view === 'load';

    if (calModeBtn) {
        calModeBtn.classList.toggle('is-active', !isLoad);
        calModeBtn.setAttribute('aria-selected', isLoad ? 'false' : 'true');
    }
    if (loadBtn) {
        loadBtn.classList.toggle('is-active', isLoad);
        loadBtn.setAttribute('aria-selected', isLoad ? 'true' : 'false');
    }
}

const VIEW_CYCLE = ['month', 'week', 'day'];

export function cycleView() {
    // В нагрузке кнопка вида управляет шагом навигации стрелками.
    if (state.view === 'load') {
        const idx = VIEW_CYCLE.indexOf(state.navStep);
        state.navStep = VIEW_CYCLE[(idx + 1) % VIEW_CYCLE.length];
        saveNavStep(state.navStep);
        updateViewButton();
        return;
    }

    const cal = document.getElementById('calendar');
    if (state.initialRenderDone && (state.view === 'week' || state.view === 'day')) {
        saveScrollMemory(state.view, {
            top: cal.scrollTop,
            left: cal.scrollLeft,
        });
    }

    const idx = VIEW_CYCLE.indexOf(state.view);
    state.view = VIEW_CYCLE[(idx + 1) % VIEW_CYCLE.length];
    state.navStep = state.view;
    try { localStorage.setItem('schedule-view', state.view); } catch {}
    saveNavStep(state.navStep);
    updateViewButton();
    render('fade');
}

/* ============================================================
 *  ПИЛЮЛЯ «КАЛЕНДАРЬ / НАГРУЗКА»
 * ============================================================ */

export function switchToCalendar() {
    if (state.view !== 'load') return;   // уже в календаре — no-op
    state.view = state.navStep;
    try { localStorage.setItem('schedule-view', state.view); } catch {}
    saveNavStep(state.navStep);
    updateViewButton();
    render('fade');
}

export function switchToLoad() {
    if (state.view === 'load') return;   // уже в нагрузке — no-op
    state.navStep = state.view;
    state.view = 'load';
    try { localStorage.setItem('schedule-view', state.view); } catch {}
    saveNavStep(state.navStep);
    updateViewButton();
    render('fade');
}

/** @deprecated — используй switchToCalendar / switchToLoad. */
export function toggleLoadView() {
    if (state.view === 'load') switchToCalendar();
    else switchToLoad();
}

/* ============================================================
 *  ТЕМА
 *
 *  Цикл кликов:  light → auto → dark → light → ...
 * ============================================================ */

const THEME_CYCLE = ['light', 'auto', 'dark'];
const DARK_MQ = '(prefers-color-scheme: dark)';

function systemPrefersDark() {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia(DARK_MQ).matches;
}

function effectiveTheme(mode) {
    if (mode === 'auto') return systemPrefersDark() ? 'dark' : 'light';
    return mode;
}

function applyTheme() {
    document.documentElement.setAttribute('data-theme', effectiveTheme(state.theme));
}

export function updateThemeButton() {
    const btn = document.getElementById('themeBtn');
    if (!btn) return;

    btn.dataset.themeCurrent = state.theme;

    let label;
    if (state.theme === 'light') {
        label = 'Тема: светлая. Нажмите, чтобы включить авто.';
    } else if (state.theme === 'dark') {
        label = 'Тема: тёмная. Нажмите, чтобы включить светлую.';
    } else {
        label = systemPrefersDark()
            ? 'Тема: авто (системная тёмная). Нажмите, чтобы включить тёмную.'
            : 'Тема: авто (системная светлая). Нажмите, чтобы включить тёмную.';
    }
    btn.setAttribute('aria-label', label);
}

export function toggleTheme() {
    const idx = THEME_CYCLE.indexOf(state.theme);
    state.theme = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];

    try { localStorage.setItem('schedule-theme', state.theme); } catch {}

    document.documentElement.setAttribute('data-theme', effectiveTheme(state.theme));
    updateThemeButton();
}

let mediaListenerAttached = false;

function setupThemeSystemListener() {
    if (mediaListenerAttached || !window.matchMedia) return;
    mediaListenerAttached = true;

    const media = window.matchMedia(DARK_MQ);
    const handler = () => {
        if (state.theme === 'auto') {
            applyTheme();
            updateThemeButton();
        }
    };
    if (media.addEventListener) media.addEventListener('change', handler);
    else if (media.addListener) media.addListener(handler);
}

export function initTheme() {
    applyTheme();
    updateThemeButton();
    setupThemeSystemListener();
}

/**
 * Переключает вид (и при необходимости дату) и перерисовывает.
 */
export function navigateTo(view, date) {
    state.view = view;
    if (view !== 'load') {
        state.navStep = view;
        saveNavStep(state.navStep);
    }
    if (date) state.currentDate = new Date(date);
    if (!state.urlContext) {
        try { localStorage.setItem('schedule-view', view); } catch {}
    }
    saveCurrentDate(state.currentDate);
    updateViewButton();
    render('fade');
}