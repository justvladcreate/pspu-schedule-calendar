'use strict';

import { state, saveSetToStorage } from './state.js';
import { escapeHtml } from './utils.js';
import { loadData, expandEvents } from './data.js';

import { render, updateDateLabel } from './render.js';
import { applyFilters, setupUnifiedFilter, updateTriggerLabel, updateCounter } from './filters.js';
import {
    navigate, goToToday, cycleView, toggleTheme,
    updateViewButton, updateThemeButton,
} from './navigation.js';
import { setupVersionToggle, updateUpdatedLabel } from './version.js';
import { setupReadmeModal } from './readme.js';
import { setupExportModal } from './export.js';
import { setupCalendarGestures, setupPullToRefresh } from './gestures.js';
import { openDatePicker, closeDatePicker, renderPicker, pickerState } from './datePicker.js';
import { hideEventDetails } from './popover.js';

async function init() {
    document.documentElement.setAttribute('data-theme', state.theme);
    updateViewButton();
    updateThemeButton();

    let currentData;
    try {
        currentData = await loadData('data.json');
    } catch (e) {
        document.getElementById('calendar').innerHTML =
            `<div class="empty-state">Не удалось загрузить расписание: ${escapeHtml(e.message)}</div>`;
        return;
    }

    state.currentData = currentData;
    state.allEvents = expandEvents(currentData.events || []);
    updateUpdatedLabel(currentData.generated_at || null);

    const groups = new Set();
    const teachers = new Set();
    for (const ev of state.allEvents) {
        if (ev.group) groups.add(ev.group);
        (ev.teachers || []).forEach(t => teachers.add(t));
    }
    state.groups = [...groups].sort();
    state.teachers = [...teachers].sort();

    for (const g of [...state.selectedGroups]) {
        if (!state.groups.includes(g)) state.selectedGroups.delete(g);
    }
    for (const t of [...state.selectedTeachers]) {
        if (!state.teachers.includes(t)) state.selectedTeachers.delete(t);
    }
    saveSetToStorage('schedule-selected-groups', state.selectedGroups);
    saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);

    applyFilters();
    setupUnifiedFilter();
    const exportModal = setupExportModal();
    document.getElementById('exportIcsBtn').addEventListener('click', exportModal.open);
    setupVersionToggle();

    document.getElementById('prevBtn').addEventListener('click', () => navigate(-1));
    document.getElementById('nextBtn').addEventListener('click', () => navigate(1));
    document.getElementById('todayBtn').addEventListener('click', goToToday);
    document.getElementById('viewBtn').addEventListener('click', cycleView);
    document.getElementById('themeBtn').addEventListener('click', toggleTheme);
    document.getElementById('dateLabel').addEventListener('click', openDatePicker);

    document.getElementById('pickerPrev').addEventListener('click', () => {
        pickerState.month--;
        if (pickerState.month < 0) { pickerState.month = 11; pickerState.year--; }
        renderPicker();
    });
    document.getElementById('pickerNext').addEventListener('click', () => {
        pickerState.month++;
        if (pickerState.month > 11) { pickerState.month = 0; pickerState.year++; }
        renderPicker();
    });
    document.getElementById('dateModal').addEventListener('click', e => {
        if (e.target.id === 'dateModal') closeDatePicker();
    });

    document.addEventListener('click', (e) => {
        hideEventDetails();
        if (window.innerWidth > 900) {
            const filterRoot = document.getElementById('filterRoot');
            if (filterRoot && filterRoot.classList.contains('open') && !filterRoot.contains(e.target)) {
                filterRoot.classList.remove('open');
                if (history.state && history.state.filterOpen) history.back();
            }
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            hideEventDetails();
            closeDatePicker();
        }
    });

    setupPullToRefresh();
    setupCalendarGestures();
    setupReadmeModal();
    render();
    setInterval(() => {
        if (state.displayedIso) updateUpdatedLabel(state.displayedIso);
    }, 60 * 1000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}