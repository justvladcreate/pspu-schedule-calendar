'use strict';

import { MAX_INLINE_EVENTS } from './config.js';
import { timeToMinutes } from './utils.js';

export function layoutDayEvents(events) {
    if (events.length === 0) return [];

    const sorted = [...events].sort((a, b) => {
        const ta = timeToMinutes(a.time_start);
        const tb = timeToMinutes(b.time_start);
        if (ta !== tb) return ta - tb;
        return timeToMinutes(a.endTime) - timeToMinutes(b.endTime);
    });

    const clusters = [];
    let current = [];
    let currentEnd = -1;

    for (const ev of sorted) {
        const start = timeToMinutes(ev.time_start);
        const end = timeToMinutes(ev.endTime);
        if (current.length === 0 || start < currentEnd) {
            current.push(ev);
            currentEnd = Math.max(currentEnd, end);
        } else {
            clusters.push(current);
            current = [ev];
            currentEnd = end;
        }
    }
    if (current.length) clusters.push(current);

    const result = [];

    for (const cluster of clusters) {
        if (cluster.length > MAX_INLINE_EVENTS) {
            const start = cluster.reduce((min, e) => Math.min(min, timeToMinutes(e.time_start)), Infinity);
            const end = cluster.reduce((max, e) => Math.max(max, timeToMinutes(e.endTime)), -Infinity);
            result.push({
                type: 'group',
                events: cluster,
                startMin: start,
                endMin: end,
            });
            continue;
        }

        const columns = [];
        const placement = [];

        for (const ev of cluster) {
            const start = timeToMinutes(ev.time_start);
            let placed = false;
            for (let i = 0; i < columns.length; i++) {
                const last = columns[i][columns[i].length - 1];
                if (timeToMinutes(last.endTime) <= start) {
                    columns[i].push(ev);
                    placement.push({ ev, column: i });
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                columns.push([ev]);
                placement.push({ ev, column: columns.length - 1 });
            }
        }

        const columnsCount = columns.length;
        for (const { ev, column } of placement) {
            result.push({ type: 'single', ev, column, columnsCount });
        }
    }

    return result;
}