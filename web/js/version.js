'use strict';

import { MONTHS_GEN } from './config.js';
import { state, saveSetToStorage } from './state.js';
import { pad } from './utils.js';
import { loadData, expandEvents } from './data.js';
import { render } from './render.js';
import { applyFilters, updateTriggerLabel, updateCounter } from './filters.js';
import { showToast } from './toast.js';

export function updateUpdatedLabel(iso) {
    const el = document.getElementById('updatedTime');
    const btn = document.getElementById('updatedBtn');
    if (!iso) {
        el.textContent = '—';
        btn.setAttribute('aria-label', 'Обновлено: неизвестно');
        return;
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        el.textContent = '—';
        return;
    }
    const relative = formatRelativeTime(d);
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const full = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;

    el.textContent = relative;
    btn.setAttribute('aria-label', `Обновлено: ${full}. Нажмите, чтобы переключить версию`);
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

export function setupVersionToggle() {
    const btn = document.getElementById('updatedBtn');
    btn.addEventListener('click', async () => {
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