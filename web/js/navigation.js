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
  saveCurrentDate(state.currentDate);   // ← новое
  render(delta > 0 ? 'next' : 'prev');
}

export function goToToday() {
  state.currentDate = new Date();
  saveCurrentDate(state.currentDate);   // ← новое
  render('fade');
}

export function viewLabel(v) {
    return { month: 'Месяц', week: 'Неделя', day: 'День' }[v];
}

export function updateViewButton() {
    const btn = document.getElementById('viewBtn');
    btn.dataset.view = state.view;
    btn.setAttribute('aria-label', `Вид: ${viewLabel(state.view)}`);
}

export function updateThemeButton() {
    const btn = document.getElementById('themeBtn');
    btn.dataset.themeCurrent = state.theme;
    btn.setAttribute(
        'aria-label',
        state.theme === 'dark'
            ? 'Переключить на светлую тему'
            : 'Переключить на тёмную тему'
    );
}

export function cycleView() {
    const cal = document.getElementById('calendar');
    if (state.initialRenderDone && (state.view === 'week' || state.view === 'day')) {
        saveScrollMemory(state.view, {
            top: cal.scrollTop,
            left: cal.scrollLeft,
        });
    }
    const order = ['month', 'week', 'day'];
    const idx = order.indexOf(state.view);
    state.view = order[(idx + 1) % order.length];
    localStorage.setItem('schedule-view', state.view);
    updateViewButton();
    render('fade');
}

export function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('schedule-theme', state.theme);
    document.documentElement.setAttribute('data-theme', state.theme);
    updateThemeButton();
}