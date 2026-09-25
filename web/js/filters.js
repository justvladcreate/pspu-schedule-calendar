'use strict';

import {
    state,
    saveSetToStorage,
    saveFavoritesActive,
    savePrevFilter,
} from './state.js';
import { render } from './render.js';
import { refreshBanner } from './update-banner.js';
import { showToast } from './toast.js';

const FAV_GROUPS_KEY   = 'schedule-favorites-groups';
const FAV_TEACHERS_KEY = 'schedule-favorites-teachers';

const TOOLTIP_TEXT =
    'Отметьте группы и преподавателей звёздочкой в фильтре, ' +
    'чтобы быстро возвращаться к ним';

const UNDO_TIMEOUT_MS = 5000;

/* ============================================================
 *  ВСПОМОГАТЕЛЬНОЕ
 * ============================================================ */

function isFilterOpen() {
    const root = document.getElementById('filterRoot');
    return !!root && root.classList.contains('open');
}

/**
 * Сколько событий попадёт под наборы групп/преподавателей.
 * Не трогает state — чистый расчёт для превью в счётчике.
 */
function countMatchingEvents(groups, teachers) {
    if (groups.size === 0 && teachers.size === 0) return 0;
    let n = 0;
    for (const ev of state.allEvents) {
        if (groups.size > 0 && !groups.has(ev.group)) continue;
        if (teachers.size > 0) {
            const t = ev.teachers || [];
            if (!t.some(x => teachers.has(x))) continue;
        }
        n++;
    }
    return n;
}

/* ============================================================
 *  ПРИМЕНЕНИЕ ФИЛЬТРА
 * ============================================================ */

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

/* ============================================================
 *  БЕЙДЖ НА КНОПКЕ ФИЛЬТРА
 *
 *  Закрыт  → число применённых.
 *  Открыт  → число в draft.
 * ============================================================ */

export function updateTriggerLabel() {
    const trigger = document.querySelector('.filter-trigger');
    if (!trigger) return;

    const badge = trigger.querySelector('.filter-badge');
    if (!badge) return;

    const open = isFilterOpen();
    const g = open ? state.draftGroups.size   : state.selectedGroups.size;
    const t = open ? state.draftTeachers.size : state.selectedTeachers.size;
    const total = g + t;

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

/* ============================================================
 *  СЧЁТЧИК
 *
 *  Открыт  → «Выбрано» из draft + превью «найдено» по draft.
 *  Закрыт  → «Выбрано» из применённого + фактическое «найдено».
 * ============================================================ */

export function updateCounter() {
    const counterEl = document.getElementById('filterCounter');
    if (!counterEl) return;

    const open = isFilterOpen();
    const g = open ? state.draftGroups.size   : state.selectedGroups.size;
    const t = open ? state.draftTeachers.size : state.selectedTeachers.size;

    const totalG = state.groups.length;
    const totalT = state.teachers.length;

    const found = open
        ? countMatchingEvents(state.draftGroups, state.draftTeachers)
        : state.filteredEvents.length;

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

    counterEl.textContent = `${selectionText} · найдено: ${found}`;
}

/* ============================================================
 *  КНОПКА «ГОТОВО» — текст с числом draft
 * ============================================================ */

function updateDoneButton() {
    const root = document.getElementById('filterRoot');
    if (!root) return;
    const doneBtn = root.querySelector('.filter-done');
    if (!doneBtn) return;

    const n = state.draftGroups.size + state.draftTeachers.size;
    doneBtn.textContent = n > 0 ? `Готово (${n})` : 'Готово';
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

/* ============================================================
 *  COMMIT DRAFT → APPLIED + UNDO
 * ============================================================ */

/** Сравнение двух Set по содержимому. */
function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

function commitDrafts() {
    // Снимок «как было» для кнопки «Вернуть» — включая режим избранного
    // и prevFilter, чтобы «Отменить» откатывал и их тоже.
    state.undoFilter = {
        groups:          [...state.selectedGroups],
        teachers:        [...state.selectedTeachers],
        favoritesActive: state.favoritesActive,
        prevFilter:      state.prevFilter ? {
            groups:   [...state.prevFilter.groups],
            teachers: [...state.prevFilter.teachers],
        } : null,
    };

    // Применяем черновик.
    state.selectedGroups       = new Set(state.draftGroups);
    state.selectedTeachers     = new Set(state.draftTeachers);
    state.favoritesGroups      = new Set(state.draftFavoritesGroups);
    state.favoritesTeachers    = new Set(state.draftFavoritesTeachers);

    // Если сейчас активен режим «только избранное» и избранное правили —
    // синхронизируем выделение с новым избранным (иначе снятая звезда
    // не уберёт мероприятие из календаря).
    if (state.favoritesActive && state.draftFavoritesDirty) {
        state.selectedGroups   = new Set(state.favoritesGroups);
        state.selectedTeachers = new Set(state.favoritesTeachers);
    }

    // Если пользователь вручную поменял выбор (галочками «Выбрать все»,
    // «Снять все» или отдельными чекбоксами, не трогая звёздочки),
    // выбранное больше не совпадает с избранным — режим «только избранное»
    // теряет смысл. Снимаем флаг, чтобы кнопка не оставалась залипшей.
    const selectedEqFav =
        setsEqual(state.selectedGroups, state.favoritesGroups) &&
        setsEqual(state.selectedTeachers, state.favoritesTeachers);

    if (state.favoritesActive && !selectedEqFav) {
        state.favoritesActive = false;
        state.prevFilter = null;
    }

    saveSetToStorage('schedule-selected-groups',   state.selectedGroups);
    saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);
    saveSetToStorage(FAV_GROUPS_KEY,               state.favoritesGroups);
    saveSetToStorage(FAV_TEACHERS_KEY,             state.favoritesTeachers);
    saveFavoritesActive(state.favoritesActive);
    savePrevFilter(state.prevFilter);

    applyFilters();
    updateTriggerLabel();
    updateCounter();
    updateFavoritesButton();   // ← раньше не вызывалось: кнопка не отражала сброс
    render();
    refreshBanner();

    showToast('Фильтры применены...', {
        duration: UNDO_TIMEOUT_MS,
        action: {
            label: 'Отменить',
            onClick: undoFilterChange,
        },
    });
}

function undoFilterChange() {
    if (!state.undoFilter) return;

    state.selectedGroups   = new Set(state.undoFilter.groups);
    state.selectedTeachers = new Set(state.undoFilter.teachers);
    state.favoritesActive  = !!state.undoFilter.favoritesActive;
    state.prevFilter       = state.undoFilter.prevFilter
        ? {
            groups:   [...state.undoFilter.prevFilter.groups],
            teachers: [...state.undoFilter.prevFilter.teachers],
        }
        : null;
    state.undoFilter = null;

    saveSetToStorage('schedule-selected-groups',   state.selectedGroups);
    saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);
    saveFavoritesActive(state.favoritesActive);
    savePrevFilter(state.prevFilter);

    applyFilters();
    updateTriggerLabel();
    updateCounter();
    updateFavoritesButton();
    render();
    refreshBanner();
}

/* ============================================================
 *  ЗВЁЗДОЧКА В СПИСКЕ ФИЛЬТРА
 *
 *  В draft-режиме — меняет ТОЛЬКО draftFavorites*.
 *  Никаких saveSetToStorage, никакого render.
 * ============================================================ */

function makeFavoriteStar(type, value) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'favorite-star';

    const set = type === 'group'
        ? state.draftFavoritesGroups
        : state.draftFavoritesTeachers;

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

        const s = type === 'group'
            ? state.draftFavoritesGroups
            : state.draftFavoritesTeachers;

        if (s.has(value)) s.delete(value);
        else s.add(value);

        state.draftFavoritesDirty = true;

        const nowFav = s.has(value);
        btn.classList.toggle('is-favorite', nowFav);
        btn.setAttribute('aria-label', nowFav ? 'Убрать из избранного' : 'В избранное');
        btn.querySelector('svg').setAttribute('fill', nowFav ? 'currentColor' : 'none');
    });

    return btn;
}

/* ============================================================
 *  КНОПКА «ИЗБРАННОЕ» В ТУЛБАРЕ
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
        saveFavoritesActive(state.favoritesActive);
        savePrevFilter(state.prevFilter);

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
 *  ОСНОВНОЙ ФИЛЬТР (draft-режим)
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

    /* ---------- одна строка списка ---------- */

    function buildOption(value, type) {
        const row = document.createElement('label');
        row.className = 'filter-option';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = type === 'group'
            ? state.draftGroups.has(value)
            : state.draftTeachers.has(value);

        cb.addEventListener('change', () => {
            const set = type === 'group' ? state.draftGroups : state.draftTeachers;
            if (cb.checked) set.add(value);
            else set.delete(value);

            updateTriggerLabel();
            updateCounter();
            updateDoneButton();
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

    /* ---------- перерисовка обоих списков ---------- */

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

    /* ---------- открытие: applied → draft ---------- */

    function openFilter() {
        // Копируем всё «живое» состояние в черновик.
        state.draftGroups           = new Set(state.selectedGroups);
        state.draftTeachers         = new Set(state.selectedTeachers);
        state.draftFavoritesGroups  = new Set(state.favoritesGroups);
        state.draftFavoritesTeachers = new Set(state.favoritesTeachers);
        state.draftFavoritesDirty   = false;

        document.querySelectorAll('.filter.open').forEach(el => el.classList.remove('open'));
        root.classList.add('open');

        search.value = '';
        renderLists('');
        updateTriggerLabel();   // теперь бейдж показывает draft
        updateCounter();
        updateDoneButton();

        history.pushState({ filterOpen: true }, '');
        setTimeout(() => search.focus(), 50);
    }

    /* ---------- закрытие без применения ---------- */

    function resetBadgeAfterClose() {
        // Draft отбрасывается — бейдж/счётчик возвращаются к applied.
        updateTriggerLabel();
        updateCounter();
    }

    function closeFilter() {
        if (!root.classList.contains('open')) return;

        if (history.state && history.state.filterOpen) {
            history.back();   // popstate закроет и обновит бейдж
        } else {
            root.classList.remove('open');
            resetBadgeAfterClose();
        }
    }

    /* ---------- обработчики ---------- */

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
            commitDrafts();
            // Закрываем дропдаун — те же ветки, что и в closeFilter,
            // но без повторного обновления бейджа (commitDrafts уже сделал).
            if (history.state && history.state.filterOpen) {
                history.back();
            } else {
                root.classList.remove('open');
            }
        });
    }

    window.addEventListener('popstate', () => {
        if (root.classList.contains('open')) {
            root.classList.remove('open');
            resetBadgeAfterClose();
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

        state.draftGroups.clear();
        state.draftTeachers.clear();
        for (const g of state.groups)   state.draftGroups.add(g);
        for (const t of state.teachers) state.draftTeachers.add(t);

        renderLists(search.value);
        updateTriggerLabel();
        updateCounter();
        updateDoneButton();
    });

    clearBtn.addEventListener('click', e => {
        e.stopPropagation();

        state.draftGroups.clear();
        state.draftTeachers.clear();

        renderLists(search.value);
        updateTriggerLabel();
        updateCounter();
        updateDoneButton();
    });

    dropdown.addEventListener('click', e => e.stopPropagation());

    updateTriggerLabel();
    updateCounter();
    updateDoneButton();

    window.addEventListener('resize', () => {
        import('./render.js').then(m => m.updateDateLabel());
    });
}