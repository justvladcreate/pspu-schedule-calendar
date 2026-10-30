'use strict';

import {
    state,
    saveSetToStorage,
    saveFavoritesActive,
    savePrevFilter,
} from './state.js';
import { render, updateDateLabel } from './render.js';
import { expandEvents } from './data.js';
import { refreshBanner } from './update-banner.js';

const FAV_GROUPS_KEY   = 'schedule-favorites-groups';
const FAV_TEACHERS_KEY = 'schedule-favorites-teachers';

const TOOLTIP_TEXT =
    'Отметьте группы и преподавателей звёздочкой в фильтре, ' +
    'чтобы быстро возвращаться к ним';

/* Пауза перед перерисовкой календаря: пользователь часто ставит
   несколько галочек подряд, а полный render недели — не бесплатный. */
const RENDER_DEBOUNCE_MS = 80;

/* Сколько карточек выбранных фильтров показываем под поиском.
   Остальные прячем за чип «Ещё N» и показываем в модалке. */
const MAX_VISIBLE_CHIPS = 12;

const CHECK_ICON = `
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none"
         stroke="currentColor" stroke-width="2.2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="3 8.5 6.5 12 13 4.5"/>
    </svg>`;

const STAR_ICON = `
    <svg viewBox="0 0 24 24" width="14" height="14"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>`;

/* ============================================================
 *  ВСПОМОГАТЕЛЬНОЕ
 * ============================================================ */

const ui = {
    root: null,
    trigger: null,
    dropdown: null,
    search: null,
    groupsList: null,
    teachersList: null,
    faculties: null,
    groupsCount: null,
    teachersCount: null,
    groupsToggle: null,
    teachersToggle: null,
    resetBtn: null,
    doneBtn: null,
    selected: null,
    selectedModal: null,
    selectedModalBody: null,
};

let renderTimer = null;

function isFilterOpen() {
    return !!ui.root && ui.root.classList.contains('open');
}

function pluralRu(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

function facultyIdOf(faculty) {
    return String(faculty && faculty.id);
}

function facultyShort(id) {
    const faculty = (state.faculties || []).find(
        item => String(item.id) === String(id)
    );
    if (!faculty) return String(id);
    return faculty.short || faculty.name || String(id);
}

function facultyIdsOf(type, value) {
    const map = type === 'group'
        ? state.groupFaculties
        : state.teacherFaculties;
    return (map && map.get(value)) || null;
}

/** Входит ли группа/преподаватель в текущую выборку факультетов. */
function inFacultyScope(type, value, scope) {
    if (!scope || scope.size === 0) return true;
    const ids = facultyIdsOf(type, value);
    if (!ids || ids.size === 0) return true;
    for (const id of ids) {
        if (scope.has(String(id))) return true;
    }
    return false;
}

function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

/* ============================================================
 *  ПРИМЕНЕНИЕ ФИЛЬТРА
 * ============================================================ */

export function applyFilters() {
    const sg = state.selectedGroups;
    const st = state.selectedTeachers;
    const sf = state.selectedFaculties;

    if (sg.size === 0 && st.size === 0) {
        if (sf.size === 0) {
            state.filteredEvents = [];
            return;
        }
        state.filteredEvents = expandEvents(state.allEvents.filter(ev => {
            if (state.showOnlyActive && ev.is_past) return false;
            return sf.has(String(ev.faculty_id || '12'));
        }));
        return;
    }

    state.filteredEvents = expandEvents(state.allEvents.filter(ev => {
        if (state.showOnlyActive && ev.is_past) return false;
        if (sf.size > 0 && !sf.has(String(ev.faculty_id || '12'))) return false;
        if (sg.size > 0 && !sg.has(ev.group)) return false;
        if (st.size > 0) {
            const teachers = ev.teachers || [];
            if (!teachers.some(t => st.has(t))) return false;
        }
        return true;
    }));
}

/* ============================================================
 *  БЕЙДЖ НА КНОПКЕ ФИЛЬТРА
 * ============================================================ */

export function updateTriggerLabel() {
    const trigger = document.querySelector('.filter-trigger');
    if (!trigger) return;

    const badge = trigger.querySelector('.filter-badge');
    if (!badge) return;

    const total = state.selectedFaculties.size
        + state.selectedGroups.size
        + state.selectedTeachers.size;

    const newText = total === 0 ? '' : (total > 99 ? '99+' : String(total));
    const changed = badge.textContent !== newText;
    badge.textContent = newText;

    if (total === 0) {
        badge.classList.remove('filter-badge--visible');
        return;
    }

    badge.classList.add('filter-badge--visible');
    if (changed) {
        badge.classList.remove('badge-pulse');
        void badge.offsetWidth;
        badge.classList.add('badge-pulse');
    }
}

/* ============================================================
 *  СЧЁТЧИК «ВЫБРАНО · НАЙДЕНО»
 * ============================================================ */

export function updateCounter() {
    const counterEl = document.getElementById('filterCounter');
    if (!counterEl) return;

    const f = state.selectedFaculties.size;
    const g = state.selectedGroups.size;
    const t = state.selectedTeachers.size;

    if (f === 0 && g === 0 && t === 0) {
        counterEl.textContent = 'Ничего не выбрано — отметьте группы или преподавателей';
        return;
    }

    const parts = [];
    if (f) parts.push(`${f} ${pluralRu(f, 'факультет', 'факультета', 'факультетов')}`);
    if (g) parts.push(`${g} ${pluralRu(g, 'группа', 'группы', 'групп')}`);
    if (t) parts.push(`${t} ${pluralRu(t, 'преподаватель', 'преподавателя', 'преподавателей')}`);

    const found = state.filteredEvents.length;
    let text = `${parts.join(' · ')} · найдено: ${found === 0 ? 'ничего' : found}`;

    // Выбранные группы/преподаватели могли остаться от другого факультета.
    // Показываем это явно, чтобы пустой календарь не выглядел поломкой.
    if (state.selectedFaculties.size > 0) {
        let outside = 0;
        for (const group of state.selectedGroups) {
            if (!inFacultyScope('group', group, state.selectedFaculties)) outside++;
        }
        for (const teacher of state.selectedTeachers) {
            if (!inFacultyScope('teacher', teacher, state.selectedFaculties)) outside++;
        }
        if (outside > 0) {
            text += ` · вне выбранных факультетов: ${outside}`;
        }
    }

    counterEl.textContent = text;
}

function updatePanelMeta() {
    if (!ui.search) return;

    const query = ui.search.value;
    const scopeGroups = inScopeValues('group', query);
    const scopeTeachers = inScopeValues('teacher', query);
    const selectedGroups = state.selectedGroups;
    const selectedTeachers = state.selectedTeachers;

    const selectedInScopeGroups = scopeGroups.filter(v => selectedGroups.has(v)).length;
    const selectedInScopeTeachers = scopeTeachers.filter(v => selectedTeachers.has(v)).length;

    if (ui.groupsCount) {
        ui.groupsCount.textContent = `${selectedInScopeGroups} / ${scopeGroups.length}`;
    }
    if (ui.teachersCount) {
        ui.teachersCount.textContent = `${selectedInScopeTeachers} / ${scopeTeachers.length}`;
    }

    const allGroups = scopeGroups.length > 0
        && selectedInScopeGroups === scopeGroups.length;
    const allTeachers = scopeTeachers.length > 0
        && selectedInScopeTeachers === scopeTeachers.length;

    if (ui.groupsToggle) {
        ui.groupsToggle.textContent = allGroups ? 'Снять' : 'Все';
        ui.groupsToggle.disabled = scopeGroups.length === 0;
        ui.groupsToggle.classList.toggle('is-on', allGroups);
        ui.groupsToggle.setAttribute(
            'aria-label',
            allGroups ? 'Снять все группы' : 'Выбрать все группы'
        );
    }
    if (ui.teachersToggle) {
        ui.teachersToggle.textContent = allTeachers ? 'Снять' : 'Все';
        ui.teachersToggle.disabled = scopeTeachers.length === 0;
        ui.teachersToggle.classList.toggle('is-on', allTeachers);
        ui.teachersToggle.setAttribute(
            'aria-label',
            allTeachers ? 'Снять всех преподавателей' : 'Выбрать всех преподавателей'
        );
    }

    if (ui.resetBtn) {
        ui.resetBtn.disabled =
            state.selectedFaculties.size === 0
            && state.selectedGroups.size === 0
            && state.selectedTeachers.size === 0;
    }
}

/* ============================================================
 *  ПРИМЕНЕНИЕ ИЗМЕНЕНИЙ (live)
 *
 *  Раньше выбор копился в draft и применялся только по «Готово»:
 *  закрыл панель — выбор «улетел». Теперь каждое изменение сразу
 *  попадает в state и в календарь.
 * ============================================================ */

function persistFilters() {
    saveSetToStorage('schedule-selected-faculties', state.selectedFaculties);
    saveSetToStorage('schedule-selected-groups', state.selectedGroups);
    saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);
}

function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
        renderTimer = null;
        render();
    }, RENDER_DEBOUNCE_MS);
}

function applyNow() {
    applyFilters();
    updateTriggerLabel();
    updateCounter();
    updatePanelMeta();
    updateFavoritesButton();
    renderSelectedChips();
    refreshBanner();
    scheduleRender();
}

function onSelectionChange() {
    // Ручная правка выбора расходится с избранным — режим
    // «только избранное» больше не отражает выбор.
    if (state.favoritesActive) {
        const same = setsEqual(state.selectedGroups, state.favoritesGroups)
            && setsEqual(state.selectedTeachers, state.favoritesTeachers);
        if (!same) {
            state.favoritesActive = false;
            state.prevFilter = null;
            saveFavoritesActive(false);
            savePrevFilter(null);
            updateFavoritesButton();
        }
    }

    persistFilters();
    applyNow();

    // Выбранные значения уезжают в карточки — список должен обновиться.
    if (isFilterOpen()) {
        renderLists(ui.search ? ui.search.value : '');
    }
}

/* ============================================================
 *  СПИСКИ ГРУПП И ПРЕПОДАВАТЕЛЕЙ
 * ============================================================ */

function selectedSetFor(type) {
    return type === 'group' ? state.selectedGroups : state.selectedTeachers;
}

/**
 * Значения в текущей выборке факультетов и под поиском — именно они
 * попадают в «Все» и в счётчик заголовка колонки.
 */
function inScopeValues(type, query = '') {
    const all = type === 'group' ? state.groups : state.teachers;
    const q = String(query || '').trim().toLowerCase();
    const scope = state.selectedFaculties;

    return all.filter(value => {
        if (q && !String(value).toLowerCase().includes(q)) return false;
        return inFacultyScope(type, value, scope);
    });
}

/**
 * Всё, что видно в списке: значения в выбранных факультетах, кроме уже
 * отмеченных. Выбранные живут отдельными карточками под поиском, поэтому
 * дублировать их в списке больше не нужно.
 */
function visibleValues(type, query = '') {
    const selected = selectedSetFor(type);
    return inScopeValues(type, query)
        .filter(value => !selected.has(value))
        .sort((a, b) => String(a).localeCompare(String(b), 'ru'));
}

/* ---------- карточки выбранных фильтров ---------- */

function selectionLabel(type, value) {
    if (type === 'faculty') return facultyShort(value);
    return String(value);
}

function selectedEntries() {
    const entries = [];

    for (const id of state.selectedFaculties) {
        const value = String(id);
        entries.push({ type: 'faculty', value, label: selectionLabel('faculty', value) });
    }
    for (const group of state.selectedGroups) {
        entries.push({ type: 'group', value: group, label: selectionLabel('group', group) });
    }
    for (const teacher of state.selectedTeachers) {
        entries.push({ type: 'teacher', value: teacher, label: selectionLabel('teacher', teacher) });
    }

    return entries;
}

function selectionTitle(type) {
    if (type === 'faculty') return 'Факультеты';
    if (type === 'group') return 'Группы';
    return 'Преподаватели';
}

function removeSelected(entry) {
    if (entry.type === 'faculty') state.selectedFaculties.delete(String(entry.value));
    else if (entry.type === 'group') state.selectedGroups.delete(entry.value);
    else state.selectedTeachers.delete(entry.value);

    onSelectionChange();

    // Факультетский чип возвращается в ряд — остальные списки
    // перерисовывает сам onSelectionChange().
    if (isFilterOpen()) renderFaculties();
}

function makeSelectedCard(entry) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'filter-selected-card';
    if (entry.type === 'faculty') card.classList.add('filter-selected-card--faculty');
    card.title = `Убрать: ${entry.label}`;
    card.setAttribute('aria-label', `Убрать фильтр: ${entry.label}`);
    card.dataset.type = entry.type;

    const label = document.createElement('span');
    label.className = 'filter-selected-card-label';
    label.textContent = entry.label;

    // Крестик чисто визуальный: снимает фильтр клик по всей карточке.
    const cross = document.createElement('span');
    cross.className = 'filter-selected-card-x';
    cross.textContent = '×';
    cross.setAttribute('aria-hidden', 'true');

    card.appendChild(label);
    card.appendChild(cross);
    card.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeSelected(entry);
    });

    return card;
}

function renderSelectedModal(entries) {
    if (!ui.selectedModalBody) return;

    ui.selectedModalBody.innerHTML = '';

    if (entries.length === 0) {
        if (ui.selectedModal) ui.selectedModal.classList.remove('open');
        return;
    }

    const types = ['faculty', 'group', 'teacher'];
    for (const type of types) {
        const items = entries.filter(entry => entry.type === type);
        if (items.length === 0) continue;

        const section = document.createElement('div');
        section.className = 'filter-selected-modal-section';

        const title = document.createElement('div');
        title.className = 'filter-selected-group-title';
        title.textContent = `${selectionTitle(type)} · ${items.length}`;
        section.appendChild(title);

        const list = document.createElement('div');
        list.className = 'filter-selected-modal-list';

        for (const entry of items) {
            const row = document.createElement('div');
            row.className = 'filter-selected-modal-row';

            const label = document.createElement('span');
            label.className = 'filter-selected-modal-row-label';
            label.textContent = entry.label;
            label.title = entry.label;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'filter-selected-modal-remove';
            btn.textContent = '×';
            btn.setAttribute('aria-label', `Убрать фильтр: ${entry.label}`);
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                removeSelected(entry);
            });

            row.appendChild(label);
            row.appendChild(btn);
            list.appendChild(row);
        }

        section.appendChild(list);
        ui.selectedModalBody.appendChild(section);
    }
}

function renderSelectedChips() {
    if (!ui.selected) return;

    const entries = selectedEntries();
    ui.selected.innerHTML = '';

    if (entries.length === 0) {
        ui.selected.hidden = true;
        renderSelectedModal(entries);
        return;
    }

    ui.selected.hidden = false;

    const visible = entries.slice(0, MAX_VISIBLE_CHIPS);
    for (const entry of visible) {
        ui.selected.appendChild(makeSelectedCard(entry));
    }

    if (entries.length > MAX_VISIBLE_CHIPS) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'filter-selected-more';
        more.textContent = `Ещё ${entries.length - MAX_VISIBLE_CHIPS}`;
        more.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openSelectedModal();
        });
        ui.selected.appendChild(more);
    }

    renderSelectedModal(entries);
}

function openSelectedModal() {
    if (!ui.selectedModal) return;
    renderSelectedModal(selectedEntries());
    ui.selectedModal.classList.add('open');
}

function closeSelectedModal() {
    if (!ui.selectedModal) return;
    ui.selectedModal.classList.remove('open');
}

function makeCheckbox() {
    const box = document.createElement('span');
    box.className = 'filter-option-check';
    box.innerHTML = CHECK_ICON;
    return box;
}

function makeFavoriteStar(type, value) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'favorite-star';

    const favSet = type === 'group'
        ? state.favoritesGroups
        : state.favoritesTeachers;
    const isFav = favSet.has(value);

    btn.classList.toggle('is-favorite', isFav);
    btn.setAttribute('aria-label', isFav ? 'Убрать из избранного' : 'В избранное');
    btn.innerHTML = STAR_ICON;
    btn.querySelector('svg').setAttribute('fill', isFav ? 'currentColor' : 'none');

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const favorites = type === 'group'
            ? state.favoritesGroups
            : state.favoritesTeachers;

        if (favorites.has(value)) favorites.delete(value);
        else favorites.add(value);

        const nowFav = favorites.has(value);
        btn.classList.toggle('is-favorite', nowFav);
        btn.setAttribute('aria-label', nowFav ? 'Убрать из избранного' : 'В избранное');
        btn.querySelector('svg').setAttribute('fill', nowFav ? 'currentColor' : 'none');

        saveSetToStorage(
            type === 'group' ? FAV_GROUPS_KEY : FAV_TEACHERS_KEY,
            favorites
        );

        // В режиме «только избранное» выбор должен следовать за звёздочками.
        if (state.favoritesActive) {
            state.selectedGroups = new Set(state.favoritesGroups);
            state.selectedTeachers = new Set(state.favoritesTeachers);
            persistFilters();
            renderLists(ui.search ? ui.search.value : '');
            applyNow();
        }
    });

    return btn;
}

function buildOption(type, value) {
    const selected = selectedSetFor(type);
    const checked = selected.has(value);

    const row = document.createElement('label');
    row.className = 'filter-option';
    row.classList.toggle('is-selected', checked);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'filter-option-input';
    input.checked = checked;
    input.addEventListener('change', () => {
        const set = selectedSetFor(type);
        if (input.checked) set.add(value);
        else set.delete(value);

        row.classList.toggle('is-selected', input.checked);
        onSelectionChange();
    });

    const text = document.createElement('span');
    text.className = 'filter-option-value';
    text.textContent = value;
    text.title = value;

    row.appendChild(input);
    row.appendChild(makeCheckbox());
    row.appendChild(text);
    row.appendChild(makeFavoriteStar(type, value));
    return row;
}

function fillList(container, type, values, emptyText = 'Не найдено') {
    if (!container) return;
    container.innerHTML = '';

    if (values.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'filter-option-empty';
        empty.textContent = emptyText;
        container.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const value of values) fragment.appendChild(buildOption(type, value));
    container.appendChild(fragment);
}

function renderLists(query = '') {
    if (!ui.groupsList) return;

    const scopeGroups = inScopeValues('group', query);
    const groups = visibleValues('group', query);
    const groupsEmpty = scopeGroups.length > 0 ? 'Все группы выбраны' : 'Не найдено';

    const scopeTeachers = inScopeValues('teacher', query);
    const teachers = visibleValues('teacher', query);
    const teachersEmpty = scopeTeachers.length > 0 ? 'Все преподаватели выбраны' : 'Не найдено';

    fillList(ui.groupsList, 'group', groups, groupsEmpty);
    fillList(ui.teachersList, 'teacher', teachers, teachersEmpty);
    updatePanelMeta();
}

/* ---------- факультеты ---------- */

function groupsForFaculty(id) {
    let count = 0;
    for (const group of state.groups) {
        const ids = state.groupFaculties.get(group);
        if (ids && ids.has(id)) count++;
    }
    return count;
}

function renderFaculties() {
    if (!ui.faculties) return;
    ui.faculties.innerHTML = '';

    if (!state.faculties.length) {
        const empty = document.createElement('div');
        empty.className = 'filter-option-empty';
        empty.textContent = 'Нет факультетов';
        ui.faculties.appendChild(empty);
        return;
    }

    // Выбранные факультеты уже показаны карточками под поиском.
    const available = state.faculties.filter(
        faculty => !state.selectedFaculties.has(facultyIdOf(faculty))
    );

    if (available.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'filter-option-empty';
        empty.textContent = 'Все факультеты выбраны';
        ui.faculties.appendChild(empty);
        return;
    }

    for (const faculty of available) {
        const id = facultyIdOf(faculty);

        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'filter-faculty-chip';
        chip.setAttribute('aria-pressed', 'false');
        chip.title = faculty.name || facultyShort(id);

        const name = document.createElement('span');
        name.className = 'filter-faculty-name';
        name.textContent = faculty.short || faculty.name || id;

        const count = document.createElement('span');
        count.className = 'filter-faculty-count';
        count.textContent = String(groupsForFaculty(id));

        chip.appendChild(name);
        chip.appendChild(count);

        chip.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (state.selectedFaculties.has(id)) {
                state.selectedFaculties.delete(id);
            } else {
                state.selectedFaculties.add(id);
            }

            persistFilters();
            renderFaculties();
            renderLists(ui.search ? ui.search.value : '');
            applyNow();
        });

        ui.faculties.appendChild(chip);
    }
}

/* ============================================================
 *  КНОПКА «ИЗБРАННОЕ» В ТУЛБАРЕ
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
                state.selectedFaculties = new Set(state.prevFilter.faculties || []);
                state.selectedGroups    = new Set(state.prevFilter.groups);
                state.selectedTeachers  = new Set(state.prevFilter.teachers);
            }
            state.favoritesActive = false;
            state.prevFilter = null;
        } else {
            state.prevFilter = {
                faculties: [...state.selectedFaculties],
                groups:    [...state.selectedGroups],
                teachers:  [...state.selectedTeachers],
            };
            // Избранное может быть из разных факультетов — снимаем
            // факультетский фильтр, иначе часть избранного просто скрыта.
            state.selectedFaculties = new Set();
            state.selectedGroups    = new Set(state.favoritesGroups);
            state.selectedTeachers  = new Set(state.favoritesTeachers);
            state.favoritesActive = true;
        }

        saveSetToStorage('schedule-selected-faculties', state.selectedFaculties);
        saveSetToStorage('schedule-selected-groups',    state.selectedGroups);
        saveSetToStorage('schedule-selected-teachers',  state.selectedTeachers);
        saveFavoritesActive(state.favoritesActive);
        savePrevFilter(state.prevFilter);

        if (isFilterOpen()) {
            renderFaculties();
            renderLists(ui.search ? ui.search.value : '');
        }

        applyNow();
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

    // После перезагрузки режим «только избранное» должен показывать
    // именно избранное, даже если в localStorage остался старый выбор.
    if (state.favoritesActive) {
        state.selectedFaculties = new Set();
        state.selectedGroups    = new Set(state.favoritesGroups);
        state.selectedTeachers  = new Set(state.favoritesTeachers);
        persistFilters();
    }

    updateFavoritesButton();
}

/* ============================================================
 *  ОСНОВНОЙ ФИЛЬТР
 * ============================================================ */

export function setupUnifiedFilter() {
    const root = document.getElementById('filterRoot');
    if (!root) return;

    ui.root = root;
    ui.trigger = root.querySelector('.filter-trigger');
    ui.dropdown = root.querySelector('.filter-dropdown');
    ui.search = root.querySelector('.filter-search');
    ui.groupsList = document.getElementById('filterGroupsList');
    ui.teachersList = document.getElementById('filterTeachersList');
    ui.faculties = document.getElementById('filterFaculties');
    ui.groupsCount = document.getElementById('filterGroupsCount');
    ui.teachersCount = document.getElementById('filterTeachersCount');
    ui.groupsToggle = root.querySelector('[data-all="groups"]');
    ui.teachersToggle = root.querySelector('[data-all="teachers"]');
    ui.resetBtn = root.querySelector('[data-action="reset"]');
    ui.doneBtn = root.querySelector('.filter-done');
    ui.selected = document.getElementById('filterSelected');
    ui.selectedModal = document.getElementById('filterSelectedModal');
    ui.selectedModalBody = document.getElementById('filterSelectedModalBody');

    if (!ui.trigger || !ui.dropdown || !ui.search) return;

    /* ---------- модалка «все выбранные фильтры» ---------- */

    if (ui.selectedModal) {
        const closeBtn = ui.selectedModal.querySelector('.filter-selected-modal-close');
        if (closeBtn) closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeSelectedModal();
        });
        ui.selectedModal.addEventListener('click', (e) => {
            if (e.target === ui.selectedModal) closeSelectedModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && ui.selectedModal.classList.contains('open')) {
                closeSelectedModal();
            }
        });
    }

    /* ---------- открытие / закрытие ---------- */

    function openFilter() {
        document.querySelectorAll('.filter.open').forEach(el => el.classList.remove('open'));
        root.classList.add('open');

        ui.search.value = '';
        renderSelectedChips();
        renderFaculties();
        renderLists('');
        updateTriggerLabel();
        updateCounter();
        updatePanelMeta();

        history.pushState({ filterOpen: true }, '');

        // На мобилке не выдёргиваем клавиатуру — она закрывает полсписка.
        if (window.innerWidth > 700) {
            setTimeout(() => ui.search.focus(), 50);
        }
    }

    function closeFilter() {
        if (!root.classList.contains('open')) return;

        if (history.state && history.state.filterOpen) {
            history.back();   // popstate снимет класс .open
        } else {
            root.classList.remove('open');
            updateTriggerLabel();
            updateCounter();
        }
    }

    ui.trigger.addEventListener('click', e => {
        e.stopPropagation();
        if (root.classList.contains('open')) closeFilter();
        else openFilter();
    });

    const closeBtn = ui.dropdown.querySelector('.filter-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            closeFilter();
        });
    }

    if (ui.doneBtn) {
        ui.doneBtn.addEventListener('click', e => {
            e.stopPropagation();
            closeFilter();
        });
    }

    /* Изменения уже применены — клик мимо просто закрывает панель. */
    document.addEventListener('click', e => {
        if (!root.classList.contains('open')) return;
        if (root.contains(e.target)) return;
        closeFilter();
    });

    window.addEventListener('popstate', () => {
        if (root.classList.contains('open')) {
            root.classList.remove('open');
            updateTriggerLabel();
            updateCounter();
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && root.classList.contains('open')) {
            closeFilter();
        }
    });

    /* ---------- поиск ---------- */

    ui.search.addEventListener('input', () => renderLists(ui.search.value));

    /* ---------- «Все» в заголовке колонки ---------- */

    function toggleAll(type) {
        const values = inScopeValues(type, ui.search.value);
        const set = selectedSetFor(type);
        if (values.length === 0) return;

        const allSelected = values.every(v => set.has(v));
        if (allSelected) values.forEach(v => set.delete(v));
        else values.forEach(v => set.add(v));

        renderLists(ui.search.value);
        onSelectionChange();
    }

    if (ui.groupsToggle) {
        ui.groupsToggle.addEventListener('click', e => {
            e.stopPropagation();
            toggleAll('group');
        });
    }
    if (ui.teachersToggle) {
        ui.teachersToggle.addEventListener('click', e => {
            e.stopPropagation();
            toggleAll('teacher');
        });
    }

    /* ---------- «Сбросить» ---------- */

    if (ui.resetBtn) {
        ui.resetBtn.addEventListener('click', e => {
            e.stopPropagation();

            state.selectedFaculties.clear();
            state.selectedGroups.clear();
            state.selectedTeachers.clear();

            persistFilters();
            renderFaculties();
            renderLists(ui.search.value);
            onSelectionChange();
        });
    }

    ui.dropdown.addEventListener('click', e => e.stopPropagation());

    renderSelectedChips();
    renderFaculties();
    updateTriggerLabel();
    updateCounter();
    updatePanelMeta();

    window.addEventListener('resize', updateDateLabel);
}
