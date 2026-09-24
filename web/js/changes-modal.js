'use strict';

import { addMinutes } from './utils.js';
import { PAIR_MINUTES } from './config.js';
import { showEventDetails } from './popover.js';

const PAGE_SIZE = 50;

let allChanges = [];
let shownCount = 0;

function expandEntry(entry) {
    const firstDate = (entry.dates && entry.dates[0]) || '';
    const parts = firstDate.split('.').map(Number);
    const dateObj = parts.length === 3
        ? new Date(parts[2], parts[1] - 1, parts[0])
        : new Date();

    return {
        ...entry,
        dateObj,
        endTime: entry.time_end || addMinutes(entry.time_start, PAIR_MINUTES),
        dateISO: firstDate,
        uniqueId: `${entry.event_id || entry.key}__${firstDate}`,
    };
}

function buildHeaderText(change) {
    const ev = change.new || change.old;
    const label = { added: '➕ Добавлено', removed: '➖ Удалено', changed: '✏ Изменено' }[change.type];

    const parts = [];
    if (ev.group) parts.push(ev.group);
    if (ev.weekday) parts.push(ev.weekday);
    if (ev.pair_number) parts.push(`${ev.pair_number}-я пара`);

    return parts.length ? `${label} — ${parts.join(', ')}` : label;
}

/** Возвращает field по имени из change.fields, или null. */
function findField(change, name) {
    return (change.fields || []).find(f => f.name === name) || null;
}

/** Строит строку с точечной подсветкой по массиву значений. */
function buildArrayLine(values, onlyThis, onlyOther, diffClass) {
    const line = document.createElement('div');
    line.className = 'changes-event-meta';

    values.forEach((v, i) => {
        if (i > 0) line.appendChild(document.createTextNode(', '));
        const sp = document.createElement('span');
        if (onlyThis.has(v)) sp.className = diffClass;
        sp.textContent = v;
        line.appendChild(sp);
    });

    return line;
}

/** Строит строку с подсветкой всего значения (для time_start/time_end/comment). */
function buildScalarLine(value, changed, diffClass) {
    const line = document.createElement('div');
    line.className = 'changes-event-meta';
    if (changed) {
        const sp = document.createElement('span');
        sp.className = diffClass;
        sp.textContent = value;
        line.appendChild(sp);
    } else {
        line.textContent = value;
    }
    return line;
}

/** Заполняет родителя содержимым события. */
function fillEventContent(parent, entry, change, side) {
    const diffClass = side === 'old' ? 'changes-diff-old' : 'changes-diff-new';

    // Заголовок — дисциплина и тип
    const title = document.createElement('div');
    title.className = 'changes-event-title';
    title.textContent = entry.discipline + (entry.type ? ` (${entry.type})` : '');
    parent.appendChild(title);

    // Время
    const timeField = findField(change, 'time_start') || findField(change, 'time_end');
    const timeStr = `${entry.time_start || '—'}–${entry.time_end || '—'}`;
    parent.appendChild(buildScalarLine(timeStr, !!timeField, diffClass));

    // Даты
    if (entry.dates && entry.dates.length) {
        const datesField = findField(change, 'dates');
        if (datesField) {
            const onlyThis = new Set(side === 'old' ? datesField.onlyOld : datesField.onlyNew);
            const onlyOther = new Set(side === 'old' ? datesField.onlyNew : datesField.onlyOld);
            parent.appendChild(buildArrayLine(entry.dates, onlyThis, onlyOther, diffClass));
        } else {
            parent.appendChild(buildArrayLine(entry.dates, new Set(), new Set(), diffClass));
        }
    }

    // Аудитории
    if (entry.rooms) {
        const roomsField = findField(change, 'rooms');
        if (roomsField) {
            const roomsArr = String(entry.rooms).split(',').map(s => s.trim()).filter(Boolean);
            const onlyThis = new Set(side === 'old' ? roomsField.onlyOld : roomsField.onlyNew);
            parent.appendChild(buildArrayLine(roomsArr, onlyThis, new Set(), diffClass));
        } else {
            parent.appendChild(buildScalarLine(entry.rooms, false, diffClass));
        }
    }

    // Преподаватели
    if (entry.teachers && entry.teachers.length) {
        const teachersField = findField(change, 'teachers');
        if (teachersField) {
            const onlyThis = new Set(side === 'old' ? teachersField.onlyOld : teachersField.onlyNew);
            parent.appendChild(buildArrayLine(entry.teachers, onlyThis, new Set(), diffClass));
        } else {
            parent.appendChild(buildArrayLine(entry.teachers, new Set(), new Set(), diffClass));
        }
    }

    // Комментарий
    if (entry.comment) {
        const commentField = findField(change, 'comment');
        parent.appendChild(buildScalarLine(entry.comment, !!commentField, diffClass));
    }
}

/* ---------- Added / Removed — одна карточка во всю ширину ---------- */
function makeFullCard(change) {
    const card = document.createElement('div');
    card.className = 'changes-event-card';

    const entry = change.new || change.old;
    const side = change.type === 'added' ? 'new' : 'old';
    fillEventContent(card, entry, change, side);

    card.addEventListener('click', (e) => {
        e.stopPropagation();
        showEventDetails(expandEntry(entry), card);
    });

    return card;
}

/* ---------- Changed — одна колонка (Было или Стало) ---------- */
function makeChangedCol(change, side) {
    const col = document.createElement('div');
    col.className = 'changes-changed-col';

    const label = document.createElement('div');
    label.className = 'changes-col-label';
    label.textContent = side === 'old' ? 'Было' : 'Стало';
    col.appendChild(label);

    const entry = side === 'old' ? change.old : change.new;

    if (!entry) {
        const empty = document.createElement('div');
        empty.className = 'changes-col-empty';
        empty.textContent = side === 'old' ? 'Не было' : 'Не стало';
        col.appendChild(empty);
        return col;
    }

    fillEventContent(col, entry, change, side);

    col.addEventListener('click', (e) => {
        e.stopPropagation();
        showEventDetails(expandEntry(entry), col);
    });

    return col;
}

/* ---------- Сборка одной карточки изменения ---------- */
function makeChangeCard(change) {
    const item = document.createElement('div');
    item.className = 'changes-item changes-item--' + change.type;

    const header = document.createElement('div');
    header.className = 'changes-item-header';
    header.textContent = buildHeaderText(change);
    item.appendChild(header);

    if (change.type === 'changed') {
        const row = document.createElement('div');
        row.className = 'changes-changed-row';
        row.appendChild(makeChangedCol(change, 'old'));
        row.appendChild(makeChangedCol(change, 'new'));
        item.appendChild(row);
    } else {
        item.appendChild(makeFullCard(change));
    }

    return item;
}

function renderList() {
    const body = document.getElementById('changesBody');
    const footer = document.getElementById('changesFooter');
    const moreBtn = document.getElementById('changesMore');

    body.innerHTML = '';

    if (allChanges.length === 0) {
        body.innerHTML = '<div class="changes-empty">Изменений с прошлого визита нет</div>';
        footer.hidden = true;
        return;
    }

    const list = document.createElement('div');
    list.className = 'changes-list';
    const toShow = allChanges.slice(0, shownCount);
    for (const change of toShow) {
        list.appendChild(makeChangeCard(change));
    }
    body.appendChild(list);

    if (allChanges.length > shownCount) {
        footer.hidden = false;
        moreBtn.textContent = `Показать ещё (осталось ${allChanges.length - shownCount})`;
    } else {
        footer.hidden = true;
    }
}

export function setupChangesModal() {
    const modal = document.getElementById('changesModal');
    const closeBtn = modal.querySelector('.changes-close');
    const moreBtn = document.getElementById('changesMore');

    function close() {
        modal.classList.remove('open');
    }

    function open(changes) {
        allChanges = changes || [];
        shownCount = Math.min(PAGE_SIZE, allChanges.length);
        renderList();
        modal.classList.add('open');
    }

    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });

    moreBtn.addEventListener('click', () => {
        shownCount += PAGE_SIZE;
        renderList();
    });

    return { open, close };
}