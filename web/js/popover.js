'use strict';

import { MONTHS_GEN } from './config.js';
import { escapeHtml, renderRoomsLinks } from './utils.js';

export function positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = rect.right + 8;
    let top = rect.top;
    if (left + popRect.width > window.innerWidth - 8) left = rect.left - popRect.width - 8;
    if (left < 8) left = 8;
    if (top + popRect.height > window.innerHeight - 8) top = window.innerHeight - popRect.height - 8;
    if (top < 8) top = 8;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
}

export function eventDetailsHtml(ev) {
    const titleText = ev.discipline + (ev.type ? ` (${ev.type})` : '');
    return `
        <h3>${escapeHtml(titleText)}</h3>
        <div class="popover-row"><span class="label">Время</span><span>${ev.time_start} – ${ev.endTime}</span></div>
        <div class="popover-row"><span class="label">Дата</span><span>${ev.dateObj.getDate()} ${MONTHS_GEN[ev.dateObj.getMonth()]} ${ev.dateObj.getFullYear()}</span></div>
        ${ev.rooms ? `<div class="popover-row"><span class="label">Место</span><span>${renderRoomsLinks(ev.rooms)}</span></div>` : ''}
        ${ev.teachers && ev.teachers.length ? `<div class="popover-row"><span class="label">Преподаватель</span><span>${escapeHtml(ev.teachers.join(', '))}</span></div>` : ''}
        <div class="popover-row"><span class="label">Группа</span><span>${escapeHtml(ev.group)}</span></div>
        ${ev.subgroup ? `<div class="popover-row"><span class="label">Подгруппа</span><span>${escapeHtml(ev.subgroup)}</span></div>` : ''}
    `;
}

export function showEventDetails(ev, anchor) {
    const pop = document.getElementById('eventPopover');
    pop.classList.remove('popover--group');
    pop.innerHTML = eventDetailsHtml(ev);
    pop.classList.add('open');
    positionPopover(pop, anchor);
}

export function hideEventDetails() {
    const pop = document.getElementById('eventPopover');
    pop.classList.remove('open', 'popover--group');
}

export function showGroupDetails(events, anchor) {
    const pop = document.getElementById('eventPopover');
    pop.classList.add('open', 'popover--group');
    renderGroupList(events, anchor, pop);
    positionPopover(pop, anchor);
}

function renderGroupList(events, anchor, pop) {
    pop.classList.add('popover--group');
    pop.innerHTML = `
        <div class="popover-header">
            <h3>${events.length} мероприятий</h3>
        </div>
        <div class="group-list">
            ${events.map((ev, i) => {
                const titleText = ev.discipline + (ev.type ? ` (${ev.type})` : '');
                return `
                    <div class="group-item" data-idx="${i}">
                        <div class="group-item-time">${ev.time_start}–${ev.endTime}</div>
                        <div class="group-item-title">${escapeHtml(titleText)}</div>
                        ${ev.rooms ? `<div class="group-item-room">${renderRoomsLinks(ev.rooms)}</div>` : ''}
                    </div>
                `;
            }).join('')}
        </div>
    `;

    pop.querySelectorAll('.group-item').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const idx = parseInt(el.dataset.idx, 10);
            renderGroupDetailItem(events[idx], events, anchor, pop);
        });
    });
}

function renderGroupDetailItem(ev, events, anchor, pop) {
    pop.classList.remove('popover--group');
    pop.innerHTML = `
        <button class="popover-back" type="button">← К списку</button>
        ${eventDetailsHtml(ev)}
    `;
    pop.querySelector('.popover-back').addEventListener('click', e => {
        e.stopPropagation();
        renderGroupList(events, anchor, pop);
    });
}