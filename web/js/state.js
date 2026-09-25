'use strict';

import { toISO } from './utils.js';

export function loadSetFromStorage(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set();
    }
}

export function saveSetToStorage(key, set) {
    try {
        localStorage.setItem(key, JSON.stringify([...set]));
    } catch {}
}

export const state = {
  allEvents: [],
  filteredEvents: [],
  groups: [],
  teachers: [],
  selectedGroups: loadSetFromStorage('schedule-selected-groups'),
  selectedTeachers: loadSetFromStorage('schedule-selected-teachers'),

  // === FAVORITES ===
  favoritesGroups: loadSetFromStorage('schedule-favorites-groups'),
  favoritesTeachers: loadSetFromStorage('schedule-favorites-teachers'),
  prevFilter: null,
  favoritesActive: false,
  // =================

  // === DRAFT (черновик фильтра, пока открыт дропдаун) ===
  draftGroups: new Set(),
  draftTeachers: new Set(),
  draftFavoritesGroups: new Set(),
  draftFavoritesTeachers: new Set(),
  draftFavoritesDirty: false,

  // Снимок предыдущего применённого состояния — для кнопки «Вернуть» в toast.
  undoFilter: null,
  // ======================================================

  currentDate: loadCurrentDate() || new Date(),
  view: localStorage.getItem('schedule-view') || 'week',
  theme: localStorage.getItem('schedule-theme') || 'auto',

  // true — только когда: онлайн + data.json битый.
  // В оффлайне фоллбэк на old_data.json всегда тихий.
  fallbackActive: false,

  currentData: null,
  displayedIso: null,
  initialRenderDone: false,
  scrollToNow: false,
  pendingChanges: [],
};

export function saveCurrentDate(d) {
  try { localStorage.setItem('schedule-current-date', toISO(d)); } catch {}
}
export function loadCurrentDate() {
  try {
    const s = localStorage.getItem('schedule-current-date');
    if (!s) return null;
    const [y, m, day] = s.split('-').map(Number);
    if (!y || !m || !day) return null;
    return new Date(y, m - 1, day);
  } catch { return null; }
}

export function saveScrollMemory(view, data) {
  try { localStorage.setItem('schedule-scroll-' + view, JSON.stringify(data)); } catch {}
}
export function loadScrollMemory(view) {
  try {
    const raw = localStorage.getItem('schedule-scroll-' + view);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveDayColWidth(px) {
  try { localStorage.setItem('schedule-day-col-width', String(px)); } catch {}
}
export function loadDayColWidth() {
  try {
    const s = localStorage.getItem('schedule-day-col-width');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export function normalizeKey(ev) {
  return [
    ev.group || '',
    ev.weekday || '',
    ev.pair_number || '',
    ev.discipline || '',
    ev.subgroup || '',
  ].join('|');
}

function makeSnapshotEntry(ev) {
  return {
    key: normalizeKey(ev),
    event_id: ev.event_id,
    group: ev.group,
    weekday: ev.weekday,
    pair_number: ev.pair_number,
    time_start: ev.time_start,
    time_end: ev.time_end,
    discipline: ev.discipline,
    type: ev.type,
    subgroup: ev.subgroup,
    teachers: [...(ev.teachers || [])],
    dates: [...(ev.dates || [])],
    rooms: ev.rooms || '',
    comment: ev.comment || '',
    position: ev.position,
  };
}

export function saveSnapshot(events) {
  try {
    localStorage.setItem('schedule-snapshot', JSON.stringify(events.map(makeSnapshotEntry)));
  } catch {}
}
export function loadSnapshot() {
  try {
    const raw = localStorage.getItem('schedule-snapshot');
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

export function saveGeneratedAt(iso) {
  try { if (iso) localStorage.setItem('schedule-last-generated-at', iso); } catch {}
}
export function loadGeneratedAt() {
  try { return localStorage.getItem('schedule-last-generated-at') || null; } catch { return null; }
}