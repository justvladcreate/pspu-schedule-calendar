'use strict';

import { PAIR_MINUTES } from './config.js';
import { pad, addMinutes } from './utils.js';

/**
 * Возвращает разумный таймаут под текущий тип соединения.
 * 2G/slow-2g — 60 с, 3G — 45 с, всё остальное — 30 с.
 * Если Network Information API недоступен (Safari, Firefox mobile) —
 * дефолтные 30 с.
 */
export function pickTimeout() {
    const conn = navigator.connection
              || navigator.mozConnection
              || navigator.webkitConnection;
    if (!conn || !conn.effectiveType) return 30000;

    switch (conn.effectiveType) {
        case 'slow-2g':
        case '2g':      return 60000;
        case '3g':      return 45000;
        default:        return 30000;
    }
}

export async function loadData(url = 'data.json', {
    timeout = pickTimeout(),
    onProgress = null,
} = {}) {
    const bust = localStorage.getItem('schedule-cache-bust') || '0';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const resp = await fetch(`${url}?v=${bust}`, {
            cache: 'no-store',
            signal: controller.signal,
        });

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }

        const total = parseInt(resp.headers.get('content-length') || '0', 10);
        let text;

        // Если браузер поддерживает стриминг и мы знаем размер —
        // читаем по кускам и рапортуем о прогрессе.
        if (onProgress && total > 0 && resp.body && resp.body.getReader) {
            const reader = resp.body.getReader();
            const chunks = [];
            let received = 0;
            let lastPct = -1;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;

                // До 99% включительно — прогресс. 100% не показываем:
                // впереди ещё JSON.parse + re-render, "100%" висел бы
                // на экране как "зависло".
                const pct = Math.min(99, Math.round(received / total * 100));
                if (pct !== lastPct) {
                    lastPct = pct;
                    try { onProgress(pct); } catch {}
                }
            }

            const blob = new Blob(chunks);
            text = await blob.text();
        } else {
            text = await resp.text();
        }

        if (!text || !text.trim()) {
            throw new Error('пустой ответ');
        }

        try {
            return JSON.parse(text);
        } catch {
            throw new Error('некорректный JSON');
        }
    } finally {
        clearTimeout(timer);
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