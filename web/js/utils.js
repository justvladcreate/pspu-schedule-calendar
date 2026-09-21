'use strict';

export const pad = n => String(n).padStart(2, '0');
export const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const isToday = d => isSameDay(d, new Date());
export const escapeHtml = s => {
    const div = document.createElement('div');
    div.textContent = String(s ?? '');
    return div.innerHTML;
};

export function addMinutes(t, m) {
    const [h, mm] = t.split(':').map(Number);
    const total = h * 60 + mm + m;
    return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

export function timeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

export function startOfWeek(d) {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    const day = r.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    r.setDate(r.getDate() + diff);
    return r;
}

export function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
}

export function addMonths(d, n) {
    const r = new Date(d);
    r.setDate(1);
    r.setMonth(r.getMonth() + n);
    return r;
}