'use strict';

import { state } from './state.js';
import { toISO, startOfWeek, addDays, isToday } from './utils.js';
import { WEEKDAYS_SHORT, MONTHS_SHORT } from './config.js';
import { groupByDate } from './data.js';
import { navigateTo } from './navigation.js';
import { pluralRu } from './version.js';

/* ---------- константы ---------- */

const UNIT_KEY = 'schedule-load-unit';
const VIEW_KEY = 'schedule-load-view';
const HOURS_PER_PAIR = 2;

/**
 * Абсолютные пороги плотности ДНЯ (в парах).
 *   1–4 пары  → low  (2–8 ч)
 *   5 пар     → mid  (10 ч)
 *   6+ пар    → high (12+ ч) — перегруз
 */
const LEVELS = [
    { maxPairs: 4,        level: 'low'  },
    { maxPairs: 5,        level: 'mid'  },
    { maxPairs: Infinity, level: 'high' },
];

function levelFor(pairs) {
    if (pairs <= 0) return 'empty';
    for (const l of LEVELS) {
        if (pairs <= l.maxPairs) return l.level;
    }
    return 'high';
}

/**
 * Пороги плотности НЕДЕЛИ (в парах).
 *   54 ч (27 пар) — официальный максимум недельной нагрузки.
 *   Ниже 60% от него (16 пар ≈ 32 ч) — комфортная неделя.
 *
 * Оценка идёт по СУММЕ часов за неделю, а не по худшему дню:
 * одна загруженная суббота больше не красит всю неделю в красный.
 */
const WEEK_MAX_PAIRS = 27;
const WEEK_LOW_PAIRS = Math.round(WEEK_MAX_PAIRS * 0.6);

function weekLevelFor(pairs) {
    if (pairs <= 0) return 'empty';
    if (pairs > WEEK_MAX_PAIRS) return 'high';
    if (pairs > WEEK_LOW_PAIRS) return 'mid';
    return 'low';
}

/**
 * Нормы СЕМЕСТРА.
 *
 *   semesterMax = 27 пар (54 ч) × кол-во недель
 *   dowMax      = semesterMax / 7   — на один день недели за весь семестр
 *
 * Пороги mid/low — те же 60 % / 100 % от максимума, что и у недели,
 * чтобы визуальный язык оставался единым.
 */
function semesterLevelFor(pairs, numWeeks) {
    if (pairs <= 0 || numWeeks <= 0) return 'empty';
    const max = WEEK_MAX_PAIRS * numWeeks;
    if (pairs > max)        return 'high';
    if (pairs > max * 0.6)  return 'mid';
    return 'low';
}

function dowLevelFor(pairs, numWeeks) {
    if (pairs <= 0 || numWeeks <= 0) return 'empty';
    const max = (WEEK_MAX_PAIRS * numWeeks) / 7;
    if (pairs > max)        return 'high';
    if (pairs > max * 0.6)  return 'mid';
    return 'low';
}

function unit() {
    try {
        const v = localStorage.getItem(UNIT_KEY);
        return v === 'hours' ? 'hours' : 'pairs';
    } catch { return 'pairs'; }
}

function saveUnit(v) {
    try { localStorage.setItem(UNIT_KEY, v); } catch {}
}

function viewMode() {
    try {
        const v = localStorage.getItem(VIEW_KEY);
        return v === 'strip' ? 'strip' : 'map';
    } catch { return 'map'; }
}

function saveViewMode(v) {
    try { localStorage.setItem(VIEW_KEY, v); } catch {}
}

/* ---------- helpers ---------- */

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function dateFromISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}

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

function formatWeekRange(start, end) {
    const sameMonth = start.getMonth() === end.getMonth();
    const sameYear  = start.getFullYear() === end.getFullYear();
    const mS = MONTHS_SHORT[start.getMonth()];
    const mE = MONTHS_SHORT[end.getMonth()];

    if (sameMonth && sameYear) return start.getDate() + '–' + end.getDate() + ' ' + mS;
    if (sameYear) return start.getDate() + ' ' + mS + ' – ' + end.getDate() + ' ' + mE;

    const yS = String(start.getFullYear()).slice(-2);
    const yE = String(end.getFullYear()).slice(-2);
    return start.getDate() + ' ' + mS + ' ' + yS + ' – ' + end.getDate() + ' ' + mE + ' ' + yE;
}

function buildWeeks(byDate) {
    const dates = [...byDate.keys()].sort();
    if (dates.length === 0) return { weeks: [] };

    const first = dateFromISO(dates[0]);
    const last  = dateFromISO(dates[dates.length - 1]);
    const start = startOfWeek(first);
    const end   = addDays(startOfWeek(last), 6);

    const weeks = [];
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
            weekPairs += pairs;
            days.push({ date: day, iso, events, pairs });
        }
        weeks.push({
            num,
            start: new Date(cursor),
            end:   addDays(cursor, 6),
            days,
            pairs: weekPairs,
        });
        num++;
        cursor = addDays(cursor, 7);
    }

    return { weeks };
}

function toUnitValue(pairs, u) {
    return u === 'hours' ? pairs * HOURS_PER_PAIR : pairs;
}

function unitShort(u) {
    return u === 'hours' ? 'ч' : 'пар';
}

/* ---------- публичный рендер ---------- */

export function renderLoad(root) {
    const u = unit();
    const byDate = groupByDate(state.filteredEvents);
    const { weeks } = buildWeeks(byDate);

    if (weeks.length === 0) {
        root.appendChild(el('div', 'empty-state', 'Нет данных о нагрузке'));
        return;
    }

    let totalPairs = 0;
    let activeDays = 0;
    let maxWeekPairs = 0;
    let overloadWeeks = 0;

    for (const w of weeks) {
        totalPairs += w.pairs;
        if (w.pairs > maxWeekPairs) maxWeekPairs = w.pairs;
        if (weekLevelFor(w.pairs) === 'high') overloadWeeks++;
        for (const d of w.days) {
            if (d.pairs > 0) activeDays++;
        }
    }
    const avgPairs = activeDays > 0 ? totalPairs / activeDays : 0;

    const wrap = el('div', 'load-view');
    wrap.appendChild(buildHeader({
        u,
        totalPairs,
        weeksCount: weeks.length,
        activeDays,
        avgPairs,
        overloadWeeks,
    }));

    const mode = viewMode();
    const main = el('div', 'load-main');

    if (mode === 'strip') {
        main.appendChild(buildStripView(weeks, u, maxWeekPairs));
    } else {
        main.appendChild(buildHeatmapCard(weeks, u));
    }

    main.appendChild(buildInsights(weeks, u));
    wrap.appendChild(main);

    root.appendChild(wrap);
}

/* ============================================================
 *  HEADER
 * ============================================================ */

function buildHeader({ u, totalPairs, weeksCount, activeDays, avgPairs, overloadWeeks }) {
    const header = el('div', 'load-header');

    const left = el('div', 'load-header-left');
    left.appendChild(el('h2', 'load-title', 'Нагрузка за семестр'));

    const summary = el('div', 'load-summary');
    const sep = () => summary.appendChild(el('span', 'load-summary-sep', '·'));
    const add = (value, label) => {
        summary.appendChild(el('b', null, String(value)));
        summary.appendChild(el('span', null, ' ' + label));
    };

    const totalV = toUnitValue(totalPairs, u);
    const avgV   = toUnitValue(avgPairs, u);

    const totalWord = u === 'hours'
        ? pluralRu(totalV, 'час', 'часа', 'часов')
        : pluralRu(totalV, 'пара', 'пары', 'пар');

    add(totalV, totalWord);
    sep();
    add(weeksCount, pluralRu(weeksCount, 'неделя', 'недели', 'недель'));
    sep();
    add(activeDays, 'дней занятий');
    sep();
    add(avgV.toFixed(1), 'в среднем в день');

    if (overloadWeeks > 0) {
        sep();
        const warn = el('span', 'load-summary-warn');
        warn.textContent =
            '⚠ ' + overloadWeeks + ' ' +
            pluralRu(overloadWeeks, 'неделя', 'недели', 'недель') +
            ' с перегрузом';
        summary.appendChild(warn);
    }

    left.appendChild(summary);
    header.appendChild(left);

    const controls = el('div', 'load-header-controls');
    controls.appendChild(buildUnitToggle(u));
    controls.appendChild(buildViewToggle(viewMode()));
    header.appendChild(controls);

    return header;
}

function buildUnitToggle(current) {
    const box = el('div', 'load-unit-toggle');
    box.setAttribute('role', 'tablist');
    box.setAttribute('aria-label', 'Единицы измерения');

    const btn = (value, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'load-unit-btn' + (current === value ? ' is-active' : '');
        b.dataset.unit = value;
        b.textContent = label;
        b.setAttribute('aria-pressed', current === value ? 'true' : 'false');
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            if (unit() === value) return;
            saveUnit(value);
            import('./render.js').then(m => m.render());
        });
        return b;
    };

    box.appendChild(btn('pairs', 'Пары'));
    box.appendChild(btn('hours', 'Часы'));
    return box;
}

function buildViewToggle(current) {
    const box = el('div', 'load-view-toggle');
    box.setAttribute('role', 'tablist');
    box.setAttribute('aria-label', 'Вид нагрузки');

    const btn = (value, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'load-view-btn' + (current === value ? ' is-active' : '');
        b.dataset.view = value;
        b.textContent = label;
        b.setAttribute('aria-pressed', current === value ? 'true' : 'false');
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            if (viewMode() === value) return;
            saveViewMode(value);
            import('./render.js').then(m => m.render());
        });
        return b;
    };

    box.appendChild(btn('map', 'Карта'));
    box.appendChild(btn('strip', 'Шкала'));
    return box;
}

/* ============================================================
 *  HEATMAP CARD
 * ============================================================ */

function buildHeatmapCard(weeks, u) {
    const card = el('section', 'load-heatmap-card');

    const head = el('div', 'load-heatmap-head');
    head.appendChild(el('span', 'load-heatmap-title', 'Карта нагрузки'));
    card.appendChild(head);

    const scroll = el('div', 'load-heatmap-scroll');
    const grid = el('div', 'load-heatmap');
    grid.style.setProperty('--weeks', String(weeks.length));
    scroll.appendChild(grid);
    card.appendChild(scroll);

    const todayIso = toISO(new Date());
    const selectedIso = toISO(state.currentDate);

    /* --- левая боковая колонка: ПН..ВС + Σ --- */
    const left = el('div', 'load-hm-col load-hm-col--side');
    left.appendChild(el('div', 'load-hm-corner'));
    for (const name of WEEKDAYS_SHORT) {
        left.appendChild(el('div', 'load-hm-dow', name));
    }
    left.appendChild(el('div', 'load-hm-sum-label', 'Σ'));
    grid.appendChild(left);

    /* --- колонки недель --- */
    for (const w of weeks) {
        grid.appendChild(buildWeekColumn(w, u, todayIso, selectedIso));
    }

    /* --- правая боковая колонка: Σ + row sums + grand total --- */
    const right = el('div', 'load-hm-col load-hm-col--side load-hm-col--side-right');
    right.appendChild(el('div', 'load-hm-sigma-head', 'Σ'));

    const numWeeks = weeks.length;
    let grandTotal = 0;
    for (let dow = 0; dow < 7; dow++) {
        let dowSum = 0;
        for (const w of weeks) dowSum += w.days[dow].pairs;
        right.appendChild(buildRowSumCell(dowSum, u, numWeeks));
    }
    for (const w of weeks) grandTotal += w.pairs;

    const grandTotalEl = el('div', 'load-hm-grand-total', String(toUnitValue(grandTotal, u)));
    const gtLevel = semesterLevelFor(grandTotal, numWeeks);
    if (gtLevel === 'mid')       grandTotalEl.classList.add('is-mid');
    else if (gtLevel === 'high') grandTotalEl.classList.add('is-high');
    right.appendChild(grandTotalEl);
    grid.appendChild(right);

    /* --- легенда --- */
    card.appendChild(buildLegend(u));

    return card;
}

function buildWeekColumn(w, u, todayIso, selectedIso) {
    const containsToday    = w.days.some(d => d.iso === todayIso);
    const containsSelected = w.days.some(d => d.iso === selectedIso);

    const col = el('div', 'load-hm-col load-hm-col--week');
    if (containsToday)    col.classList.add('is-current');
    if (containsSelected) col.classList.add('is-selected');

    /* номер недели */
    const numBtn = document.createElement('button');
    numBtn.type = 'button';
    numBtn.className = 'load-hm-weeknum';
    if (containsToday)    numBtn.classList.add('is-current');
    if (containsSelected) numBtn.classList.add('is-selected');
    numBtn.textContent = String(w.num);
    numBtn.title = 'Неделя ' + w.num + ' (' + formatWeekRange(w.start, w.end) + ') — открыть';
    numBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateTo('week', w.start);
    });
    col.appendChild(numBtn);

    /* 7 дней */
    for (const d of w.days) {
        col.appendChild(buildDayCell(d, u, selectedIso));
    }

    /* итог недели */
    col.appendChild(buildTotalCell(w, u, containsSelected));

    return col;
}

function buildDayCell(d, u, selectedIso) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'load-hm-cell';

    const level = levelFor(d.pairs);
    const isSelected = d.iso === selectedIso;
    const isTodayCell = isToday(d.date);

    if (d.pairs > 0) {
        btn.classList.add('is-' + level);
        btn.textContent = String(toUnitValue(d.pairs, u));
    }

    if (isTodayCell) btn.classList.add('is-today');
    if (isSelected)  btn.classList.add('is-selected-day');

    if (d.pairs > 0) {
        const label = d.date.getDate() + ' ' + MONTHS_SHORT[d.date.getMonth()];
        const val = u === 'hours'
            ? toUnitValue(d.pairs, u) + ' ч'
            : d.pairs + ' пар';
        btn.title = label + ': ' + val + ' — открыть день';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigateTo('day', d.date);
        });
    } else {
        btn.disabled = true;
        btn.title = d.date.getDate() + ' ' + MONTHS_SHORT[d.date.getMonth()] + ': занятий нет';
    }

    return btn;
}

function buildTotalCell(w, u, isSelected) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'load-hm-total';

    // Уровень недели — по СУММЕ часов (пар) за неделю,
    // а не по худшему дню. Порог 54 ч = 27 пар.
    const level = weekLevelFor(w.pairs);

    if (level === 'empty')      btn.classList.add('is-zero');
    else if (level === 'high')  btn.classList.add('is-high');
    else if (level === 'mid')   btn.classList.add('is-mid');

    if (isSelected && w.pairs > 0) btn.classList.add('is-selected');

    const v = toUnitValue(w.pairs, u);
    btn.textContent = String(v);

    btn.title = w.pairs > 0
        ? 'Неделя ' + w.num + ': ' + v + ' ' + unitShort(u) + ' — открыть'
        : 'Неделя ' + w.num + ': занятий нет';

    if (w.pairs === 0) {
        btn.disabled = true;
    } else {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigateTo('week', w.start);
        });
    }

    return btn;
}

function buildRowSumCell(dowSumPairs, u, numWeeks) {
    const cell = el('div', 'load-hm-row-sum');
    const v = toUnitValue(dowSumPairs, u);
    cell.textContent = v > 0 ? String(v) : '·';

    const level = dowLevelFor(dowSumPairs, numWeeks);
    if (level === 'high')      cell.classList.add('is-high');
    else if (level === 'mid')  cell.classList.add('is-mid');

    return cell;
}

/* ============================================================
 *  STRIP VIEW — шкала по неделям
 * ============================================================ */

function buildStripView(weeks, u, maxWeekPairs) {
    const card = el('section', 'load-strip-view');

    const head = el('div', 'load-strip-view-head');
    head.appendChild(el('span', 'load-strip-view-title', 'Шкала по неделям'));
    card.appendChild(head);

    const bars = el('div', 'load-strip-view-bars');
    for (const w of weeks) {
        bars.appendChild(buildStripBar(w, u, maxWeekPairs));
    }
    card.appendChild(bars);

    card.appendChild(buildLegend(u));

    return card;
}

function buildStripBar(w, u, maxWeekPairs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'load-strip-bar';

    const ratio = maxWeekPairs > 0 ? w.pairs / maxWeekPairs : 0;
    const h = w.pairs > 0 ? Math.max(4, Math.round(4 + ratio * 88)) : 3;

    // Уровень — по сумме за неделю, аналогично клеткам Σ.
    const level = weekLevelFor(w.pairs);

    const v = toUnitValue(w.pairs, u);
    btn.appendChild(el('div', 'load-strip-bar-value', String(v)));

    const fillWrap = el('div', 'load-strip-bar-fill-wrap');
    const fill = el('div', 'load-strip-bar-fill');
    if (level === 'mid')  fill.classList.add('is-mid');
    if (level === 'high') fill.classList.add('is-high');
    fill.style.height = h + '%';
    fillWrap.appendChild(fill);
    btn.appendChild(fillWrap);

    btn.appendChild(el('div', 'load-strip-bar-label', String(w.num)));

    btn.title = 'Неделя ' + w.num + ' (' + formatWeekRange(w.start, w.end) + ') · ' + v + ' ' + unitShort(u);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateTo('week', w.start);
    });

    return btn;
}

/* ============================================================
 *  INSIGHTS PANEL
 * ============================================================ */

function buildInsights(weeks, u) {
    const aside = el('aside', 'load-insights');

    const allDays = [];
    for (const w of weeks) {
        for (const d of w.days) {
            if (d.pairs > 0) allDays.push({ ...d, weekNum: w.num });
        }
    }
    const top = [...allDays].sort((a, b) => b.pairs - a.pairs).slice(0, 5);
    aside.appendChild(buildTopDaysCard(top, u));

    // Перегруженные недели — по той же логике, что и цвет клеток Σ.
    const overloaded = weeks
        .filter(w => weekLevelFor(w.pairs) === 'high')
        .map(w => ({
            week: w,
            highDays: w.days.filter(d => levelFor(d.pairs) === 'high').length,
        }));
    aside.appendChild(buildOverloadCard(overloaded, u));

    return aside;
}

function markOverflow(card, list) {
    requestAnimationFrame(() => {
        if (list.scrollHeight > list.clientHeight + 2) {
            card.classList.add('has-overflow');
        }
    });
}

function buildTopDaysCard(days, u) {
    const card = el('section', 'load-insight-card');
    const head = el('h3', 'load-insight-title', 'Топ загруженных дней');
    card.appendChild(head);

    if (days.length === 0) {
        card.appendChild(el('div', 'load-insight-empty', 'Нет данных'));
        return card;
    }

    const list = el('ul', 'load-insight-list');
    for (const d of days) {
        const level = levelFor(d.pairs);
        const li = el('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'load-insight-item'
            + (level === 'high' ? ' is-high' : level === 'mid' ? ' is-mid' : '');

        const main = el('div', 'load-insight-item-main');
        const dowName = WEEKDAYS_SHORT[(d.date.getDay() + 6) % 7];
        const dateStr = d.date.getDate() + ' ' + MONTHS_SHORT[d.date.getMonth()];
        main.appendChild(el('div', 'load-insight-item-date', dowName + ', ' + dateStr));
        main.appendChild(el('div', 'load-insight-item-sub', 'Неделя ' + d.weekNum));
        btn.appendChild(main);

        const v = toUnitValue(d.pairs, u);
        btn.appendChild(el('div', 'load-insight-item-value', v + ' ' + unitShort(u)));

        btn.title = 'Открыть ' + dateStr;
        btn.addEventListener('click', () => navigateTo('day', d.date));

        li.appendChild(btn);
        list.appendChild(li);
    }
    card.appendChild(list);
    markOverflow(card, list);

    return card;
}

function buildOverloadCard(items, u) {
    const card = el('section', 'load-insight-card');
    const head = el('h3', 'load-insight-title');
    head.appendChild(el('span', null, 'Недели с перегрузом'));
    head.appendChild(el('span', 'load-insight-count', String(items.length)));
    card.appendChild(head);

    if (items.length === 0) {
        card.appendChild(el('div', 'load-insight-empty', 'Перегруженных недель нет'));
        return card;
    }

    const list = el('ul', 'load-insight-list');
    for (const item of items) {
        const week = item.week;
        const highDays = item.highDays;
        const li = el('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'load-insight-item is-high';

        const main = el('div', 'load-insight-item-main');
        main.appendChild(el('div', 'load-insight-item-date', 'Неделя ' + week.num));
        main.appendChild(el('div', 'load-insight-item-sub',
            highDays + ' ' + pluralRu(highDays, 'день', 'дня', 'дней') + ' с 6+ парами'));
        btn.appendChild(main);

        const v = toUnitValue(week.pairs, u);
        btn.appendChild(el('div', 'load-insight-item-value', v + ' ' + unitShort(u)));

        btn.title = 'Открыть неделю ' + week.num + ' (' + formatWeekRange(week.start, week.end) + ')';
        btn.addEventListener('click', () => navigateTo('week', week.start));

        li.appendChild(btn);
        list.appendChild(li);
    }
    card.appendChild(list);
    markOverflow(card, list);

    return card;
}

/* ============================================================
 *  LEGEND
 * ============================================================ */

function buildLegend(u) {
    const box = el('div', 'load-legend');

    const item = (level, text, warn) => {
        const it = el('span', 'load-legend-item');
        it.appendChild(el('span', 'load-legend-dot is-' + level));
        if (warn) {
            it.appendChild(el('span', 'load-legend-warn', text));
        } else {
            it.appendChild(el('span', null, text));
        }
        return it;
    };

    if (u === 'hours') {
        box.appendChild(item('low',  '2–8 ч'));
        box.appendChild(item('mid',  '10 ч'));
        box.appendChild(item('high', '12+ ч — перегруз', true));
    } else {
        box.appendChild(item('low',  '1–4 пары'));
        box.appendChild(item('mid',  '5 пар'));
        box.appendChild(item('high', '6+ пар — перегруз', true));
    }

    return box;
}