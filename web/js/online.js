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

/**
 * Последняя известная ISO-метка версии.
 * Приоритет: state → currentData → localStorage.
 */
function getDisplayedIso() {
    if (state.displayedIso) return state.displayedIso;

    if (state.currentData && state.currentData.generated_at) {
        state.displayedIso = state.currentData.generated_at;
        return state.displayedIso;
    }

    try {
        const ls = localStorage.getItem('schedule-last-generated-at');
        if (ls) {
            state.displayedIso = ls;
            return ls;
        }
    } catch {}

    return null;
}

/**
 * Три состояния updatedBtn:
 *   1. Оффлайн   → ⚡, «Оффлайн ·»  + относительное время.
 *   2. Fallback  → ⚠, «Не загрузилось · обновить» (только онлайн).
 *   3. Норма     → ⏱, «Обновлено:» + относительное время.
 */
export function updateOnlineStatus() {
    const wrap   = document.getElementById('updatedWrap');
    const prefix = document.getElementById('updatedPrefix');
    const timeEl = document.getElementById('updatedTime');
    const btn    = document.getElementById('updatedBtn');
    if (!wrap || !prefix || !btn) return;

    wrap.classList.remove('is-fallback');
    wrap.classList.remove('is-offline');

    const iso = getDisplayedIso();

    // 1. Оффлайн
    if (!isOnline()) {
        wrap.classList.add('is-offline');
        prefix.textContent = 'Оффлайн ·';
        btn.setAttribute('aria-label', 'Оффлайн режим. Нажмите для подробностей.');
        if (iso) updateUpdatedLabel(iso);
        else if (timeEl) timeEl.textContent = '—';
        return;
    }

    // 2. Fallback
    if (state.fallbackActive) {
        wrap.classList.add('is-fallback');
        prefix.textContent = 'Не загрузилось ·';
        btn.setAttribute('aria-label',
            'Свежая версия не загрузилась, показана прошлая. Нажмите, чтобы повторить.');
        if (timeEl) timeEl.textContent = 'обновить';
        return;
    }

    // 3. Норма
    prefix.textContent = 'Обновлено:';
    btn.setAttribute('aria-label', 'Обновлено. Нажмите, чтобы посмотреть изменения.');
    if (iso) updateUpdatedLabel(iso);
    else if (timeEl) timeEl.textContent = '—';
}

function openOfflineModal() {
    const modal = document.getElementById('offlineModal');
    if (!modal) return;

    // no-data = у нас реально нет данных. Проверяем state.currentData,
    // а не iso из localStorage — iso может остаться от прошлой сессии,
    // когда данных в этой уже нет.
    const hasData = !!state.currentData;
    modal.classList.toggle('no-data', !hasData);

    if (hasData) {
        const iso = getDisplayedIso();
        if (iso) {
            const timeEl = document.getElementById('offlineTime');
            if (timeEl) {
                const d = new Date(iso);
                timeEl.textContent = isNaN(d.getTime()) ? '—' : formatLongDate(d);
            }
        }
    }
    modal.classList.add('open');
}

function closeOfflineModal() {
    const modal = document.getElementById('offlineModal');
    if (modal) modal.classList.remove('open');
}

function softReload() {
    const clean = location.href.split('#')[0];
    const sep = clean.includes('?') ? '&' : '?';
    location.href = clean + sep + '_r=' + Date.now();
}

export function setupOnlineStatus() {
    const btn   = document.getElementById('updatedBtn');
    const modal = document.getElementById('offlineModal');

    if (btn) {
        btn.addEventListener('click', (e) => {
            if (!isOnline()) {
                e.stopImmediatePropagation();
                e.preventDefault();
                openOfflineModal();
                return;
            }
            if (state.fallbackActive) {
                e.stopImmediatePropagation();
                e.preventDefault();
                location.reload();
                return;
            }
            // Норма → пропускаем к setupUpdatedButton.
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