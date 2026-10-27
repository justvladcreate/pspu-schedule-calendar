'use strict';

import { state } from './state.js';
import { setTheme } from './navigation.js';
import { applyFilters, updateCounter } from './filters.js';
import { render } from './render.js';
import { showToast } from './toast.js';
import {
    setupNotifications,
    enablePush,
    disablePush,
    getPushState,
    describePushError,
} from './notifications.js';

export function setupSettingsModal(exportModalApi) {
    const modal = document.getElementById('settingsModal');
    if (!modal) return { open: () => {}, close: () => {} };

    const closeBtn = modal.querySelector('.settings-close');
    const exportBtn = document.getElementById('settingsExportBtn');
    const themeBtns = modal.querySelectorAll('#themeSwitch .view-switch-btn');
    const activeOnlyToggle = document.getElementById('activeOnlyToggle');
    const tooltip = document.getElementById('settingsTooltip');
    const infoIcons = modal.querySelectorAll('.info-icon');

    function hideTooltip() {
        if (tooltip) tooltip.classList.remove('is-visible');
    }

    function showTooltip(icon) {
        if (!tooltip) return;
        const text = icon.dataset.tooltip;
        if (!text) return;

        tooltip.textContent = text;
        tooltip.classList.add('is-visible');

        const iconRect = icon.getBoundingClientRect();
        const tipRect = tooltip.getBoundingClientRect();

        // По умолчанию — над иконкой, по центру. Если сверху не хватает
        // места, показываем снизу. По горизонтали прижимаем к краям окна.
        let top = iconRect.top - tipRect.height - 8;
        if (top < 8) top = iconRect.bottom + 8;

        let left = iconRect.left + iconRect.width / 2 - tipRect.width / 2;
        const maxLeft = window.innerWidth - tipRect.width - 8;
        left = Math.min(Math.max(8, left), Math.max(8, maxLeft));

        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;
    }

    infoIcons.forEach(icon => {
        if (!icon.hasAttribute('aria-label')) {
            icon.setAttribute('aria-label', icon.dataset.tooltip || '');
        }
        icon.addEventListener('mouseenter', () => showTooltip(icon));
        icon.addEventListener('mouseleave', hideTooltip);
        icon.addEventListener('focus', () => showTooltip(icon));
        icon.addEventListener('blur', hideTooltip);
        icon.addEventListener('click', (e) => {
            e.stopPropagation();
            showTooltip(icon);
        });
    });

    const settingsBody = modal.querySelector('.settings-body');
    if (settingsBody) settingsBody.addEventListener('scroll', hideTooltip);
    window.addEventListener('resize', hideTooltip);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.info-icon')) hideTooltip();
    });

    /* ---------- push-уведомления ---------- */

    const pushApi = setupNotifications();
    const pushToggle = document.getElementById('pushToggle');
    const pushPrefsRow = document.getElementById('pushPrefsRow');
    const pushPrefsBtn = document.getElementById('pushPrefsBtn');
    const pushSummary = document.getElementById('pushSummary');
    const pushHint = document.getElementById('pushHint');

    function updatePushUI() {
        const push = getPushState();

        if (pushToggle) {
            pushToggle.checked = push.enabled;
            pushToggle.disabled = !push.supported || !push.configured;
        }

        if (pushPrefsRow) pushPrefsRow.hidden = !push.enabled;
        if (pushPrefsBtn) pushPrefsBtn.disabled = !push.enabled;

        if (pushSummary) {
            if (push.prefs.all) {
                pushSummary.textContent = 'Все изменения';
            } else {
                const parts = [];
                if (push.prefs.groups.length) parts.push(`групп: ${push.prefs.groups.length}`);
                if (push.prefs.teachers.length) parts.push(`преподавателей: ${push.prefs.teachers.length}`);
                pushSummary.textContent = parts.length ? parts.join(' · ') : 'Ничего не выбрано';
            }
        }

        if (pushHint) {
            pushHint.textContent = push.hint;
            pushHint.hidden = !push.hint;
        }
    }

    if (pushToggle) {
        pushToggle.addEventListener('change', async () => {
            if (pushToggle.checked) {
                pushToggle.disabled = true;
                const result = await enablePush();
                pushToggle.disabled = false;

                if (!result.ok) {
                    pushToggle.checked = false;
                    console.warn('[push] enable failed:', result.error);
                    showToast(`Не удалось включить: ${describePushError(result.error)}`, 5000);
                } else {
                    showToast('Уведомления включены');
                }
            } else {
                await disablePush();
                showToast('Уведомления отключены');
            }

            updatePushUI();
        });
    }

    if (pushPrefsBtn) {
        pushPrefsBtn.addEventListener('click', () => {
            pushApi.openPrefs();
        });
    }

    document.addEventListener('pushstatechange', updatePushUI);

    function close() {
        hideTooltip();
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
        updatePushUI();
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
        if (e.key !== 'Escape' || !modal.classList.contains('open')) return;
        // Если поверх открыта настройка уведомлений — закрываем только её.
        const pushModal = document.getElementById('pushModal');
        if (pushModal && pushModal.classList.contains('open')) return;
        close();
    });

    exportBtn.addEventListener('click', () => {
        close();
        if (exportModalApi) exportModalApi.open();
    });

    updatePushUI();

    return { open, close };
}