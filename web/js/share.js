'use strict';

import { WEEKDAYS_SHORT, MONTHS_NOM } from './config.js';
import { pad, toISO, plainRooms, startOfWeek, addDays } from './utils.js';
import { groupByDate } from './data.js';

/* ============================================================
 *  ФОРМАТИРОВАНИЕ ТЕКСТА
 * ============================================================ */

function fmtFullDate(d) {
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function fmtShortDate(d) {
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

function fmtWeekday(d) {
    return WEEKDAYS_SHORT[(d.getDay() + 6) % 7];
}

/** Одна строка события: время — дисциплина (тип) · преп · аудитория */
function fmtEventLine(ev, short) {
    const type = ev.type ? ` (${ev.type})` : '';
    const title = `${ev.discipline}${type}`;

    if (short) {
        return `${ev.time_start} ${title}`;
    }

    const parts = [`${ev.time_start}–${ev.endTime} ${title}`];
    const teachers = (ev.teachers || []).filter(Boolean).join(', ');
    if (teachers) parts.push(teachers);
    const rooms = plainRooms(ev.rooms || '');
    if (rooms) parts.push(rooms);
    return parts.join(' · ');
}

function fmtDayBlock(dateObj, events, short) {
    if (!events || events.length === 0) return '';

    const head = short
        ? `${fmtWeekday(dateObj)} ${fmtShortDate(dateObj)}`
        : `${fmtWeekday(dateObj)} ${fmtFullDate(dateObj)}`;

    const lines = events
        .slice()
        .sort((a, b) => (a.time_start || '').localeCompare(b.time_start || ''))
        .map(ev => '  ' + fmtEventLine(ev, short));

    return head + '\n' + lines.join('\n');
}

/* ---------- публичные ---------- */

/** Текст для текущего вида: неделя / месяц / день. */
export function buildTextForView(view, currentDate, events) {
    const byDate = groupByDate(events || []);

    if (view === 'day') {
        return fmtDayBlock(currentDate, byDate.get(toISO(currentDate)) || [], false);
    }

    if (view === 'week') {
        const start = startOfWeek(currentDate);
        const blocks = [];
        for (let i = 0; i < 7; i++) {
            const d = addDays(start, i);
            const block = fmtDayBlock(d, byDate.get(toISO(d)) || [], false);
            if (block) blocks.push(block);
        }
        return blocks.join('\n\n');
    }

    if (view === 'month') {
        const y = currentDate.getFullYear();
        const m = currentDate.getMonth();
        const first = new Date(y, m, 1);
        const last  = new Date(y, m + 1, 0);
        const start = startOfWeek(first);
        const end   = addDays(startOfWeek(last), 7);

        const blocks = [];
        for (let d = new Date(start); d < end; d = addDays(d, 1)) {
            const block = fmtDayBlock(d, byDate.get(toISO(d)) || [], true);
            if (block) blocks.push(block);
        }
        return `${MONTHS_NOM[m]} ${y}\n\n` + blocks.join('\n\n');
    }

    return '';
}

/** Текст одного события (для поповера). */
export function buildTextForEvent(ev) {
    const d = ev.dateObj || new Date();
    const type = ev.type ? ` (${ev.type})` : '';
    const lines = [
        `${fmtWeekday(d)} ${fmtFullDate(d)}`,
        `${ev.time_start}–${ev.endTime} ${ev.discipline}${type}`,
    ];

    const teachers = (ev.teachers || []).filter(Boolean).join(', ');
    if (teachers) lines.push(teachers);

    const rooms = plainRooms(ev.rooms || '');
    if (rooms) lines.push(rooms);

    if (ev.group) lines.push(`Группа ${ev.group}`);

    return lines.join('\n');
}

/* ============================================================
 *  МЕНЮ ПОДЕЛИТЬСЯ
 * ============================================================ */

const ICON_LINK = `
    <svg class="icon" viewBox="0 0 24 24" width="18" height="18"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>`;

const ICON_TEXT = `
    <svg class="icon" viewBox="0 0 24 24" width="18" height="18"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
    </svg>`;

let currentMenu = null;
let currentCleanup = null;

function positionMenu(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    let left = rect.right - menuRect.width;
    let top  = rect.bottom + 6;

    if (left < 8) left = 8;
    if (left + menuRect.width > window.innerWidth - 8) {
        left = window.innerWidth - menuRect.width - 8;
    }
    if (top + menuRect.height > window.innerHeight - 8) {
        const flipped = rect.top - menuRect.height - 6;
        if (flipped >= 8) top = flipped;
    }

    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';
}

/**
 * Открывает меню «Скопировать ссылку / Скопировать текстом».
 * onLink / onText — колбэки; вызываются после клика и закрытия меню.
 */
export function openShareMenu(anchor, { onLink, onText } = {}) {
    closeShareMenu();

    const menu = document.createElement('div');
    menu.className = 'share-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
        <button class="share-menu-item" type="button" role="menuitem" data-action="link">
            ${ICON_LINK}
            <span>Скопировать ссылку</span>
        </button>
        <button class="share-menu-item" type="button" role="menuitem" data-action="text">
            ${ICON_TEXT}
            <span>Скопировать текстом</span>
        </button>
    `;

    document.body.appendChild(menu);
    positionMenu(menu, anchor);
    requestAnimationFrame(() => menu.classList.add('open'));

    const ac = new AbortController();
    const { signal } = ac;

    const onDocClick = (e) => {
        const item = e.target.closest && e.target.closest('.share-menu-item');
        if (item && menu.contains(item)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const action = item.dataset.action;
            closeShareMenu();

            if (action === 'link' && typeof onLink === 'function') onLink();
            else if (action === 'text' && typeof onText === 'function') onText();
            return;
        }
        if (!menu.contains(e.target)) closeShareMenu();
    };

    const onKey = (e) => { if (e.key === 'Escape') closeShareMenu(); };

    // Вешаем после текущего тика: клик, открывший меню, не должен его закрыть.
    setTimeout(() => {
        if (!currentMenu) return;
        document.addEventListener('click', onDocClick, true, { signal });
        document.addEventListener('keydown', onKey, { signal });
        window.addEventListener('resize', closeShareMenu, { signal });
        window.addEventListener('scroll', closeShareMenu, true, { signal });
    }, 0);

    currentMenu = menu;
    currentCleanup = () => { ac.abort(); menu.remove(); };
}

export function closeShareMenu() {
    const cleanup = currentCleanup;
    currentMenu = null;
    currentCleanup = null;
    if (cleanup) cleanup();
}