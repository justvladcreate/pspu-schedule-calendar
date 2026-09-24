'use strict';

import { normalizeKey } from './state.js';

/**
 * Превращает raw event из data.json в "entry" для сравнения.
 * Одна запись = одно событие (не expanded).
 */
function toEntry(ev) {
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

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function toSet(arr) {
  return new Set(arr || []);
}

function roomsToSet(rooms) {
  return new Set(
    String(rooms || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
}

/** Разница двух массивов: какие элементы только в old, какие только в new. */
function diffArray(oldArr, newArr) {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  return {
    onlyOld: oldArr.filter(x => !newSet.has(x)),
    onlyNew: newArr.filter(x => !oldSet.has(x)),
  };
}

function diffEntry(oldE, newE) {
  const fields = [];

  if (oldE.time_start !== newE.time_start) {
    fields.push({ name: 'time_start', old: oldE.time_start, new: newE.time_start });
  }
  if (oldE.time_end !== newE.time_end) {
    fields.push({ name: 'time_end', old: oldE.time_end, new: newE.time_end });
  }

  const oldT = [...toSet(oldE.teachers)];
  const newT = [...toSet(newE.teachers)];
  if (!setsEqual(new Set(oldT), new Set(newT))) {
    const { onlyOld, onlyNew } = diffArray(oldT, newT);
    fields.push({ name: 'teachers', old: oldT, new: newT, onlyOld, onlyNew });
  }

  const oldD = [...toSet(oldE.dates)];
  const newD = [...toSet(newE.dates)];
  if (!setsEqual(new Set(oldD), new Set(newD))) {
    const { onlyOld, onlyNew } = diffArray(oldD, newD);
    fields.push({ name: 'dates', old: oldD, new: newD, onlyOld, onlyNew });
  }

  const oldR = [...roomsToSet(oldE.rooms)];
  const newR = [...roomsToSet(newE.rooms)];
  if (!setsEqual(new Set(oldR), new Set(newR))) {
    const { onlyOld, onlyNew } = diffArray(oldR, newR);
    fields.push({ name: 'rooms', old: oldR, new: newR, onlyOld, onlyNew });
  }

  if ((oldE.comment || '') !== (newE.comment || '')) {
    fields.push({ name: 'comment', old: oldE.comment || '', new: newE.comment || '' });
  }

  return fields;
}

/**
 * Сравнивает old snapshot (массив entries) с new events (raw из data.json).
 * Возвращает массив изменений: { type, key, old, new, fields? }.
 */
export function compareEvents(oldSnapshot, newEvents) {
  const oldMap = new Map((oldSnapshot || []).map(e => [e.key, e]));
  const newMap = new Map();
  for (const ev of newEvents || []) {
    const entry = toEntry(ev);
    newMap.set(entry.key, entry);
  }

  const changes = [];

  for (const [key, oldE] of oldMap) {
    if (!newMap.has(key)) {
      changes.push({ type: 'removed', key, old: oldE, new: null });
    }
  }

  for (const [key, newE] of newMap) {
    if (!oldMap.has(key)) {
      changes.push({ type: 'added', key, old: null, new: newE });
    }
  }

  for (const [key, newE] of newMap) {
    const oldE = oldMap.get(key);
    if (!oldE) continue;
    const fields = diffEntry(oldE, newE);
    if (fields.length > 0) {
      changes.push({ type: 'changed', key, old: oldE, new: newE, fields });
    }
  }

  return changes;
}

/** 'DD.MM.YYYY' → 'YYYY-MM-DD' */
function ruToIso(d) {
  const [day, month, year] = String(d).split('.');
  if (!day || !month || !year) return '';
  return `${year}-${month}-${day}`;
}

/**
 * Сортировка по варианту C:
 *   1. Сначала события с будущими датами (min future ascending).
 *   2. Потом события только с прошлыми (max past descending).
 *   3. События без дат — в конец.
 */
export function sortChanges(changes, todayIso) {
  if (!todayIso) todayIso = new Date().toISOString().slice(0, 10);

  function keyOf(ch) {
    const ev = ch.new || ch.old;
    const dates = (ev.dates || []).map(ruToIso).filter(Boolean);
    if (dates.length === 0) return { group: 2, date: '', dir: 1 };

    const future = dates.filter(d => d >= todayIso).sort();
    if (future.length > 0) return { group: 0, date: future[0], dir: 1 };

    const past = dates.filter(d => d < todayIso).sort().reverse();
    return { group: 1, date: past[0], dir: -1 };
  }

  return [...changes].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka.group !== kb.group) return ka.group - kb.group;
    if (ka.date !== kb.date) {
      const cmp = ka.date < kb.date ? -1 : ka.date > kb.date ? 1 : 0;
      return cmp * ka.dir;
    }
    const ea = a.new || a.old;
    const eb = b.new || b.old;
    const ga = String(ea.group || '');
    const gb = String(eb.group || '');
    if (ga !== gb) return ga.localeCompare(gb);
    return (ea.pair_number || 0) - (eb.pair_number || 0);
  });
}