'use strict';

import { state } from './state.js';
import { setTheme } from './navigation.js';

export function setupSettingsModal(exportModalApi) {
    const modal = document.getElementById('settingsModal');
    if (!modal) return { open: () => {}, close: () => {} };

    const closeBtn = modal.querySelector('.settings-close');
    const exportBtn = document.getElementById('settingsExportBtn');
    const themeBtns = modal.querySelectorAll('#themeSwitch .view-switch-btn');

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

    function open() {
        updateThemeUI();
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