// Cloudflare Worker: ICS-фид расписания ПГГПУ.
//
// URL-формат намеренно не содержит факультет:
//   /ics                            — всё расписание
//   /ics?groups=1237&teachers=...   — обратная совместимость
//   /g/1237                         — одна или несколько групп
//   /g/1237,1211/t/Иванов И.И.      — группы + преподаватели
//   /t/Иванов И.И.                  — только преподаватели
//
// Группы в ПГГПУ уникальны, поэтому факультет в ссылке не нужен.
// А вот имя календаря при импорте должно быть человеческим:
//   «ПГГПУ ИНЭК 1237», «ПГГПУ Матфак», «ПГГПУ ИНЭК, Матфак».

const SITE_URL = 'https://justvladcreate.github.io/pspu-schedule-calendar/';
const INDEX_URL = new URL('data/index.json', SITE_URL).href;
const LEGACY_DATA_URL = new URL('data.json', SITE_URL).href;

const TZ_OFFSET_MIN = 5 * 60; // Asia/Yekaterinburg = UTC+5 (без перехода на летнее время)
const PAIR_MINUTES = 90;

export default {
    async fetch(request) {
        const url = new URL(request.url);
        const parsed = parsePath(url.pathname, url.searchParams);

        if (!parsed) {
            return new Response(
                'Not found. Use /ics, /g/<group> or /t/<teacher>',
                { status: 404 },
            );
        }

        const { groups, teachers } = parsed;

        let schedule;
        try {
            schedule = await loadSchedule();
        } catch (error) {
            return new Response(`Failed to load schedule: ${error.message}`, {
                status: 502,
            });
        }

        const events = schedule.events.filter((ev) => {
            if (groups.length && !groups.includes(String(ev.group || ''))) return false;
            if (
                teachers.length &&
                !(ev.teachers || []).some((t) => teachers.includes(String(t)))
            ) {
                return false;
            }
            return true;
        });

        const ics = buildIcs(events, { groups, teachers }, schedule.faculties);

        return new Response(ics, {
            headers: {
                'Content-Type': 'text/calendar; charset=utf-8',
                'Content-Disposition': 'inline; filename="pspu-schedule.ics"',
                'Cache-Control': 'public, max-age=1800',
                'Access-Control-Allow-Origin': '*',
            },
        });
    },
};

/* ============================================================
 *  Загрузка расписания
 * ============================================================ */

async function fetchJson(url) {
    const bust = `${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
    const response = await fetch(url + bust, {
        headers: { Accept: 'application/json' },
        cf: { cacheTtl: 1800 },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
}

/**
 * Сначала пробуем новый формат: data/index.json + data/faculties/<id>/data.json.
 * Если индекса нет — отдаём старый монолитный data.json.
 */
async function loadSchedule() {
    try {
        const index = await fetchJson(INDEX_URL);
        if (index && Array.isArray(index.faculties) && index.faculties.length) {
            const faculties = index.faculties.map((faculty) => ({
                id: String(faculty.id || ''),
                name: faculty.name || '',
                short: faculty.short || faculty.name || '',
                folder: String(faculty.folder || `faculties/${faculty.id}`),
            }));

            const chunks = await Promise.all(
                faculties.map(async (faculty) => {
                    const folder = faculty.folder.replace(/^\/+|\/+$/g, '');
                    const dataUrl = new URL(`${folder}/data.json`, INDEX_URL).href;
                    try {
                        const data = await fetchJson(dataUrl);
                        return Array.isArray(data?.events) ? data.events : [];
                    } catch {
                        return [];
                    }
                }),
            );

            const events = chunks.flat().map((event) => {
                const faculty = faculties.find(
                    (item) => item.id === String(event.faculty_id || ''),
                );
                return {
                    ...event,
                    faculty_name: event.faculty_name || faculty?.name || '',
                    faculty_short: event.faculty_short || faculty?.short || '',
                };
            });

            if (events.length) return { events, faculties };
        }
    } catch {
        // Ниже — запасной путь для старого формата.
    }

    const legacy = await fetchJson(LEGACY_DATA_URL);
    return {
        events: Array.isArray(legacy?.events) ? legacy.events : [],
        faculties: [],
    };
}

/* ============================================================
 *  Разбор пути
 * ============================================================ */

function splitList(value) {
    return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function parsePath(pathname, searchParams) {
    if (pathname === '/ics' || pathname === '/ics/') {
        return {
            groups: splitList(
                searchParams.get('groups') || searchParams.get('group'),
            ),
            teachers: splitList(
                searchParams.get('teachers') || searchParams.get('teacher'),
            ),
        };
    }

    // /g/<groups>[/t/<teachers>]
    const gMatch = pathname.match(/^\/g\/([^/]+)(?:\/t\/(.+))?$/);
    if (gMatch) {
        return {
            groups: splitList(decodeURIComponent(gMatch[1])),
            teachers: gMatch[2] ? splitList(decodeURIComponent(gMatch[2])) : [],
        };
    }

    // /t/<teachers>
    const tMatch = pathname.match(/^\/t\/(.+)$/);
    if (tMatch) {
        return {
            groups: [],
            teachers: splitList(decodeURIComponent(tMatch[1])),
        };
    }

    return null;
}

/* ============================================================
 *  ICS
 * ============================================================ */

function buildIcs(events, meta, faculties = []) {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//pspu-schedule//RU',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${escapeIcs(calendarName(meta, events, faculties))}`,
        'X-WR-TIMEZONE:Asia/Yekaterinburg',
        'X-WR-CALDESC:Расписание ПГГПУ',
    ];

    for (const event of events) {
        for (const date of event.dates || []) {
            lines.push(...vevent(event, date));
        }
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
}

function eventStart(event, dateStr) {
    const parts = String(dateStr || '').split('.').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;

    const [day, month, year] = parts;
    const [hours, minutes] = String(event.time_start || '')
        .split(':')
        .map(Number);

    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

    // Локальное время ПГГПУ (UTC+5) → UTC.
    return new Date(
        Date.UTC(year, month - 1, day, hours, minutes) - TZ_OFFSET_MIN * 60 * 1000,
    );
}

function eventEnd(event, start) {
    const [hours, minutes] = String(event.time_end || '')
        .split(':')
        .map(Number);

    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
        const [startHours, startMinutes] = String(event.time_start || '')
            .split(':')
            .map(Number);
        const duration =
            ((hours * 60 + minutes) - (startHours * 60 + startMinutes)) * 60 * 1000;
        if (duration > 0) return new Date(start.getTime() + duration);
    }

    return new Date(start.getTime() + PAIR_MINUTES * 60 * 1000);
}

function vevent(event, dateStr) {
    const start = eventStart(event, dateStr);
    if (!start) return [];

    const end = eventEnd(event, start);
    const title = event.type
        ? `${event.discipline} (${event.type})`
        : String(event.discipline || 'Занятие');

    const description = [
        event.teachers && event.teachers.length
            ? `Преподаватель: ${event.teachers.join(', ')}`
            : '',
        event.group ? `Группа: ${event.group}` : '',
        event.subgroup ? `Подгруппа: ${event.subgroup}` : '',
        event.comment ? `Комментарий: ${event.comment}` : '',
    ]
        .filter(Boolean)
        .join('\n');

    const uidBase =
        event.event_id ||
        [
            event.faculty_id || '',
            event.group || '',
            event.weekday || '',
            event.pair_number || '',
            event.subgroup || '',
        ].join('_');

    return [
        'BEGIN:VEVENT',
        `UID:${escapeIcs(uidBase)}_${dateStr}@pspu-schedule`,
        `DTSTAMP:${icsTime(new Date())}`,
        `DTSTART:${icsTime(start)}`,
        `DTEND:${icsTime(end)}`,
        `SUMMARY:${escapeIcs(title)}`,
        `LOCATION:${escapeIcs(event.rooms || '')}`,
        `DESCRIPTION:${escapeIcs(description)}`,
        'STATUS:CONFIRMED',
        'TRANSP:OPAQUE',
        'END:VEVENT',
    ];
}

function icsTime(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcs(value) {
    return String(value || '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');
}

/* ============================================================
 *  Имя календаря
 * ============================================================ */

function calendarName(meta, events, faculties) {
    const groups = meta.groups || [];
    const facultyLabels = [];

    const byId = new Map(
        (faculties || []).map((faculty) => [
            String(faculty.id || ''),
            faculty.short || faculty.name || '',
        ]),
    );

    for (const event of events) {
        const label =
            event.faculty_short ||
            byId.get(String(event.faculty_id || '')) ||
            event.faculty_name ||
            '';
        if (label && !facultyLabels.includes(label)) facultyLabels.push(label);
    }

    const facultyPart = facultyLabels.join(', ');

    // Одна конкретная группа — самое понятное имя при импорте.
    if (groups.length === 1) {
        return ['ПГГПУ', facultyPart, groups[0]].filter(Boolean).join(' ');
    }

    if (facultyPart) return `ПГГПУ ${facultyPart}`;

    return 'ПГГПУ Расписание';
}
