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

/* ---------- pending changes: жить между визитами ---------- */

const PENDING_CHANGES_KEY = 'schedule-pending-changes';

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

  // Постоянный список изменений «с прошлого визита».
  // Живёт в localStorage, переживает reload, перезаписывается
  // только когда приходит новая порция изменений.
  pendingChanges: loadPendingChanges(),

  // === URL CONTEXT (deep links) ===
  // true — страница открыта по ссылке с параметрами. Пока true,
  // ни одна save-функция не пишет в localStorage. Снимается при
  // первом же клике пользователя.
  urlContext: false,
  urlEventId: null,
  // Сырые параметры из URL, до валидации (см. resolveUrlContext).
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

/* ============================================================
 *  URL CONTEXT (deep links)
 * ============================================================ */

/**
 * ШАГ 1 — только парсинг. Не трогает selectedGroups/Teachers,
 * потому что на этом этапе ещё нет state.groups/state.teachers.
 *
 * Сразу применяет v и d (они не зависят от данных), остальное
 * складывает в state.urlRaw для последующей валидации.
 *
 * Возвращает true, если в URL был хотя бы один известный параметр.
 */
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

  if (raw.v && ['month', 'week', 'day'].includes(raw.v)) {
    state.view = raw.v;
  }
  if (raw.d) {
    const parts = raw.d.split('-').map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      state.currentDate = new Date(parts[0], parts[1] - 1, parts[2]);
    }
  }

  return true;
}

/**
 * ШАГ 2 — валидация. Вызывается ПОСЛЕ того, как построены
 * state.groups, state.teachers и state.allEvents.
 *
 * Возвращает:
 *   'empty'   — URL вообще без параметров (обычный заход);
 *   'full'    — все параметры применились;
 *   'partial' — что-то применилось, что-то отброшено как невалидное;
 *   'none'    — параметры были, но ничего валидного, откатились.
 */
export function resolveUrlContext() {
  if (!state.urlRaw) return 'empty';

  const { g, t, v, d, e } = state.urlRaw;
  const knownGroups   = new Set(state.groups);
  const knownTeachers = new Set(state.teachers);

  let total   = 0;
  let matched = 0;

  // --- groups ---
  if (g !== null) {
    total++;
    const list = g ? g.split(',').map(s => s.trim()).filter(Boolean) : [];
    const kept = list.filter(x => knownGroups.has(x));
    state.selectedGroups = new Set(kept);
    // Пустая строка `?g=` — явный «без групп», считается применённой.
    if (g === '' || kept.length > 0) matched++;
  }

  // --- teachers ---
  if (t !== null) {
    total++;
    const list = t ? t.split(',').map(s => s.trim()).filter(Boolean) : [];
    const kept = list.filter(x => knownTeachers.has(x));
    state.selectedTeachers = new Set(kept);
    if (t === '' || kept.length > 0) matched++;
  }

  // --- view ---
  if (v !== null) {
    total++;
    if (['month', 'week', 'day'].includes(v)) matched++;
  }

  // --- date ---
  if (d !== null) {
    total++;
    const parts = d.split('-').map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) matched++;
  }

  // --- event ---
  if (e) {
    total++;
    const exists = state.allEvents.some(ev => ev.event_id === e);
    if (exists) matched++;
    else state.urlEventId = null;
  }

  if (matched === 0) {
    // Ничего валидного — полный откат в обычный режим.
    restoreFromStorage();
    state.urlRaw     = null;
    state.urlContext = false;
    state.urlEventId = null;
    return 'none';
  }

  state.urlContext = true;
  state.urlEventId = e || null;
  return matched === total ? 'full' : 'partial';
}

/** Возвращает state к значениям из localStorage (для отката). */
function restoreFromStorage() {
  state.selectedGroups   = loadSetFromStorage('schedule-selected-groups');
  state.selectedTeachers = loadSetFromStorage('schedule-selected-teachers');
  state.view        = localStorage.getItem('schedule-view') || 'week';
  state.currentDate = loadCurrentDate() || new Date();
}

export function disarmUrlContext() {
  state.urlContext = false;
}