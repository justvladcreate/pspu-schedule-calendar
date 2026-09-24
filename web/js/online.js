'use strict';

import { state } from './state.js';
import { updateUpdatedLabel } from './version.js';

const MONTHS_GEN = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function isOnline() {
    return navigator.onLine !== false;
}

function pad(n) {
    return String(n).padStart(2, '0');
}

function formatLongDate(d) {
    return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function updateOnlineStatus() {
    const wrap   = document.getElementById('updatedWrap');
    const prefix = document.getElementById('updatedPrefix');
    const btn    = document.getElementById('updatedBtn');
    if (!wrap || !prefix || !btn) return;

    if (isOnline()) {
        wrap.classList.remove('is-offline');
        prefix.textContent = 'Обновлено:';
        btn.setAttribute('aria-label', 'Обновлено. Нажмите, чтобы посмотреть изменения.');
    } else {
        wrap.classList.add('is-offline');
        prefix.textContent = 'Оффлайн ·';
        btn.setAttribute('aria-label', 'Оффлайн режим. Нажмите для подробностей.');
    }

    if (state.displayedIso) updateUpdatedLabel(state.displayedIso);
}

function openOfflineModal() {
    const modal = document.getElementById('offlineModal');
    if (!modal) return;

    const timeEl = document.getElementById('offlineTime');
    if (timeEl) {
        if (state.displayedIso) {
            const d = new Date(state.displayedIso);
            timeEl.textContent = isNaN(d.getTime()) ? '—' : formatLongDate(d);
        } else {
            timeEl.textContent = '—';
        }
    }
    modal.classList.add('open');
}

function closeOfflineModal() {
    const modal = document.getElementById('offlineModal');
    if (modal) modal.classList.remove('open');
}

/**
 * Оффлайновый «refresh».
 *
 * location.reload() в ряде браузеров (особенно мобильный Chrome) при
 * оффлайне уходит мимо Service Worker и роняет навигацию в сеть → dino.
 * Мягкая навигация через смену URL заставляет браузер пройти обычным
 * путём через fetch-обработчик SW.
 */
function softReload() {
    const clean = location.href.split('#')[0];
    // добавляем безобидный маркер, чтобы URL формально отличался
    const sep = clean.includes('?') ? '&' : '?';
    location.href = clean + sep + '_r=' + Date.now();
}

export function setupOnlineStatus() {
    const btn   = document.getElementById('updatedBtn');
    const modal = document.getElementById('offlineModal');

    if (btn) {
        btn.addEventListener('click', (e) => {
            if (isOnline()) return;
            e.stopImmediatePropagation();
            e.preventDefault();
            openOfflineModal();
        }, true);
    }

    if (modal) {
        const closeBtn   = modal.querySelector('.offline-close');
        const refreshBtn = modal.querySelector('.offline-refresh');

        if (closeBtn) closeBtn.addEventListener('click', closeOfflineModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeOfflineModal();
        });
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                if (isOnline()) location.reload();
                else softReload();
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('open')) {
                closeOfflineModal();
            }
        });
    }

    window.addEventListener('online',  updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);

    updateOnlineStatus();
}