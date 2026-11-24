'use strict';

import { state } from './state.js';

/* ============================================================
 *  Общие детали фильтров.
 *
 *  Главный фильтр, настройки уведомлений и выбор группы
 *  в «Оригинале» выглядят по-разному (панель, модалка, стрелка),
 *  но собраны из одних и тех же кусков: поиск, строка-вариант,
 *  чипы выбранного, чипы факультетов, заголовок колонки.
 *  Так они ведут себя одинаково и не разъезжаются по стилю.
 * ============================================================ */

export const CHECK_ICON = `
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none"
         stroke="currentColor" stroke-width="2.2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="3 8.5 6.5 12 13 4.5"/>
    </svg>`;

export const STAR_ICON = `
    <svg viewBox="0 0 24 24" width="14" height="14"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>`;

export const SEARCH_ICON = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
         stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>`;

/** «5 групп», «1 преподаватель» — склонение по числу. */
export function pluralRu(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

export function normalizeQuery(value) {
    return String(value || '').trim().toLowerCase();
}

export function matchesQuery(label, query) {
    const q = normalizeQuery(query);
    return !q || String(label || '').toLowerCase().includes(q);
}

/* ============================================================
 *  ФАКУЛЬТЕТЫ КАК ОБЛАСТЬ ВИДИМОСТИ
 * ============================================================ */

/** К каким факультетам относится группа или преподаватель. */
export function facultyIdsOf(type, value) {
    const map = type === 'group'
        ? state.groupFaculties
        : state.teacherFaculties;
    return (map && map.get(value)) || null;
}

/** Входит ли значение в выбранные факультеты (пустой выбор — все). */
export function inFacultyScope(type, value, scope) {
    if (!scope || scope.size === 0) return true;
    const ids = facultyIdsOf(type, value);
    if (!ids || ids.size === 0) return true;
    for (const id of ids) {
        if (scope.has(String(id))) return true;
    }
    return false;
}

/** Значения под поиском и в выбранных факультетах. */
export function valuesInScope(type, query, scope) {
    const all = type === 'group' ? state.groups : state.teachers;
    return (all || []).filter(
        value => matchesQuery(value, query) && inFacultyScope(type, value, scope),
    );
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/* ============================================================
 *  ПОИСК
 * ============================================================ */

/**
 * Поле поиска с крестиком внутри. Крестик появляется, когда есть
 * текст, — лишних подписей не нужно.
 */
export function createSearch({ placeholder = '', onInput }) {
    const wrap = el('label', 'filter-search-wrap');

    const icon = el('span', 'filter-search-icon');
    icon.innerHTML = SEARCH_ICON;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'filter-search';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder || 'Поиск');

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'filter-search-clear';
    clear.textContent = '×';
    clear.setAttribute('aria-label', 'Очистить поиск');
    clear.tabIndex = -1;

    const sync = () => {
        clear.hidden = !input.value;
    };

    input.addEventListener('input', () => {
        sync();
        onInput(input.value);
    });
    clear.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        input.value = '';
        sync();
        onInput('');
        input.focus();
    });
    sync();

    wrap.append(icon, input, clear);

    return {
        element: wrap,
        input,
        setValue(value) {
            input.value = value;
            sync();
        },
    };
}

/* ============================================================
 *  СТРОКА-ВАРИАНТ
 * ============================================================ */

/**
 * Один вариант в списке: галочка, название и (необязательно)
 * звёздочка избранного. Строка остаётся на месте после выбора —
 * список не прыгает под курсором.
 */
export function createOption({
    value,
    label,
    checked = false,
    hint = '',
    favorite = null,
    onToggle,
}) {
    const row = document.createElement('label');
    row.className = 'filter-option';
    row.classList.toggle('is-selected', checked);
    row.title = hint || label;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'filter-option-input';
    input.checked = checked;
    input.value = value;
    input.addEventListener('change', () => {
        row.classList.toggle('is-selected', input.checked);
        if (onToggle) onToggle(input.checked);
    });

    const check = el('span', 'filter-option-check');
    check.innerHTML = CHECK_ICON;
    check.setAttribute('aria-hidden', 'true');

    const text = el('span', 'filter-option-value', label);

    row.append(input, check, text);

    if (favorite) {
        const star = document.createElement('button');
        star.type = 'button';
        star.className = 'favorite-star';
        star.innerHTML = STAR_ICON;

        const syncStar = () => {
            star.classList.toggle('is-favorite', !!favorite.active());
            star.setAttribute(
                'aria-label',
                favorite.active() ? 'Убрать из избранного' : 'В избранное',
            );
            star.querySelector('svg').setAttribute(
                'fill', favorite.active() ? 'currentColor' : 'none',
            );
        };
        syncStar();

        star.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            favorite.toggle();
            syncStar();
        });

        row.appendChild(star);
    }

    return row;
}

/** «Не найдено» и другие пустые состояния списка. */
export function createEmptyRow(text) {
    return el('div', 'filter-option-empty', text);
}

/* ============================================================
 *  ЧИПЫ
 * ============================================================ */

/** Чип выбранного значения с крестиком: клик по чипу убирает фильтр. */
export function createSelectedChip({ label, title = '', kind = '', onRemove }) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'filter-selected-card' + (kind ? ' filter-selected-card--' + kind : '');
    chip.title = title || ('Убрать: ' + label);
    chip.setAttribute('aria-label', 'Убрать фильтр: ' + label);

    chip.appendChild(el('span', 'filter-selected-card-label', label));

    const cross = el('span', 'filter-selected-card-x', '×');
    cross.setAttribute('aria-hidden', 'true');
    chip.appendChild(cross);

    chip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onRemove();
    });

    return chip;
}

/** Чип факультета: название и число групп. */
export function createFacultyChip({ label, count, title = '', active = false, onClick }) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'filter-faculty-chip' + (active ? ' is-active' : '');
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    chip.title = title || label;

    chip.appendChild(el('span', 'filter-faculty-name', label));

    if (count != null) {
        chip.appendChild(el('span', 'filter-faculty-count', String(count)));
    }

    chip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
    });

    return chip;
}

/* ============================================================
 *  ЗАГОЛОВОК КОЛОНКИ
 * ============================================================ */

/**
 * Заголовок колонки: название, «сколько выбрано из скольких»
 * и кнопка «Все / Снять». Кнопка говорит сама за себя —
 * никаких пояснений рядом не нужно.
 */
export function createColumnHead({ title, selected = 0, total = 0, onToggleAll }) {
    const head = el('div', 'filter-column-head');
    head.appendChild(el('span', 'filter-column-title', title));

    const tools = el('span', 'filter-column-tools');

    if (total > 0 && selected > 0) {
        tools.appendChild(el('span', 'filter-column-count', selected + '/' + total));
    }

    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'filter-column-all';
    const allSelected = total > 0 && selected >= total;
    all.textContent = allSelected ? 'Снять' : 'Все';
    all.disabled = total === 0;
    all.classList.toggle('is-on', allSelected);
    all.setAttribute(
        'aria-label',
        allSelected ? 'Снять все: ' + title.toLowerCase() : 'Выбрать все: ' + title.toLowerCase(),
    );
    if (onToggleAll) {
        all.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleAll();
        });
    }

    tools.appendChild(all);
    head.appendChild(tools);
    return head;
}
