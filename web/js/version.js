'use strict';

import { MONTHS_GEN } from './config.js';
import { state, saveSetToStorage } from './state.js';
import { pad } from './utils.js';
import { loadData, expandEvents } from './data.js';
import { render } from './render.js';
import { applyFilters, updateTriggerLabel, updateCounter } from './filters.js';
import { showToast } from './toast.js';

/**
 * Обновляет ТОЛЬКО относительное время в #updatedTime.
 * aria-label и префикс — ответственность online.js (updateOnlineStatus).
 */
export function updateUpdatedLabel(iso) {
    const el = document.getElementById('updatedTime');
    if (!el) return;

    if (!iso) {
        el.textContent = '—';
        return;
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        el.textContent = '—';
        return;
    }
    el.textContent = formatRelativeTime(d);
}

export function formatRelativeTime(dateObj) {
    const diffMs = Date.now() - dateObj.getTime();
    if (diffMs < 0) return 'только что';

    const sec   = Math.floor(diffMs / 1000);
    const min   = Math.floor(sec / 60);
    const hour  = Math.floor(min / 60);
    const day   = Math.floor(hour / 24);
    const month = Math.floor(day / 30);

    if (min < 1)     return 'только что';
    if (min < 60)    return `${min} ${pluralRu(min, 'минуту', 'минуты', 'минут')} назад`;
    if (hour < 24)   return `${hour} ${pluralRu(hour, 'час', 'часа', 'часов')} назад`;
    if (day < 30)    return `${day} ${pluralRu(day, 'день', 'дня', 'дней')} назад`;
    if (month < 12)  return `${month} ${pluralRu(month, 'месяц', 'месяца', 'месяцев')} назад`;
    return 'больше года назад';
}

export function pluralRu(n, one, few, many) {
    const mod10  = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

export function updateVersionUi() {
    const wrap = document.getElementById('updatedWrap');
    const sub  = document.getElementById('updatedSub');
    if (!wrap || !sub) return;
    if (state.viewingOld) {
        wrap.classList.add('is-old');
        sub.hidden = false;
    } else {
        wrap.classList.remove('is-old');
        sub.hidden = true;
    }
}

export function applyData(data) {
    state.allEvents = expandEvents(data.events || []);
    state.displayedIso = data.generated_at || null;
    updateUpdatedLabel(state.displayedIso);
    updateVersionUi();

    const groups = new Set();
    const teachers = new Set();
    for (const ev of state.allEvents) {
        if (ev.group) groups.add(ev.group);
        (ev.teachers || []).forEach(t => teachers.add(t));
    }
    state.groups   = [...groups].sort();
    state.teachers = [...teachers].sort();

    saveSetToStorage('schedule-selected-groups',   state.selectedGroups);
    saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);

    applyFilters();
    updateTriggerLabel();
    updateCounter();
    render('fade');
}

/**
 * Временная логика toggle old/new через updatedBtn.
 * Фича 7 заменит этот вызов на открытие модалки изменений.
 *
 * В оффлайне клик перехватывает online.js — сюда управление не доходит.
 */
export function setupVersionToggle() {
    const btn = document.getElementById('updatedBtn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        // страховка на случай, если capture-перехват не сработал
        if (navigator.onLine === false) return;

        if (state.viewingOld) {
            state.viewingOld = false;
            applyData(state.currentData);
            showToast('Вы просматриваете текущую версию');
            return;
        }
        try {
            const oldData = await loadData('old_data.json');
            state.viewingOld = true;
            applyData(oldData);
            showToast('Вы просматриваете старую версию');
        } catch (e) {
            console.warn('Прошлая версия недоступна:', e);
            showToast('Старая версия недоступна');
            btn.disabled = true;
            btn.setAttribute('title', 'Прошлая версия пока недоступна');
        }
    });
}