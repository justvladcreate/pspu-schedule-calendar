'use strict';

import { state, saveSetToStorage } from './state.js';
import { render } from './render.js';
import { refreshBanner } from './update-banner.js';

const FAV_GROUPS_KEY   = 'schedule-favorites-groups';
const FAV_TEACHERS_KEY = 'schedule-favorites-teachers';

const TOOLTIP_TEXT =
    'Отметьте группы и преподавателей звёздочкой в фильтре, ' +
    'чтобы быстро возвращаться к ним';

export function applyFilters() {
    const sg = state.selectedGroups;
    const st = state.selectedTeachers;

    if (sg.size === 0 && st.size === 0) {
        state.filteredEvents = [];
        return;
    }

    state.filteredEvents = state.allEvents.filter(ev => {
        if (sg.size > 0 && !sg.has(ev.group)) return false;
        if (st.size > 0) {
            const teachers = ev.teachers || [];
            if (!teachers.some(t => st.has(t))) return false;
        }
        return true;
    });
}

export function updateTriggerLabel() {
    const trigger = document.querySelector('.filter-trigger');
    if (!trigger) return;

    const total = state.selectedGroups.size + state.selectedTeachers.size;
    const badge = trigger.querySelector('.filter-badge');
    if (!badge) return;

    const newText = total === 0 ? '' : (total > 99 ? '99+' : String(total));
    const changed = badge.textContent !== newText;

    badge.textContent = newText;

    if (total === 0) {
        badge.classList.remove('filter-badge--visible');
    } else {
        badge.classList.add('filter-badge--visible');
        if (changed) {
            badge.classList.remove('badge-pulse');
            void badge.offsetWidth;
            badge.classList.add('badge-pulse');
        }
    }
}

export function updateCounter() {
    const counterEl = document.getElementById('filterCounter');
    if (!counterEl) return;

    const g = state.selectedGroups.size;
    const t = state.selectedTeachers.size;
    const totalG = state.groups.length;
    const totalT = state.teachers.length;
    const found = state.filteredEvents.length;

    let selectionText;
    if (g === 0 && t === 0) {
        selectionText = 'Ничего не выбрано';
    } else if (g === totalG && t === totalT && (totalG + totalT) > 0) {
        selectionText = 'Выбрано всё';
    } else {
        const parts = [];
        if (g > 0) parts.push(`групп: ${g}`);
        if (t > 0) parts.push(`преподавателей: ${t}`);
        selectionText = `Выбрано — ${parts.join(', ')}`;
    }

    const foundText = `найдено: ${found}`;
    counterEl.textContent = `${selectionText} · ${foundText}`;
}

/* ============================================================
 *  ИЗБРАННОЕ — вспомогательное
 * ============================================================ */

function updateFavoritesButton() {
    const btn = document.getElementById('favoritesBtn');
    if (!btn) return;

    btn.classList.toggle('is-active', state.favoritesActive);
    btn.dataset.favorites = state.favoritesActive ? 'on' : 'off';
    btn.setAttribute(
        'aria-label',
        state.favoritesActive
            ? 'Снять фильтр по избранному'
            : 'Фильтр по избранному'
    );
}

function makeFavoriteStar(type, value) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'favorite-star';

    const set = type === 'group' ? state.favoritesGroups : state.favoritesTeachers;
    const isFav = set.has(value);
    if (isFav) btn.classList.add('is-favorite');

    btn.setAttribute('aria-label', isFav ? 'Убрать из избранного' : 'В избранное');
    btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14"
             fill="${isFav ? 'currentColor' : 'none'}"
             stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>`;

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const s = type === 'group' ? state.favoritesGroups : state.favoritesTeachers;
        if (s.has(value)) s.delete(value);
        else s.add(value);

        saveSetToStorage(
            type === 'group' ? FAV_GROUPS_KEY : FAV_TEACHERS_KEY,
            s,
        );

        const nowFav = s.has(value);
        btn.classList.toggle('is-favorite', nowFav);
        btn.setAttribute('aria-label', nowFav ? 'Убрать из избранного' : 'В избранное');
        btn.querySelector('svg').setAttribute('fill', nowFav ? 'currentColor' : 'none');

        if (state.favoritesActive) {
            if (type === 'group') {
                state.selectedGroups = new Set(state.favoritesGroups);
                saveSetToStorage('schedule-selected-groups', state.selectedGroups);
            } else {
                state.selectedTeachers = new Set(state.favoritesTeachers);
                saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);
            }
            applyFilters();
            updateTriggerLabel();
            updateCounter();
            render();
            refreshBanner();
        }
    });

    return btn;
}

/* ============================================================
 *  ИЗБРАННОЕ — кнопка в тулбаре
 * ============================================================ */

export function setupFavoritesButton() {
    const btn = document.getElementById('favoritesBtn');
    const tooltip = document.getElementById('favoritesTooltip');
    if (!btn) return;

    let tooltipTimer = null;

    function hideTooltip() {
        if (!tooltip) return;
        tooltip.classList.remove('is-visible');
        if (tooltipTimer) {
            clearTimeout(tooltipTimer);
            tooltipTimer = null;
        }
    }

    function showTooltip() {
        if (!tooltip) return;
        tooltip.textContent = TOOLTIP_TEXT;
        tooltip.classList.add('is-visible');

        const rect = btn.getBoundingClientRect();
        const ttRect = tooltip.getBoundingClientRect();

        let left = rect.right - ttRect.width;
        if (left < 8) left = 8;
        const maxLeft = window.innerWidth - ttRect.width - 8;
        if (left > maxLeft) left = maxLeft;

        tooltip.style.left = left + 'px';
        tooltip.style.top  = (rect.bottom + 8) + 'px';

        if (tooltipTimer) clearTimeout(tooltipTimer);
        tooltipTimer = setTimeout(hideTooltip, 4000);
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();

        const favTotal = state.favoritesGroups.size + state.favoritesTeachers.size;
        if (favTotal === 0) {
            showTooltip();
            return;
        }
        hideTooltip();

        if (state.favoritesActive) {
            if (state.prevFilter) {
                state.selectedGroups   = new Set(state.prevFilter.groups);
                state.selectedTeachers = new Set(state.prevFilter.teachers);
            }
            state.favoritesActive = false;
            state.prevFilter = null;
        } else {
            state.prevFilter = {
                groups:   [...state.selectedGroups],
                teachers: [...state.selectedTeachers],
            };
            state.selectedGroups   = new Set(state.favoritesGroups);
            state.selectedTeachers = new Set(state.favoritesTeachers);
            state.favoritesActive = true;
        }

        saveSetToStorage('schedule-selected-groups',   state.selectedGroups);
        saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);

        applyFilters();
        updateTriggerLabel();
        updateCounter();
        updateFavoritesButton();
        render();
        refreshBanner();
    });

    document.addEventListener('click', (e) => {
        if (!tooltip || !tooltip.classList.contains('is-visible')) return;
        if (e.target === btn || btn.contains(e.target)) return;
        if (tooltip.contains(e.target)) return;
        hideTooltip();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideTooltip();
    });

    updateFavoritesButton();
}

/* ============================================================
 *  ФИЛЬТР
 * ============================================================ */

export function setupUnifiedFilter() {
    const root = document.getElementById('filterRoot');
    const trigger = root.querySelector('.filter-trigger');
    const dropdown = root.querySelector('.filter-dropdown');
    const search = root.querySelector('.filter-search');
    const clearBtn = root.querySelector('[data-action="clear"]');
    const selectAllBtn = root.querySelector('[data-action="select-all"]');
    const doneBtn = root.querySelector('.filter-done');
    const groupsListEl = document.getElementById('filterGroupsList');
    const teachersListEl = document.getElementById('filterTeachersList');

    function buildOption(value, type) {
        const row = document.createElement('label');
        row.className = 'filter-option';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = type === 'group'
            ? state.selectedGroups.has(value)
            : state.selectedTeachers.has(value);

        cb.addEventListener('change', () => {
            const set = type === 'group' ? state.selectedGroups : state.selectedTeachers;
            if (cb.checked) set.add(value);
            else set.delete(value);

            saveSetToStorage(
                type === 'group' ? 'schedule-selected-groups' : 'schedule-selected-teachers',
                set,
            );

            applyFilters();
            updateTriggerLabel();
            updateCounter();
            render();
            refreshBanner();
        });

        const text = document.createElement('span');
        text.className = 'filter-option-value';
        text.textContent = value;

        const star = makeFavoriteStar(type, value);

        row.appendChild(cb);
        row.appendChild(text);
        row.appendChild(star);
        return row;
    }

    function renderLists(query = '') {
        const q = query.trim().toLowerCase();

        groupsListEl.innerHTML = '';
        const matchedGroups = state.groups.filter(g => !q || g.toLowerCase().includes(q));
        if (matchedGroups.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'filter-option-empty';
            empty.textContent = 'Не найдено';
            groupsListEl.appendChild(empty);
        } else {
            for (const g of matchedGroups) groupsListEl.appendChild(buildOption(g, 'group'));
        }

        teachersListEl.innerHTML = '';
        const matchedTeachers = state.teachers.filter(t => !q || t.toLowerCase().includes(q));
        if (matchedTeachers.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'filter-option-empty';
            empty.textContent = 'Не найдено';
            teachersListEl.appendChild(empty);
        } else {
            for (const t of matchedTeachers) teachersListEl.appendChild(buildOption(t, 'teacher'));
        }
    }

    function openFilter() {
        document.querySelectorAll('.filter.open').forEach(el => el.classList.remove('open'));
        root.classList.add('open');
        search.value = '';
        renderLists('');
        updateCounter();
        history.pushState({ filterOpen: true }, '');
        setTimeout(() => search.focus(), 50);
    }

    function closeFilter() {
        if (!root.classList.contains('open')) return;
        if (history.state && history.state.filterOpen) {
            history.back();
        } else {
            root.classList.remove('open');
        }
    }

    trigger.addEventListener('click', e => {
        e.stopPropagation();
        if (root.classList.contains('open')) closeFilter();
        else openFilter();
    });

    const closeBtn = dropdown.querySelector('.filter-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            closeFilter();
        });
    }

    if (doneBtn) {
        doneBtn.addEventListener('click', e => {
            e.stopPropagation();
            closeFilter();
        });
    }

    window.addEventListener('popstate', () => {
        if (root.classList.contains('open')) {
            root.classList.remove('open');
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && root.classList.contains('open')) {
            closeFilter();
        }
    });

    search.addEventListener('input', () => renderLists(search.value));

    selectAllBtn.addEventListener('click', e => {
        e.stopPropagation();

        state.selectedGroups.clear();
        state.selectedTeachers.clear();
        for (const g of state.groups)   state.selectedGroups.add(g);
        for (const t of state.teachers) state.selectedTeachers.add(t);

        saveSetToStorage('schedule-selected-groups',   state.selectedGroups);
        saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);

        applyFilters();
        updateTriggerLabel();
        updateCounter();
        render();
        renderLists(search.value);
        refreshBanner();
    });

    clearBtn.addEventListener('click', e => {
        e.stopPropagation();
        state.selectedGroups.clear();
        state.selectedTeachers.clear();
        saveSetToStorage('schedule-selected-groups', state.selectedGroups);
        saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);
        applyFilters();
        updateTriggerLabel();
        updateCounter();
        render();
        renderLists(search.value);
        refreshBanner();
    });

    dropdown.addEventListener('click', e => e.stopPropagation());

    updateTriggerLabel();
    updateCounter();

    window.addEventListener('resize', () => {
        // updateDateLabel imported from render
        import('./render.js').then(m => m.updateDateLabel());
    });
}