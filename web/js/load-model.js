'use strict';

/* ============================================================
 *  Нагрузка: общие пороги и единицы.
 *
 *  Вынесено из load-view.js, чтобы карточка нагрузки и модалка
 *  с деталями считали «низкую/среднюю/высокую» одинаково.
 * ============================================================ */

export const HOURS_PER_PAIR = 2;

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

export function levelFor(pairs) {
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
 */
export const WEEK_MAX_PAIRS = 27;
export const WEEK_LOW_PAIRS = Math.round(WEEK_MAX_PAIRS * 0.6);

export function weekLevelFor(pairs) {
    if (pairs <= 0) return 'empty';
    if (pairs > WEEK_MAX_PAIRS) return 'high';
    if (pairs > WEEK_LOW_PAIRS) return 'mid';
    return 'low';
}

/** Нормы семестра: 27 пар в неделю × число недель. */
export function semesterLevelFor(pairs, numWeeks) {
    if (pairs <= 0 || numWeeks <= 0) return 'empty';
    const max = WEEK_MAX_PAIRS * numWeeks;
    if (pairs > max)        return 'high';
    if (pairs > max * 0.6)  return 'mid';
    return 'low';
}

export function dowLevelFor(pairs, numWeeks) {
    if (pairs <= 0 || numWeeks <= 0) return 'empty';
    const max = (WEEK_MAX_PAIRS * numWeeks) / 7;
    if (pairs > max)        return 'high';
    if (pairs > max * 0.6)  return 'mid';
    return 'low';
}

export function toUnitValue(pairs, unit) {
    return unit === 'hours' ? pairs * HOURS_PER_PAIR : pairs;
}

export function unitShort(unit) {
    return unit === 'hours' ? 'ч' : 'пар';
}

export function unitWord(unit, value) {
    if (unit === 'hours') {
        const n = Math.abs(value);
        if (n % 10 === 1 && n % 100 !== 11) return 'час';
        if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'часа';
        return 'часов';
    }
    const n = Math.abs(value);
    if (n % 10 === 1 && n % 100 !== 11) return 'пара';
    if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'пары';
    return 'пар';
}

/** «5 пар · 10 часов» — значение с правильным словом. */
export function formatPairs(pairs, unit) {
    const value = toUnitValue(pairs, unit);
    return value + ' ' + unitWord(unit, value);
}

/**
 * Слово для дробного значения («2.3 пары», «5.5 пар»).
 * У дробных в русском почти всегда родительный падеж, но «2 пары»
 * читается лучше, чем «2 пар».
 */
export function unitWordApprox(unit, value) {
    if (Number.isInteger(value)) return unitWord(unit, value);
    const whole = Math.floor(Math.abs(value));
    const few = unit === 'hours' ? 'часа' : 'пары';
    const many = unit === 'hours' ? 'часов' : 'пар';
    const tail = whole % 100;
    const isFew = whole % 10 >= 1 && whole % 10 <= 4 && (tail < 10 || tail >= 20);
    return isFew ? few : many;
}

const DENSITY_LABEL = {
    empty: 'нет занятий',
    low: 'спокойный',
    mid: 'плотный',
    high: 'перегруз',
};

export function densityLabel(level) {
    return DENSITY_LABEL[level] || '';
}
