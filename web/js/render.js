'use strict';

import {
    HOUR_START, HOUR_END, HOUR_HEIGHT, PAIR_MINUTES,
    WEEKDAYS_SHORT, MONTHS_GEN, MONTHS_SHORT,
} from './config.js';
import { state } from './state.js';
import {
    pad, toISO, isToday, escapeHtml,
    startOfWeek, addDays,
} from './utils.js';
import { groupByDate } from './data.js';
import { layoutDayEvents } from './layout.js';
import { showEventDetails, showGroupDetails } from './popover.js';

/* ---------- EMPTY STATE ---------- */
export function hasActiveFilters() {
    return state.selectedGroups.size > 0 || state.selectedTeachers.size > 0;
}

export function openFilterDropdown() {
    const trigger = document.querySelector('.filter-trigger');
    if (trigger) trigger.click();
}

export function makeEmptyState() {
    const el = document.createElement('div');
    el.className = 'empty-state';

    if (state.allEvents.length === 0) {
        el.textContent = 'Мероприятий нет';
    } else if (!hasActiveFilters()) {
        el.innerHTML = `
            <button class="empty-state-btn" type="button">
                <svg class="icon" viewBox="0 0 24 24" width="16" height="16"
                     fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
                <span>Выберите фильтр</span>
            </button>
        `;
        el.querySelector('.empty-state-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openFilterDropdown();
        });
    } else {
        el.textContent = 'Нет мероприятий по выбранным фильтрам';
    }
    return el;
}

export function shouldShowEmptyState() {
    return state.filteredEvents.length === 0;
}

/* ---------- RENDER DISPATCH ---------- */
export function render(animation = null) {
    const cal = document.getElementById('calendar');
    cal.innerHTML = '';
    cal.className = 'calendar view-' + state.view;

    if (shouldShowEmptyState()) {
        cal.appendChild(makeEmptyState());
    } else if (state.view === 'month') {
        renderMonth(cal);
    } else if (state.view === 'week') {
        renderWeek(cal);
    } else {
        renderDay(cal);
    }

    updateDateLabel();

    if (animation) {
        void cal.offsetWidth;
        cal.classList.add('anim-' + animation);
        cal.addEventListener('animationend', () => {
            cal.classList.remove('anim-' + animation);
        }, { once: true });
    }
}

export function updateDateLabel() {
    const d = state.currentDate;
    const isNarrow = window.innerWidth <= 900;
    document.getElementById('dateLabel').textContent = isNarrow
        ? `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`
        : `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
}

/* ---------- WEEK VIEW ---------- */
export function renderWeek(root) {
    const start = startOfWeek(state.currentDate);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

    const header = document.createElement('div');
    header.className = 'cal-header week';
    header.appendChild(document.createElement('div'));
    for (const d of days) {
        const cell = document.createElement('div');
        cell.className = 'day-header';
        if (isToday(d)) cell.classList.add('today');
        cell.innerHTML = `<div class="day-name">${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]}</div>
                          <div class="day-num">${d.getDate()}</div>`;
        header.appendChild(cell);
    }
    root.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cal-body week';
    root.appendChild(body);

    const timeCol = document.createElement('div');
    timeCol.className = 'time-col';
    for (let h = HOUR_START; h <= HOUR_END; h++) {
        const lbl = document.createElement('div');
        lbl.className = 'time-label';
        lbl.textContent = `${pad(h)}:00`;
        timeCol.appendChild(lbl);
    }
    body.appendChild(timeCol);

    const grid = document.createElement('div');
    grid.className = 'day-grid';
    body.appendChild(grid);

    const byDate = groupByDate(state.filteredEvents);

    for (const d of days) {
        const col = document.createElement('div');
        col.className = 'day-col';
        if (isToday(d)) col.classList.add('today');
        col.style.height = ((HOUR_END - HOUR_START + 1) * HOUR_HEIGHT) + 'px';

        addHourLines(col);
        addCurrentTimeLine(col, d);

        const dayEvents = byDate.get(toISO(d)) || [];
        renderDayColumn(col, dayEvents);

        grid.appendChild(col);
    }
}

/* ---------- DAY VIEW ---------- */
export function renderDay(root) {
    const d = state.currentDate;

    const header = document.createElement('div');
    header.className = 'cal-header day';
    header.appendChild(document.createElement('div'));
    const cell = document.createElement('div');
    cell.className = 'day-header';
    if (isToday(d)) cell.classList.add('today');
    cell.innerHTML = `
        <div class="day-name">${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]}</div>
        <div class="day-num">${d.getDate()}</div>
    `;
    header.appendChild(cell);
    root.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cal-body day';
    root.appendChild(body);

    const timeCol = document.createElement('div');
    timeCol.className = 'time-col';
    for (let h = HOUR_START; h <= HOUR_END; h++) {
        const lbl = document.createElement('div');
        lbl.className = 'time-label';
        lbl.textContent = `${pad(h)}:00`;
        timeCol.appendChild(lbl);
    }
    body.appendChild(timeCol);

    const grid = document.createElement('div');
    grid.className = 'day-grid';
    body.appendChild(grid);

    const col = document.createElement('div');
    col.className = 'day-col';
    if (isToday(d)) col.classList.add('today');
    col.style.height = ((HOUR_END - HOUR_START + 1) * HOUR_HEIGHT) + 'px';

    addHourLines(col);
    addCurrentTimeLine(col, d);

    const byDate = groupByDate(state.filteredEvents);
    renderDayColumn(col, byDate.get(toISO(d)) || []);

    grid.appendChild(col);
}

/* ---------- DAY COLUMN ---------- */
export function renderDayColumn(col, dayEvents) {
    const items = layoutDayEvents(dayEvents);
    for (const item of items) {
        if (item.type === 'single') {
            col.appendChild(makeEventBlock(item.ev, item.column, item.columnsCount));
        } else {
            col.appendChild(makeGroupBlock(item));
        }
    }
}

/* ---------- HELPERS ---------- */
export function addHourLines(col) {
    for (let h = HOUR_START; h <= HOUR_END; h++) {
        const line = document.createElement('div');
        line.className = 'hour-line';
        line.style.top = ((h - HOUR_START) * HOUR_HEIGHT) + 'px';
        col.appendChild(line);
    }
}

export function addCurrentTimeLine(col, day) {
    if (!isToday(day)) return;
    const now = new Date();
    const top = (now.getHours() + now.getMinutes() / 60 - HOUR_START) * HOUR_HEIGHT;
    const maxTop = (HOUR_END - HOUR_START + 1) * HOUR_HEIGHT;
    if (top < 0 || top > maxTop) return;
    const line = document.createElement('div');
    line.className = 'current-time-line';
    line.style.top = top + 'px';
    col.appendChild(line);
}

export function makeEventBlock(ev, column = 0, columnsCount = 1) {
    const [h, m] = ev.time_start.split(':').map(Number);
    const top = (h + m / 60 - HOUR_START) * HOUR_HEIGHT;
    const height = (PAIR_MINUTES / 60) * HOUR_HEIGHT - 2;

    const el = document.createElement('div');
    el.className = 'event-block';
    el.style.top = top + 'px';
    el.style.height = height + 'px';

    if (columnsCount > 1) {
        const pct = 100 / columnsCount;
        el.style.left = `calc(${column * pct}% + 2px)`;
        el.style.right = `calc(${(columnsCount - column - 1) * pct}% + 2px)`;
        el.classList.add('event-block--narrow');
    }

    const titleText = ev.discipline + (ev.type ? ` (${ev.type})` : '');
    el.innerHTML = `
        <div class="event-title">${escapeHtml(titleText)}</div>
        <div class="event-room">${escapeHtml(ev.rooms || '')}</div>
        <div class="event-time">${ev.time_start}–${ev.endTime}</div>
    `;

    el.addEventListener('click', e => {
        e.stopPropagation();
        showEventDetails(ev, el);
    });

    return el;
}

export function makeGroupBlock(item) {
    const { events, startMin, endMin } = item;
    const top = (startMin / 60 - HOUR_START) * HOUR_HEIGHT;
    const height = ((endMin - startMin) / 60) * HOUR_HEIGHT - 2;

    const startH = String(Math.floor(startMin / 60)).padStart(2, '0');
    const startM = String(startMin % 60).padStart(2, '0');
    const endH = String(Math.floor(endMin / 60)).padStart(2, '0');
    const endM = String(endMin % 60).padStart(2, '0');

    const el = document.createElement('div');
    el.className = 'event-block event-block--group';
    el.style.top = top + 'px';
    el.style.height = height + 'px';
    el.style.left = '3px';
    el.style.right = '3px';

    el.innerHTML = `
        <div class="event-group-count">${events.length} мероприятий</div>
        <div class="event-group-time">${startH}:${startM}–${endH}:${endM}</div>
        <div class="event-group-hint">Нажмите, чтобы увидеть</div>
    `;

    el.addEventListener('click', e => {
        e.stopPropagation();
        showGroupDetails(events, el);
    });

    return el;
}

/* ---------- MONTH VIEW ---------- */
export function renderMonth(root) {
    const d = state.currentDate;
    const year = d.getFullYear();
    const month = d.getMonth();

    const grid = document.createElement('div');
    grid.className = 'month-grid';

    for (const name of WEEKDAYS_SHORT) {
        const cell = document.createElement('div');
        cell.className = 'month-weekday';
        cell.textContent = name;
        grid.appendChild(cell);
    }

    const firstOfMonth = new Date(year, month, 1);
    const start = startOfWeek(firstOfMonth);
    const byDate = groupByDate(state.filteredEvents);
    const MAX_SHOW = 3;

    for (let w = 0; w < 6; w++) {
        for (let dIdx = 0; dIdx < 7; dIdx++) {
            const day = addDays(start, w * 7 + dIdx);
            const cell = document.createElement('div');
            cell.className = 'month-cell';
            if (day.getMonth() !== month) cell.classList.add('other-month');
            if (isToday(day)) cell.classList.add('today');

            const num = document.createElement('div');
            num.className = 'month-day-num';
            num.textContent = day.getDate();
            cell.appendChild(num);

            const dayEvents = byDate.get(toISO(day)) || [];

            if (dayEvents.length > MAX_SHOW) {
                const group = document.createElement('div');
                group.className = 'month-event month-event--group';
                group.textContent = `${dayEvents.length} мероприятий`;
                group.title = `${dayEvents.length} мероприятий — нажмите, чтобы увидеть`;
                group.addEventListener('click', e => {
                    e.stopPropagation();
                    showGroupDetails(dayEvents, group);
                });
                cell.appendChild(group);
            } else {
                dayEvents.forEach(ev => {
                    const chip = document.createElement('div');
                    chip.className = 'month-event';
                    chip.textContent = `${ev.time_start} ${ev.discipline}${ev.type ? ` (${ev.type})` : ''}`;
                    chip.title = chip.textContent;
                    chip.addEventListener('click', e => {
                        e.stopPropagation();
                        showEventDetails(ev, chip);
                    });
                    cell.appendChild(chip);
                });
            }

            grid.appendChild(cell);
        }
    }

    root.appendChild(grid);
}