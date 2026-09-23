'use strict';

import { state, saveSetToStorage } from './state.js';
import { render } from './render.js';

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
        });

        const text = document.createElement('span');
        text.className = 'filter-option-value';
        text.textContent = value;

        row.appendChild(cb);
        row.appendChild(text);
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
    });

    dropdown.addEventListener('click', e => e.stopPropagation());

    updateTriggerLabel();
    updateCounter();

    window.addEventListener('resize', () => {
        // updateDateLabel imported from render
        import('./render.js').then(m => m.updateDateLabel());
    });
}