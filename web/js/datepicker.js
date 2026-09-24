'use strict';

import { MONTHS_NOM } from './config.js';
import { state, saveCurrentDate } from './state.js';  // ← добавили saveCurrentDate
import { toISO, isToday, startOfWeek, addDays } from './utils.js';
import { render } from './render.js';

export const pickerState = { year: 0, month: 0 };



export function openDatePicker() {
    pickerState.year = state.currentDate.getFullYear();
    pickerState.month = state.currentDate.getMonth();
    renderPicker();
    document.getElementById('dateModal').classList.add('open');
}

export function closeDatePicker() {
    document.getElementById('dateModal').classList.remove('open');
}

export function renderPicker() {
    const { year, month } = pickerState;
    document.getElementById('pickerTitle').textContent = `${MONTHS_NOM[month]} ${year}`;

    const grid = document.getElementById('pickerGrid');
    grid.innerHTML = '';

    const firstOfMonth = new Date(year, month, 1);
    const start = startOfWeek(firstOfMonth);
    const selISO = toISO(state.currentDate);

    for (let w = 0; w < 6; w++) {
        for (let dIdx = 0; dIdx < 7; dIdx++) {
            const day = addDays(start, w * 7 + dIdx);
            const cell = document.createElement('div');
            cell.className = 'picker-day';
            if (day.getMonth() !== month) cell.classList.add('other');
            if (isToday(day)) cell.classList.add('today');
            if (toISO(day) === selISO) cell.classList.add('selected');
            cell.textContent = day.getDate();
            cell.addEventListener('click', () => {
                state.currentDate = new Date(day);
                saveCurrentDate(state.currentDate);
                closeDatePicker();
                render('fade');
            });
            grid.appendChild(cell);
        }
    }
}