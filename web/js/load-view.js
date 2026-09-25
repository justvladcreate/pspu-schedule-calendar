'use strict';

import { state } from './state.js';
import { toISO, startOfWeek, addDays, isToday } from './utils.js';
import { WEEKDAYS_SHORT, MONTHS_GEN } from './config.js';
import { groupByDate } from './data.js';
import { showEventDetails, showGroupDetails } from './popover.js';

/* ---------- helpers ---------- */

function dateFromISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}

/**
 * Кол-во пар в наборе событий.
 * Пара = уникальный pair_number (fallback — time_start).
 * Подгруппы одной пары считаются одной парой.
 */
function countPairs(events) {
    const keys = new Set();
    for (const ev of events) {
        const key = ev.pair_number != null && ev.pair_number !== ''
            ? String(ev.pair_number)
            : (ev.time_start || '');
        if (key) keys.add(key);
    }
    return keys.size;
}

function buildWeeks(byDate) {
    const dates = [...byDate.keys()].sort();
    if (dates.length === 0) return { weeks: [], maxPairs: 0, maxWeekPairs: 0 };

    const first = dateFromISO(dates[0]);
    const last  = dateFromISO(dates[dates.length - 1]);
    const start = startOfWeek(first);
    const end   = addDays(startOfWeek(last), 6);

    const weeks = [];
    let maxPairs = 0;
    let maxWeekPairs = 0;

    let cursor = new Date(start);
    let num = 1;

    while (cursor <= end) {
        const days = [];
        let weekPairs = 0;
        for (let i = 0; i < 7; i++) {
            const day = addDays(cursor, i);
            const iso = toISO(day);
            const events = byDate.get(iso) || [];
            const pairs = countPairs(events);
            if (pairs > maxPairs) maxPairs = pairs;
            weekPairs += pairs;
            days.push({ date: day, iso, events, pairs });
        }
        if (weekPairs > maxWeekPairs) maxWeekPairs = weekPairs;
        weeks.push({ num, start: new Date(cursor), days, pairs: weekPairs });
        num++;
        cursor = addDays(cursor, 7);
    }

    return { weeks, maxPairs, maxWeekPairs };
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function intensityStyle(pairs, maxPairs) {
    if (pairs <= 0) return null;
    const ratio = maxPairs > 0 ? pairs / maxPairs : 0;
    const pct = Math.round(10 + ratio * 80); // 10%..90%
    return {
        pct,
        background: `color-mix(in srgb, var(--accent) ${pct}%, var(--surface-2))`,
        dense: pct >= 55,
    };
}

/* ---------- публичный рендер ---------- */

export function renderLoad(root) {
    const byDate = groupByDate(state.filteredEvents);
    const { weeks, maxPairs, maxWeekPairs } = buildWeeks(byDate);

    if (weeks.length === 0) {
        root.appendChild(el('div', 'empty-state', 'Нет данных о нагрузке'));
        return;
    }

    const totalPairs = weeks.reduce((s, w) => s + w.pairs, 0);
    let activeDays = 0;
    let maxDayPairs = 0;
    for (const w of weeks) {
        for (const d of w.days) {
            if (d.pairs > 0) {
                activeDays++;
                if (d.pairs > maxDayPairs) maxDayPairs = d.pairs;
            }
        }
    }
    const avgPerActiveDay = activeDays > 0 ? (totalPairs / activeDays) : 0;

    const wrap = el('div', 'load-view');
    wrap.appendChild(buildStats({
        totalPairs,
        weeks: weeks.length,
        activeDays,
        avgPerActiveDay,
        maxDayPairs,
    }));
    wrap.appendChild(buildHeatmap(weeks, maxPairs));
    wrap.appendChild(buildBars(weeks, maxWeekPairs));

    root.appendChild(wrap);
}

/* ---------- stats ---------- */

function buildStats({ totalPairs, weeks, activeDays, avgPerActiveDay, maxDayPairs }) {
    const box = el('div', 'load-stats');
    const items = [
        { value: totalPairs,                label: 'всего пар' },
        { value: weeks,                     label: 'недель' },
        { value: activeDays,                label: 'дней с занятиями' },
        { value: avgPerActiveDay.toFixed(1), label: 'в среднем в день' },
        { value: maxDayPairs,               label: 'макс. в день' },
    ];
    for (const it of items) {
        const item = el('div', 'load-stat');
        item.appendChild(el('div', 'load-stat-value', String(it.value)));
        item.appendChild(el('div', 'load-stat-label', it.label));
        box.appendChild(item);
    }
    return box;
}

/* ---------- heatmap ---------- */

function buildHeatmap(weeks, maxPairs) {
    const box = el('div', 'load-heatmap');

    const header = el('div', 'load-heatmap-header');
    header.appendChild(el('div', 'load-heatmap-corner'));
    for (const name of WEEKDAYS_SHORT) {
        header.appendChild(el('div', 'load-heatmap-weekday', name));
    }
    box.appendChild(header);

    for (const w of weeks) {
        const row = el('div', 'load-heatmap-row');

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'load-heatmap-weeknum';
        label.textContent = String(w.num);
        label.title = `Неделя ${w.num}: ${w.pairs} пар`;
        label.addEventListener('click', async () => {
            const { navigateTo } = await import('./navigation.js');
            navigateTo('week', w.start);
        });
        row.appendChild(label);

        for (const d of w.days) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'load-cell';

            if (isToday(d.date)) cell.classList.add('is-today');
            if (d.pairs === 0) cell.classList.add('is-empty');

            const style = intensityStyle(d.pairs, maxPairs);
            if (style) {
                cell.style.background = style.background;
                if (style.dense) cell.classList.add('is-dense');
            }

            cell.appendChild(el('span', 'load-cell-day', String(d.date.getDate())));
            cell.appendChild(el('span', 'load-cell-count', d.pairs > 0 ? String(d.pairs) : ''));

            const dayLabel = `${d.date.getDate()} ${MONTHS_GEN[d.date.getMonth()]}`;
            cell.title = d.pairs > 0
                ? `${dayLabel}: ${d.pairs} пар`
                : `${dayLabel}: занятий нет`;

            if (d.events.length > 0) {
                cell.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (d.events.length === 1) {
                        showEventDetails(d.events[0], cell);
                    } else {
                        showGroupDetails(d.events, cell);
                    }
                });
            } else {
                cell.disabled = true;
            }

            row.appendChild(cell);
        }

        box.appendChild(row);
    }

    /* ----- легенда ----- */
    const legend = el('div', 'load-legend');
    legend.appendChild(el('span', 'load-legend-text', 'меньше'));
    const scale = el('div', 'load-legend-cells');
    for (const pct of [15, 30, 50, 70, 88]) {
        const s = document.createElement('span');
        s.style.background = `color-mix(in srgb, var(--accent) ${pct}%, var(--surface-2))`;
        scale.appendChild(s);
    }
    legend.appendChild(scale);
    legend.appendChild(el('span', 'load-legend-text', 'больше'));
    box.appendChild(legend);

    return box;
}

/* ---------- weekly bars ---------- */

function buildBars(weeks, maxWeekPairs) {
    const box = el('div', 'load-weekly');
    box.appendChild(el('h3', 'load-section-title', 'Нагрузка по неделям'));

    const bars = el('div', 'load-bars');
    for (const w of weeks) {
        const bar = el('div', 'load-bar');
        bar.title = `Неделя ${w.num}: ${w.pairs} пар`;

        const value = el('div', 'load-bar-value', String(w.pairs));

        const fillWrap = el('div', 'load-bar-fill-wrap');
        const fill = el('div', 'load-bar-fill');
        const pct = maxWeekPairs > 0 ? (w.pairs / maxWeekPairs) * 100 : 0;
        fill.style.height = Math.max(pct, w.pairs > 0 ? 3 : 0) + '%';
        fillWrap.appendChild(fill);

        const label = el('div', 'load-bar-label', String(w.num));

        bar.appendChild(value);
        bar.appendChild(fillWrap);
        bar.appendChild(label);
        bars.appendChild(bar);
    }
    box.appendChild(bars);
    return box;
}