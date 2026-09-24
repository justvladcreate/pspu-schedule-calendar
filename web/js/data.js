'use strict';

import { PAIR_MINUTES } from './config.js';
import { pad, addMinutes } from './utils.js';

export async function loadData(url = 'data.json') {
    const bust = localStorage.getItem('schedule-cache-bust') || '0';
    const resp = await fetch(`${url}?v=${bust}`);

    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
    }

    let text;
    try {
        text = await resp.text();
    } catch {
        throw new Error('не удалось прочитать ответ');
    }

    if (!text || !text.trim()) {
        throw new Error('пустой ответ');
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new Error('некорректный JSON');
    }
}

export function expandEvents(rawEvents) {
    const out = [];
    for (const ev of rawEvents) {
        if (!ev.dates || !Array.isArray(ev.dates) || ev.dates.length === 0) continue;
        if (!ev.time_start) continue;
        for (const ds of ev.dates) {
            if (typeof ds !== 'string' || !ds) continue;
            const parts = ds.split('.').map(Number);
            if (parts.length !== 3) continue;
            const [d, m, y] = parts;
            out.push({
                ...ev,
                dateObj: new Date(y, m - 1, d),
                dateISO: `${y}-${pad(m)}-${pad(d)}`,
                endTime: ev.time_end || addMinutes(ev.time_start, PAIR_MINUTES),
                uniqueId: `${ev.event_id}__${ds}`,
            });
        }
    }
    return out;
}

export function groupByDate(events) {
    const m = new Map();
    for (const e of events) {
        if (!m.has(e.dateISO)) m.set(e.dateISO, []);
        m.get(e.dateISO).push(e);
    }
    for (const list of m.values()) list.sort((a, b) => a.time_start.localeCompare(b.time_start));
    return m;
}