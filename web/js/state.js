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
    if (state.urlContext) return;
    try {
        localStorage.setItem(key, JSON.stringify([...set]));
    } catch {}
}

/* ---------- pending changes ---------- */

const PENDING_CHANGES_KEY = 'schedule-pending-changes';

/* ---------- favorites: ключи (объявлены ДО state) ---------- */

const FAV_ACTIVE_KEY = 'schedule-favorites-active';
const PREV_FILTER_KEY = 'schedule-prev-filter';

/* ---------- view / navStep: читаем ДО state ---------- */

function loadViewFromStorage() {
    try {
        const v = localStorage.getItem('schedule-view');
        if (v === 'month' || v === 'week' || v === 'day' || v === 'load') {
            return v;
        }
    } catch {}
    return 'week';
}

function loadNavStepFromStorage() {
    try {
        const v = localStorage.getItem('schedule-nav-step');
        if (v === 'month' || v === 'week' || v === 'day') return v;
    } catch {}
    const view = loadViewFromStorage();
    if (view === 'month' || view === 'week' || view === 'day') return view;
    return 'week';
}

export function savePendingChanges(changes) {
  try {
    if (!Array.isArray(changes) || changes.length === 0) {
      localStorage.removeItem(PENDING_CHANGES_KEY);
    } else {
      localStorage.setItem(PENDING_CHANGES_KEY, JSON.stringify(changes));
    }
  } catch {}
}

export function loadPendingChanges() {
  try {
    const raw = localStorage.getItem(PENDING_CHANGES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function clearPendingChanges() {
  try { localStorage.removeItem(PENDING_CHANGES_KEY); } catch {}
}

export const state = {
  allEvents: [],
  filteredEvents: [],
  groups: [],
  teachers: [],
  selectedGroups: loadSetFromStorage('schedule-selected-groups'),
  selectedTeachers: loadSetFromStorage('schedule-selected-teachers'),

  favoritesGroups: loadSetFromStorage('schedule-favorites-groups'),
  favoritesTeachers: loadSetFromStorage('schedule-favorites-teachers'),
  prevFilter: loadPrevFilter(),
  favoritesActive: loadFavoritesActive(),

  draftGroups: new Set(),
  draftTeachers: new Set(),
  draftFavoritesGroups: new Set(),
  draftFavoritesTeachers: new Set(),
  draftFavoritesDirty: false,

  undoFilter: null,

  currentDate: loadCurrentDate() || new Date(),
  view: loadViewFromStorage(),

  // Шаг навигации стрелками (когда view === 'load').
  navStep: loadNavStepFromStorage(),

  theme: localStorage.getItem('schedule-theme') || 'auto',

  fallbackActive: false,
  currentData: null,
  displayedIso: null,
  initialRenderDone: false,
  scrollToNow: false,

  pendingChanges: loadPendingChanges(),

  urlContext: false,
  urlEventId: null,
  urlRaw: null,
};

export function saveCurrentDate(d) {
  if (state.urlContext) return;
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
  if (state.urlContext) return;
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

/** Шаг навигации для «Нагрузки». Допустимо только month/week/day. */
export function saveNavStep(step) {
  if (state.urlContext) return;
  if (step !== 'month' && step !== 'week' && step !== 'day') return;
  try { localStorage.setItem('schedule-nav-step', step); } catch {}
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
  if (state.urlContext) return;
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
  if (state.urlContext) return;
  try { if (iso) localStorage.setItem('schedule-last-generated-at', iso); } catch {}
}

export function loadGeneratedAt() {
  try { return localStorage.getItem('schedule-last-generated-at') || null; } catch { return null; }
}

/* ---------- favorites ---------- */

export function saveFavoritesActive(active) {
  if (state.urlContext) return;
  try { localStorage.setItem(FAV_ACTIVE_KEY, active ? '1' : '0'); } catch {}
}

export function loadFavoritesActive() {
  try { return localStorage.getItem(FAV_ACTIVE_KEY) === '1'; } catch { return false; }
}

export function savePrevFilter(prevFilter) {
  if (state.urlContext) return;
  try {
    if (prevFilter) {
      localStorage.setItem(PREV_FILTER_KEY, JSON.stringify({
        groups:   [...prevFilter.groups],
        teachers: [...prevFilter.teachers],
      }));
    } else {
      localStorage.removeItem(PREV_FILTER_KEY);
    }
  } catch {}
}

export function loadPrevFilter() {
  try {
    const raw = localStorage.getItem(PREV_FILTER_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return {
      groups:   Array.isArray(obj.groups)   ? obj.groups   : [],
      teachers: Array.isArray(obj.teachers) ? obj.teachers : [],
    };
  } catch { return null; }
}

/* ============================================================
 *  URL CONTEXT (deep links)
 * ============================================================ */

export function applyUrlContext() {
  const params = new URLSearchParams(location.search);
  const raw = {
    g: params.get('g'),
    t: params.get('t'),
    v: params.get('v'),
    d: params.get('d'),
    e: params.get('e'),
  };

  const hasAny = Object.values(raw).some(v => v !== null);
  if (!hasAny) return false;

  state.urlRaw = raw;

  if (raw.v && ['month', 'week', 'day', 'load'].includes(raw.v)) {
    state.view = raw.v;
    if (raw.v !== 'load') state.navStep = raw.v;
  }
  if (raw.d) {
    const parts = raw.d.split('-').map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      state.currentDate = new Date(parts[0], parts[1] - 1, parts[2]);
    }
  }

  return true;
}

export function resolveUrlContext() {
  if (!state.urlRaw) return 'empty';

  const { g, t, v, d, e } = state.urlRaw;
  const knownGroups   = new Set(state.groups);
  const knownTeachers = new Set(state.teachers);

  let total   = 0;
  let matched = 0;

  if (g !== null) {
    total++;
    const list = g ? g.split(',').map(s => s.trim()).filter(Boolean) : [];
    const kept = list.filter(x => knownGroups.has(x));
    state.selectedGroups = new Set(kept);
    if (g === '' || kept.length > 0) matched++;
  }

  if (t !== null) {
    total++;
    const list = t ? t.split(',').map(s => s.trim()).filter(Boolean) : [];
    const kept = list.filter(x => knownTeachers.has(x));
    state.selectedTeachers = new Set(kept);
    if (t === '' || kept.length > 0) matched++;
  }

  if (v !== null) {
    total++;
    if (['month', 'week', 'day', 'load'].includes(v)) matched++;
  }

  if (d !== null) {
    total++;
    const parts = d.split('-').map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) matched++;
  }

  if (e) {
    total++;
    const exists = state.allEvents.some(ev => ev.event_id === e);
    if (exists) matched++;
    else state.urlEventId = null;
  }

  if (matched === 0) {
    restoreFromStorage();
    state.urlRaw     = null;
    state.urlContext = false;
    state.urlEventId = null;
    return 'none';
  }

  state.urlContext = true;
  state.urlEventId = e || null;
  state.favoritesActive = false;

  return matched === total ? 'full' : 'partial';
}

function restoreFromStorage() {
  state.selectedGroups   = loadSetFromStorage('schedule-selected-groups');
  state.selectedTeachers = loadSetFromStorage('schedule-selected-teachers');
  state.view        = loadViewFromStorage();
  state.navStep     = loadNavStepFromStorage();
  state.currentDate = loadCurrentDate() || new Date();
}

export function disarmUrlContext() {
  state.urlContext = false;
}