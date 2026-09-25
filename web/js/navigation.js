'use strict';

import { state, saveCurrentDate, saveScrollMemory } from './state.js';
import { addDays, addMonths } from './utils.js';
import { render } from './render.js';


export function navigate(delta) {
  if (state.view === 'month') {
    state.currentDate = addMonths(state.currentDate, delta);
  } else if (state.view === 'week') {
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

export function updateViewButton() {
    const btn = document.getElementById('viewBtn');
    btn.dataset.view = state.view;
    btn.setAttribute('aria-label', `Вид: ${viewLabel(state.view)}`);
}

export function cycleView() {
    const cal = document.getElementById('calendar');
    if (state.initialRenderDone && (state.view === 'week' || state.view === 'day')) {
        saveScrollMemory(state.view, {
            top: cal.scrollTop,
            left: cal.scrollLeft,
        });
    }
    const order = ['month', 'week', 'day', 'load'];
    const idx = order.indexOf(state.view);
    state.view = order[(idx + 1) % order.length];
    localStorage.setItem('schedule-view', state.view);
    updateViewButton();
    render('fade');
}

/* ============================================================
 *  ТЕМА
 *
 *  Цикл кликов:  light → auto → dark → light → ...
 *
 *  data-theme-current = текущий режим.
 *  Иконка на кнопке = текущий режим:
 *      current=light → sun
 *      current=auto  → circle with A
 *      current=dark  → moon
 * ============================================================ */

const THEME_CYCLE = ['light', 'auto', 'dark'];
const DARK_MQ = '(prefers-color-scheme: dark)';

function systemPrefersDark() {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia(DARK_MQ).matches;
}

/** 'light' | 'auto' | 'dark' → 'light' | 'dark' (эффективная тема). */
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

/** Вызывается один раз из main.js до первой отрисовки. */
export function initTheme() {
    applyTheme();
    updateThemeButton();
    setupThemeSystemListener();
}

/**
 * Переключает вид (и при необходимости дату) и перерисовывает.
 * Используется, в частности, из load-view при клике на номер недели.
 */
export function navigateTo(view, date) {
    state.view = view;
    if (date) state.currentDate = new Date(date);
    if (!state.urlContext) {
        try { localStorage.setItem('schedule-view', view); } catch {}
    }
    saveCurrentDate(state.currentDate);
    updateViewButton();
    render('fade');
}