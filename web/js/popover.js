'use strict';

import { MONTHS_GEN } from './config.js';
import { escapeHtml, renderRoomsLinks } from './utils.js';
import { state } from './state.js';
import { showToast } from './toast.js';
import { openShareMenu, buildTextForEvent } from './share.js';

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
            <div class="popover-actions">
                <button class="popover-look" type="button" aria-label="Показать в оригинале">
                    <svg viewBox="0 0 24 24" width="14" height="14"
                         fill="none" stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                    </svg>
                </button>
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
    pop._eventData = ev;   // ← привязываем событие к поповеру
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
                const roomsHtml = ev.rooms ? renderRoomsLinks(ev.rooms) : '';
                const timeStr = (ev.time_start && ev.endTime)
                    ? `${ev.time_start}–${ev.endTime}`
                    : '';
                const teachersStr = (ev.teachers && ev.teachers.length)
                    ? ev.teachers.join(', ')
                    : '';

                // Как в карточке календаря:
                //   primary   — время · аудитория
                //   secondary — группа · преподаватель
                const primaryParts = [];
                if (timeStr)   primaryParts.push(`<span class="group-item-time">${timeStr}</span>`);
                if (roomsHtml) primaryParts.push(`<span class="group-item-room">${roomsHtml}</span>`);
                const primaryHtml = primaryParts.join('<span class="group-item-sep">·</span>');

                const secondaryParts = [];
                if (ev.group)     secondaryParts.push(`<span class="group-item-group">${escapeHtml(ev.group)}</span>`);
                if (teachersStr)  secondaryParts.push(`<span class="group-item-teacher">${escapeHtml(teachersStr)}</span>`);
                const secondaryHtml = secondaryParts.join('<span class="group-item-sep">·</span>');

                return `
                    <div class="group-item" data-idx="${i}">
                        <div class="group-item-title">${escapeHtml(titleText)}</div>
                        ${primaryHtml ? `<div class="group-item-meta group-item-meta--primary">${primaryHtml}</div>` : ''}
                        ${secondaryHtml ? `<div class="group-item-meta group-item-meta--secondary">${secondaryHtml}</div>` : ''}
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
    pop._eventData = ev;
    pop.querySelector('.popover-back').addEventListener('click', e => {
        e.stopPropagation();
        renderGroupList(events, anchor, pop);
    });
    attachShareHandler(pop, ev);
}

/* ---------- SHARE EVENT ---------- */

function buildEventUrl(ev) {
    const params = new URLSearchParams();
    if (ev.group)    params.set('g', ev.group);
    if (ev.dateISO)  params.set('d', ev.dateISO);
    if (state.view)  params.set('v', state.view);
    if (ev.event_id) params.set('e', ev.event_id);
    return location.origin + location.pathname + '?' + params.toString();
}

async function shareEventLink(ev) {
    const url = buildEventUrl(ev);
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

async function copyEventText(ev) {
    const text = buildTextForEvent(ev);
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
            showToast('Скопировано');
        } else {
            showToast('Не удалось скопировать');
        }
    } catch (e) {
        console.warn('[copy] failed:', e);
        showToast('Не удалось скопировать');
    }
}

function attachShareHandler(pop, ev) {
    const btn = pop.querySelector('.popover-share');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openShareMenu(btn, {
            onLink: () => shareEventLink(ev),
            onText: () => copyEventText(ev),
        });
    });
}

/* ============================================================
 *  КНОПКА «ПОКАЗАТЬ В ОРИГИНАЛЕ» (глазик).
 *
 *  Один глобальный слушатель на document. Клик по .popover-look
 *  берёт событие, привязанное к поповеру, и передаёт его
 *  в зарегистрированный handler (см. main.js → originalApi.focusOn).
 * ============================================================ */

let viewOriginalHandler = null;

export function setupPopoverViewHandler(fn) {
    if (typeof fn !== 'function' || viewOriginalHandler) return;
    viewOriginalHandler = fn;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.popover-look');
        if (!btn) return;

        const pop = document.getElementById('eventPopover');
        if (!pop || !pop.contains(btn)) return;

        const ev = pop._eventData;
        if (!ev) return;

        e.preventDefault();
        e.stopPropagation();

        try { viewOriginalHandler(ev); }
        catch (err) { console.warn('[look] failed:', err); }
    }, true);
}