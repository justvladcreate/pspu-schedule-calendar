'use strict';

import { MONTHS_GEN } from './config.js';
import { escapeHtml, renderRoomsLinks } from './utils.js';
import { state } from './state.js';
import { showToast } from './toast.js';

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
        <div class="popover-title-row">
            <h3>${escapeHtml(titleText)}</h3>
            <button class="popover-share" type="button" aria-label="Поделиться ссылкой на событие">
                <svg viewBox="0 0 24 24" width="14" height="14"
                     fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="18" cy="5" r="3"/>
                    <circle cx="6" cy="12" r="3"/>
                    <circle cx="18" cy="19" r="3"/>
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                </svg>
            </button>
        </div>
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
    attachShareHandler(pop, ev);
    positionPopover(pop, anchor);
}

export function hideEventDetails() {
    const pop = document.getElementById('eventPopover');
    pop.classList.remove('open', 'popover--group');
    pop.innerHTML = '';
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
    attachShareHandler(pop, ev);
}

/* ---------- SHARE EVENT ---------- */

async function shareEvent(ev) {
    const params = new URLSearchParams();
    if (ev.group)    params.set('g', ev.group);
    if (ev.dateISO)  params.set('d', ev.dateISO);
    if (state.view)  params.set('v', state.view);
    if (ev.event_id) params.set('e', ev.event_id);

    const url = location.origin + location.pathname + '?' + params.toString();

    try {
        if (navigator.share) {
            await navigator.share({ url, title: ev.discipline });
        } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(url);
            showToast('Ссылка скопирована');
        } else {
            showToast('Не удалось скопировать ссылку');
        }
    } catch (e) {
        if (e && e.name !== 'AbortError') {
            console.warn('[share] failed:', e);
        }
    }
}

function attachShareHandler(pop, ev) {
    const btn = pop.querySelector('.popover-share');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        shareEvent(ev);
    });
}