'use strict';

/* ============================================================
 *  Карточка нагрузки: детали по дню и неделе.
 *
 *  Небольшая модалка поверх страницы: что за занятия, сколько
 *  пар и часов, насколько плотно — плюс действия («в календаре»,
 *  «в таблице», «неделя»). Стиль тот же, что у остальных модалок.
 * ============================================================ */

import { navigateTo } from './navigation.js';
import { WEEKDAYS_SHORT, MONTHS_GEN } from './config.js';
import {
    levelFor, weekLevelFor, toUnitValue, formatPairs, unitWordApprox,
    densityLabel,
} from './load-model.js';

const WEEKDAYS_FULL = [
    'воскресенье', 'понедельник', 'вторник', 'среда',
    'четверг', 'пятница', 'суббота',
];

const MAX_LISTED = 14;

let initialized = false;
let modal = null;
let titleEl = null;
let bodyEl = null;
let actionsEl = null;

/* ---------- helpers ---------- */

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function plural(value, one, few, many) {
    const n = Math.abs(value);
    if (n % 10 === 1 && n % 100 !== 11) return one;
    if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return few;
    return many;
}

function formatDayTitle(date) {
    return WEEKDAYS_FULL[date.getDay()][0].toUpperCase()
        + WEEKDAYS_FULL[date.getDay()].slice(1)
        + ', ' + date.getDate()
        + ' ' + MONTHS_GEN[date.getMonth()];
}

function formatWeekRange(week) {
    const start = week.start;
    const end = week.end;
    const monthStart = MONTHS_GEN[start.getMonth()].slice(0, 3);
    const monthEnd = MONTHS_GEN[end.getMonth()].slice(0, 3);
    if (monthStart === monthEnd) {
        return start.getDate() + '–' + end.getDate() + ' ' + monthStart;
    }
    return start.getDate() + ' ' + monthStart + ' – ' + end.getDate() + ' ' + monthEnd;
}

function eventTime(event) {
    const start = String(event.time_start || '').trim();
    const end = String(event.time_end || '').trim();
    if (!start) return '';
    return end ? start + '–' + end : start;
}

function eventMeta(event, withGroup) {
    const parts = [];
    if (withGroup && event.group) parts.push(event.group);
    if (event.rooms) parts.push(event.rooms);
    const teachers = Array.isArray(event.teachers)
        ? event.teachers.join(', ')
        : String(event.teachers || '').trim();
    if (teachers) parts.push(teachers);
    return parts.join(' · ');
}

function sortEvents(events) {
    const key = (event) => {
        const start = String(event.time_start || '');
        return [
            start,
            String(event.discipline || ''),
            String(event.group || ''),
        ].join('|');
    };
    return [...events].sort((a, b) => key(a).localeCompare(key(b), 'ru'));
}

/* ---------- каркас модалки ---------- */

function ensureModal() {
    if (initialized) return true;
    modal = document.getElementById('loadModal');
    if (!modal) return false;

    initialized = true;
    titleEl = document.getElementById('loadModalTitle');
    bodyEl = document.getElementById('loadModalBody');
    actionsEl = document.getElementById('loadModalActions');

    const closeBtn = modal.querySelector('.load-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.classList.contains('open')) close();
    });
    return true;
}

function close() {
    if (!modal) return;
    modal.classList.remove('open');
    document.body.classList.remove('modal-open');
}

function openView({ title, body, actions }) {
    if (!ensureModal()) return;

    titleEl.textContent = title;
    bodyEl.replaceChildren(...body);

    actionsEl.replaceChildren();
    for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'load-modal-btn' + (action.primary ? ' is-primary' : '');
        button.textContent = action.label;
        button.addEventListener('click', () => {
            close();
            action.run();
        });
        actionsEl.appendChild(button);
    }

    modal.classList.add('open');
    document.body.classList.add('modal-open');
}

function actionFromEvent(events) {
    const event = (events || []).find(item => item && item.group);
    if (!event) return null;
    return () => {
        document.dispatchEvent(new CustomEvent('pspu:open-original', { detail: event }));
    };
}

/* ---------- общие блоки ---------- */

function buildSummary(chips) {
    const box = el('div', 'load-modal-summary');
    for (const chip of chips) {
        const node = el('span', 'load-modal-chip' + (chip.level ? ' is-' + chip.level : ''));
        node.textContent = chip.text;
        box.appendChild(node);
    }
    return box;
}

/* ---------- день ---------- */

export function showDayDetails(day, week, unit) {
    if (!day) return;

    const body = [];
    const level = levelFor(day.pairs);
    const chips = [{ text: formatPairs(day.pairs, unit), level }];
    if (week) chips.push({ text: 'Неделя ' + week.num });
    if (day.pairs > 0) chips.push({ text: densityLabel(level) });
    body.push(buildSummary(chips));

    const events = sortEvents(day.events || []);
    const groups = new Set(events.map(event => String(event.group || '')).filter(Boolean));
    const withGroup = groups.size > 1;

    if (events.length) {
        const list = el('ul', 'load-modal-list');
        for (const event of events.slice(0, MAX_LISTED)) {
            const item = el('li', 'load-modal-item');

            const time = eventTime(event);
            item.appendChild(el('span', 'load-modal-time', time || '—'));

            const main = el('div', 'load-modal-item-main');
            const name = el('div', 'load-modal-name');
            name.append(String(event.discipline || 'Без названия'));
            if (event.type) {
                const type = el('span', 'load-modal-type', ' (' + event.type + ')');
                name.appendChild(type);
            }
            main.appendChild(name);

            const meta = eventMeta(event, withGroup);
            if (meta) main.appendChild(el('div', 'load-modal-meta', meta));

            item.appendChild(main);
            list.appendChild(item);
        }
        if (events.length > MAX_LISTED) {
            list.appendChild(el(
                'li', 'load-modal-more',
                'и ещё ' + (events.length - MAX_LISTED) + ' ' +
                plural(events.length - MAX_LISTED, 'занятие', 'занятия', 'занятий'),
            ));
        }
        body.push(list);
    } else {
        body.push(el('div', 'load-modal-empty', 'В этот день занятий нет'));
    }

    const actions = [
        {
            label: 'В календаре',
            primary: true,
            run: () => navigateTo('day', day.date),
        },
    ];
    if (week) {
        actions.push({ label: 'Неделя', run: () => navigateTo('week', week.start) });
    }
    const original = actionFromEvent(events);
    if (original) actions.push({ label: 'В таблице', run: original });

    openView({ title: formatDayTitle(day.date), body, actions });
}

/* ---------- неделя ---------- */

export function showWeekDetails(week, unit) {
    if (!week) return;

    const body = [];

    const activeDays = week.days.filter(day => day.pairs > 0);
    const level = weekLevelFor(week.pairs);
    const chips = [
        { text: formatPairs(week.pairs, unit), level },
        {
            text: activeDays.length + ' ' +
                plural(activeDays.length, 'день', 'дня', 'дней') + ' занятий',
        },
    ];
    if (activeDays.length > 1) {
        const perDay = week.pairs / activeDays.length;
        chips.push({
            text: '≈ ' + toUnitValue(perDay, unit).toFixed(1) + ' '
                + unitWordApprox(unit, toUnitValue(perDay, unit)) + ' в день',
        });
    }
    body.push(buildSummary(chips));

    // Распределение по дням недели — компактные «суммы» без графика.
    const perDay = el('div', 'load-modal-days');
    const maxPairs = Math.max(1, ...week.days.map(day => day.pairs));
    week.days.forEach((day, index) => {
        const cell = el('div', 'load-modal-day');
        cell.classList.add('is-' + levelFor(day.pairs));

        cell.appendChild(el('span', 'load-modal-day-name', WEEKDAYS_SHORT[index]));

        const bar = el('span', 'load-modal-day-bar');
        const fill = el('span', 'load-modal-day-fill');
        fill.style.height = Math.round((day.pairs / maxPairs) * 100) + '%';
        bar.appendChild(fill);
        cell.appendChild(bar);

        cell.appendChild(el(
            'span', 'load-modal-day-value',
            day.pairs > 0 ? String(toUnitValue(day.pairs, unit)) : '·',
        ));
        perDay.appendChild(cell);
    });
    body.push(perDay);

    // Самые плотные дни недели — подсказка, куда смотреть.
    const busiest = [...activeDays].sort((a, b) => b.pairs - a.pairs)[0];
    if (busiest) {
        const note = el('div', 'load-modal-note');
        note.textContent = 'Плотнее всего — ' +
            WEEKDAYS_SHORT[(busiest.date.getDay() + 6) % 7] + ', ' +
            formatPairs(busiest.pairs, unit);
        body.push(note);
    }

    const events = [];
    for (const day of week.days) events.push(...(day.events || []));

    const actions = [
        {
            label: 'Открыть неделю',
            primary: true,
            run: () => navigateTo('week', week.start),
        },
    ];
    if (busiest) {
        actions.push({ label: 'Плотный день', run: () => navigateTo('day', busiest.date) });
    }
    const original = actionFromEvent(events);
    if (original) actions.push({ label: 'В таблице', run: original });

    openView({
        title: 'Неделя ' + week.num + ' · ' + formatWeekRange(week),
        body,
        actions,
    });
}

export function closeLoadDetails() {
    close();
}
