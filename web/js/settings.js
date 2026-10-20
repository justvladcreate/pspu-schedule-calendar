'use strict';

import { state } from './state.js';
import { setTheme } from './navigation.js';
import { applyFilters, updateCounter } from './filters.js';
import { render } from './render.js';

export function setupSettingsModal(exportModalApi) {
    const modal = document.getElementById('settingsModal');
    if (!modal) return { open: () => {}, close: () => {} };

    const closeBtn = modal.querySelector('.settings-close');
    const exportBtn = document.getElementById('settingsExportBtn');
    const themeBtns = modal.querySelectorAll('#themeSwitch .view-switch-btn');
    const activeOnlyToggle = document.getElementById('activeOnlyToggle');

    function close() {
        modal.classList.remove('open');
    }

    function updateThemeUI() {
        themeBtns.forEach(btn => {
            const isActive = btn.dataset.themeVal === state.theme;
            btn.classList.toggle('is-active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
    }

    if (activeOnlyToggle) {
        activeOnlyToggle.checked = state.showOnlyActive;
        activeOnlyToggle.addEventListener('change', (e) => {
            state.showOnlyActive = e.target.checked;
            try {
                localStorage.setItem('schedule-show-only-active', state.showOnlyActive ? '1' : '0');
            } catch {}

            applyFilters();
            updateCounter();
            render(); // Мгновенная перерисовка календаря
        });
    }

    function open() {
        updateThemeUI();
        if (activeOnlyToggle) activeOnlyToggle.checked = state.showOnlyActive;
        modal.classList.add('open');
    }

    themeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            setTheme(btn.dataset.themeVal);
        });
    });

    document.addEventListener('themechanged', updateThemeUI);

    closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });

    exportBtn.addEventListener('click', () => {
        close();
        if (exportModalApi) exportModalApi.open();
    });

    return { open, close };
}