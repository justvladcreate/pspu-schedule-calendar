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
import {
    pluralRu,
    matchesQuery,
    createSearch,
    createOption,
    createEmptyRow,
    createSelectedChip,
    createFacultyChip,
    facultyIdsOf,
    inFacultyScope,
    valuesInScope,
} from './filter-core.js';

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

/* ============================================================
 *  ВСПОМОГАТЕЛЬНОЕ
 * ============================================================ */

const ui = {
    root: null,
    trigger: null,
    dropdown: null,
    search: null,
    searchUi: null,
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
    const scopeGroups = scopeValues('group', query);
    const scopeTeachers = scopeValues('teacher', query);
    const selectedGroups = state.selectedGroups;
    const selectedTeachers = state.selectedTeachers;

    const selectedInScopeGroups = scopeGroups.filter(v => selectedGroups.has(v)).length;
    const selectedInScopeTeachers = scopeTeachers.filter(v => selectedTeachers.has(v)).length;

    if (ui.groupsCount) {
        ui.groupsCount.textContent = selectedInScopeGroups > 0
            ? `${selectedInScopeGroups}/${scopeGroups.length}`
            : '';
    }
    if (ui.teachersCount) {
        ui.teachersCount.textContent = selectedInScopeTeachers > 0
            ? `${selectedInScopeTeachers}/${scopeTeachers.length}`
            : '';
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
 * Все значения в выбранных факультетах и под поиском.
 * Отмеченные остаются в списке на своих местах: список не прыгает
 * под курсором, а выбранное видно и галочкой, и чипом сверху.
 */
function listValues(type, query = '') {
    return valuesInScope(type, query, state.selectedFaculties)
        .sort((a, b) => String(a).localeCompare(String(b), 'ru'));
}

/** Значения для счетчиков «Все/Снять» и выбора всех под поиском. */
function scopeValues(type, query = '') {
    return valuesInScope(type, query, state.selectedFaculties);
}

/* ---------- карточки выбранных фильтров ---------- */

function selectionLabel(type, value) {
    if (type === 'faculty') return facultyShort(value);
    return String(value);
}

function selectedEntries() {
    const entries = [];

    // Факультеты живут отдельными чипами и всегда видны — в строке
    // выбранного они были бы дублем.
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
    return createSelectedChip({
        label: entry.label,
        kind: entry.type,
        onRemove: () => removeSelected(entry),
    });
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

function toggleFavorite(type, value) {
    const favorites = type === 'group'
        ? state.favoritesGroups
        : state.favoritesTeachers;

    if (favorites.has(value)) favorites.delete(value);
    else favorites.add(value);

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
}

function buildOption(type, value) {
    const selected = selectedSetFor(type);
    const favorites = type === 'group'
        ? state.favoritesGroups
        : state.favoritesTeachers;

    return createOption({
        value,
        label: value,
        checked: selected.has(value),
        favorite: {
            active: () => favorites.has(value),
            toggle: () => toggleFavorite(type, value),
        },
        onToggle: (checked) => {
            if (checked) selected.add(value);
            else selected.delete(value);
            onSelectionChange();
        },
    });
}

function fillList(container, type, values, emptyText = 'Не найдено') {
    if (!container) return;
    container.innerHTML = '';

    if (values.length === 0) {
        container.appendChild(createEmptyRow(emptyText));
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const value of values) fragment.appendChild(buildOption(type, value));
    container.appendChild(fragment);
}

function renderLists(query = '') {
    if (!ui.groupsList) return;

    fillList(ui.groupsList, 'group', listValues('group', query));
    fillList(ui.teachersList, 'teacher', listValues('teacher', query));
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
        ui.faculties.appendChild(createEmptyRow('Нет факультетов'));
        return;
    }

    // Все факультеты на своих местах: выбранный просто подсвечен.
    // Так ряд не «схлопывается» и видно, что можно переключить.
    for (const faculty of state.faculties) {
        const id = facultyIdOf(faculty);
        const active = state.selectedFaculties.has(id);

        ui.faculties.appendChild(createFacultyChip({
            label: faculty.short || faculty.name || id,
            count: groupsForFaculty(id),
            title: faculty.name || id,
            active,
            onClick: () => {
                if (state.selectedFaculties.has(id)) {
                    state.selectedFaculties.delete(id);
                } else {
                    state.selectedFaculties.add(id);
                }

                persistFilters();
                renderFaculties();
                renderLists(ui.search ? ui.search.value : '');
                applyNow();
            },
        }));
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

    const searchWrap = root.querySelector('.filter-search-wrap');
    if (searchWrap) {
        const searchUi = createSearch({
            placeholder: 'Поиск по группам и преподавателям…',
            onInput: (value) => renderLists(value),
        });
        searchWrap.replaceWith(searchUi.element);
        ui.search = searchUi.input;
        ui.searchUi = searchUi;
    }

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

        if (ui.searchUi) ui.searchUi.setValue('');
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

    /* ---------- «Все» в заголовке колонки ---------- */

    function toggleAll(type) {
        const values = scopeValues(type, ui.search.value);
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
