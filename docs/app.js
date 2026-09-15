'use strict';

// ==================== CONFIG ====================
const DATA_URL = 'data.json';
const HOUR_START = 8;
const HOUR_END = 22;
const HOUR_HEIGHT = 60;
const PAIR_MINUTES = 90;
const MAX_INLINE_EVENTS = 3;  // больше — группируем

const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAYS_FULL  = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// ==================== STATE ====================
// Хелперы для сериализации Set → массив → localStorage
function loadSetFromStorage(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set();
    }
}

function saveSetToStorage(key, set) {
    try {
        localStorage.setItem(key, JSON.stringify([...set]));
    } catch {
        // localStorage может быть недоступен (приватный режим, переполнение) — молча игнорируем
    }
}

const state = {
    allEvents: [],
    filteredEvents: [],
    groups: [],
    teachers: [],
    selectedGroups: loadSetFromStorage('schedule-selected-groups'),
    selectedTeachers: loadSetFromStorage('schedule-selected-teachers'),
    currentDate: new Date(),
    view: localStorage.getItem('schedule-view') || 'week',
    theme: localStorage.getItem('schedule-theme') || 'dark',
};

// ==================== UTILS ====================
const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const isToday = d => isSameDay(d, new Date());
const escapeHtml = s => {
    const div = document.createElement('div');
    div.textContent = String(s ?? '');
    return div.innerHTML;
};

function addMinutes(t, m) {
    const [h, mm] = t.split(':').map(Number);
    const total = h * 60 + mm + m;
    return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

function timeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

function startOfWeek(d) {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    const day = r.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    r.setDate(r.getDate() + diff);
    return r;
}

function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
}

function addMonths(d, n) {
    const r = new Date(d);
    r.setDate(1);
    r.setMonth(r.getMonth() + n);
    return r;
}

// ==================== DATA ====================
async function loadData() {
    // Читаем сохранённый "отпечаток" кэша. Если его нет — "0" (стабильный URL).
    const bust = localStorage.getItem('schedule-cache-bust') || '0';
    const resp = await fetch(`${DATA_URL}?v=${bust}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.events || [];
}

function expandEvents(rawEvents) {
    const out = [];
    for (const ev of rawEvents) {
        if (!ev.dates) continue;
        for (const ds of ev.dates) {
            const parts = ds.split('.').map(Number);
            if (parts.length !== 3) continue;
            const [d, m, y] = parts;
            out.push({
                ...ev,
                dateObj: new Date(y, m - 1, d),
                dateISO: `${y}-${pad(m)}-${pad(d)}`,
                endTime: addMinutes(ev.time, PAIR_MINUTES),
                uniqueId: `${ev.event_id}__${ds}`,
            });
        }
    }
    return out;
}

function groupByDate(events) {
    const m = new Map();
    for (const e of events) {
        if (!m.has(e.dateISO)) m.set(e.dateISO, []);
        m.get(e.dateISO).push(e);
    }
    for (const list of m.values()) list.sort((a, b) => a.time.localeCompare(b.time));
    return m;
}

// ==================== FILTERS ====================
function applyFilters() {
    const sg = state.selectedGroups;
    const st = state.selectedTeachers;
    state.filteredEvents = state.allEvents.filter(ev => {
        if (sg.size > 0 && !sg.has(ev.group)) return false;
        if (st.size > 0) {
            const teachers = ev.teachers || [];
            if (!teachers.some(t => st.has(t))) return false;
        }
        return true;
    });
}

// ==================== OVERLAP LAYOUT ====================

// ==================== OVERLAP LAYOUT ====================
// Разбиваем список событий дня на кластеры (транзитивно пересекающиеся),
// внутри кластера раскладываем по колонкам.
// Возвращаем массив элементов:
//   { type: 'single', ev, column, columnsCount }
//   { type: 'group',  events, startMin, endMin }  — если в кластере > MAX_INLINE_EVENTS
function layoutDayEvents(events) {
    if (events.length === 0) return [];

    // 1. Сортировка по началу, затем по концу
    const sorted = [...events].sort((a, b) => {
        const ta = timeToMinutes(a.time);
        const tb = timeToMinutes(b.time);
        if (ta !== tb) return ta - tb;
        return timeToMinutes(a.endTime) - timeToMinutes(b.endTime);
    });

    // 2. Кластеризация
    const clusters = [];
    let current = [];
    let currentEnd = -1;

    for (const ev of sorted) {
        const start = timeToMinutes(ev.time);
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

    // 3. Раскладка по колонкам внутри кластера
    const result = [];

    for (const cluster of clusters) {
        if (cluster.length > MAX_INLINE_EVENTS) {
            // Группируем
            const start = cluster.reduce((min, e) => Math.min(min, timeToMinutes(e.time)), Infinity);
            const end = cluster.reduce((max, e) => Math.max(max, timeToMinutes(e.endTime)), -Infinity);
            result.push({
                type: 'group',
                events: cluster,
                startMin: start,
                endMin: end,
            });
            continue;
        }

        // Раскладываем по колонкам
        const columns = [];   // каждая колонка — массив событий в ней
        const placement = []; // {ev, column}

        for (const ev of cluster) {
            const start = timeToMinutes(ev.time);
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

// ==================== RENDER DISPATCH ====================
function render(animation = null) {
    const cal = document.getElementById('calendar');
    cal.innerHTML = '';
    cal.className = 'calendar view-' + state.view;

    if (state.view === 'month') renderMonth(cal);
    else if (state.view === 'week') renderWeek(cal);
    else renderDay(cal);

    updateDateLabel();

    if (animation) {
        void cal.offsetWidth;
        cal.classList.add('anim-' + animation);
        cal.addEventListener('animationend', () => {
            cal.classList.remove('anim-' + animation);
        }, { once: true });
    }
}

function updateDateLabel() {
    const d = state.currentDate;
    const isNarrow = window.innerWidth <= 900;
    document.getElementById('dateLabel').textContent = isNarrow
        ? `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`
        : `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
}

// ==================== WEEK VIEW ====================
function renderWeek(root) {
    const start = startOfWeek(state.currentDate);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

    const header = document.createElement('div');
    header.className = 'cal-header week';
    header.appendChild(document.createElement('div'));
    for (const d of days) {
        const cell = document.createElement('div');
        cell.className = 'day-header';
        if (isToday(d)) cell.classList.add('today');
        cell.innerHTML = `<div class="day-name">${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]}</div>
                          <div class="day-num">${d.getDate()}</div>`;
        header.appendChild(cell);
    }
    root.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cal-body week';
    root.appendChild(body);

    const timeCol = document.createElement('div');
    timeCol.className = 'time-col';
    for (let h = HOUR_START; h <= HOUR_END; h++) {
        const lbl = document.createElement('div');
        lbl.className = 'time-label';
        lbl.textContent = `${pad(h)}:00`;
        timeCol.appendChild(lbl);
    }
    body.appendChild(timeCol);

    const grid = document.createElement('div');
    grid.className = 'day-grid';
    grid.style.gridTemplateColumns = 'repeat(7, 1fr)';
    body.appendChild(grid);

    const byDate = groupByDate(state.filteredEvents);

    for (const d of days) {
        const col = document.createElement('div');
        col.className = 'day-col';
        if (isToday(d)) col.classList.add('today');
        col.style.height = ((HOUR_END - HOUR_START + 1) * HOUR_HEIGHT) + 'px';

        addHourLines(col);
        addCurrentTimeLine(col, d);

        const dayEvents = byDate.get(toISO(d)) || [];
        renderDayColumn(col, dayEvents);

        grid.appendChild(col);
    }
}

// ==================== DAY VIEW ====================
function renderDay(root) {
    const d = state.currentDate;

    const header = document.createElement('div');
    header.className = 'cal-header day';
    header.appendChild(document.createElement('div'));
    const cell = document.createElement('div');
    cell.className = 'day-header';
    if (isToday(d)) cell.classList.add('today');
    cell.innerHTML = `
        <div class="day-name">${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]}</div>
        <div class="day-num">${d.getDate()}</div>
    `;
    header.appendChild(cell);
    root.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cal-body day';
    root.appendChild(body);

    const timeCol = document.createElement('div');
    timeCol.className = 'time-col';
    for (let h = HOUR_START; h <= HOUR_END; h++) {
        const lbl = document.createElement('div');
        lbl.className = 'time-label';
        lbl.textContent = `${pad(h)}:00`;
        timeCol.appendChild(lbl);
    }
    body.appendChild(timeCol);

    const grid = document.createElement('div');
    grid.className = 'day-grid';
    grid.style.gridTemplateColumns = '1fr';
    body.appendChild(grid);

    const col = document.createElement('div');
    col.className = 'day-col';
    if (isToday(d)) col.classList.add('today');
    col.style.height = ((HOUR_END - HOUR_START + 1) * HOUR_HEIGHT) + 'px';

    addHourLines(col);
    addCurrentTimeLine(col, d);

    const byDate = groupByDate(state.filteredEvents);
    renderDayColumn(col, byDate.get(toISO(d)) || []);

    grid.appendChild(col);
}

// ==================== RENDER EVENTS IN A DAY COLUMN ====================
function renderDayColumn(col, dayEvents) {
    const items = layoutDayEvents(dayEvents);
    for (const item of items) {
        if (item.type === 'single') {
            col.appendChild(makeEventBlock(item.ev, item.column, item.columnsCount));
        } else {
            col.appendChild(makeGroupBlock(item));
        }
    }
}

// ==================== HELPERS ====================
function addHourLines(col) {
    for (let h = HOUR_START; h <= HOUR_END; h++) {
        const line = document.createElement('div');
        line.className = 'hour-line';
        line.style.top = ((h - HOUR_START) * HOUR_HEIGHT) + 'px';
        col.appendChild(line);
    }
}

function addCurrentTimeLine(col, day) {
    if (!isToday(day)) return;
    const now = new Date();
    const top = (now.getHours() + now.getMinutes() / 60 - HOUR_START) * HOUR_HEIGHT;
    const maxTop = (HOUR_END - HOUR_START + 1) * HOUR_HEIGHT;
    if (top < 0 || top > maxTop) return;
    const line = document.createElement('div');
    line.className = 'current-time-line';
    line.style.top = top + 'px';
    col.appendChild(line);
}

function makeEventBlock(ev, column = 0, columnsCount = 1) {
    const [h, m] = ev.time.split(':').map(Number);
    const top = (h + m / 60 - HOUR_START) * HOUR_HEIGHT;
    const height = (PAIR_MINUTES / 60) * HOUR_HEIGHT - 2;

    const el = document.createElement('div');
    el.className = 'event-block';
    el.style.top = top + 'px';
    el.style.height = height + 'px';

    if (columnsCount > 1) {
        const pct = 100 / columnsCount;
        el.style.left = `calc(${column * pct}% + 2px)`;
        el.style.right = `calc(${(columnsCount - column - 1) * pct}% + 2px)`;
        el.classList.add('event-block--narrow');
    }

    const titleText = ev.discipline + (ev.type ? ` (${ev.type})` : '');
    el.innerHTML = `
        <div class="event-title">${escapeHtml(titleText)}</div>
        <div class="event-room">${escapeHtml(ev.rooms || '')}</div>
        <div class="event-time">${ev.time}–${ev.endTime}</div>
    `;

    el.addEventListener('click', e => {
        e.stopPropagation();
        showEventDetails(ev, el);
    });

    return el;
}

function makeGroupBlock(item) {
    const { events, startMin, endMin } = item;
    const top = (startMin / 60 - HOUR_START) * HOUR_HEIGHT;
    const height = ((endMin - startMin) / 60) * HOUR_HEIGHT - 2;

    const startH = String(Math.floor(startMin / 60)).padStart(2, '0');
    const startM = String(startMin % 60).padStart(2, '0');
    const endH = String(Math.floor(endMin / 60)).padStart(2, '0');
    const endM = String(endMin % 60).padStart(2, '0');

    const el = document.createElement('div');
    el.className = 'event-block event-block--group';
    el.style.top = top + 'px';
    el.style.height = height + 'px';
    el.style.left = '3px';
    el.style.right = '3px';

    el.innerHTML = `
        <div class="event-group-count">${events.length} мероприятий</div>
        <div class="event-group-time">${startH}:${startM}–${endH}:${endM}</div>
        <div class="event-group-hint">Нажмите, чтобы увидеть</div>
    `;

    el.addEventListener('click', e => {
        e.stopPropagation();
        showGroupDetails(events, el);
    });

    return el;
}

// ==================== MONTH VIEW ====================
function renderMonth(root) {
    const d = state.currentDate;
    const year = d.getFullYear();
    const month = d.getMonth();

    const grid = document.createElement('div');
    grid.className = 'month-grid';

    for (const name of WEEKDAYS_SHORT) {
        const cell = document.createElement('div');
        cell.className = 'month-weekday';
        cell.textContent = name;
        grid.appendChild(cell);
    }

    const firstOfMonth = new Date(year, month, 1);
    const start = startOfWeek(firstOfMonth);
    const byDate = groupByDate(state.filteredEvents);
    const MAX_SHOW = 3;

    for (let w = 0; w < 6; w++) {
        for (let dIdx = 0; dIdx < 7; dIdx++) {
            const day = addDays(start, w * 7 + dIdx);
            const cell = document.createElement('div');
            cell.className = 'month-cell';
            if (day.getMonth() !== month) cell.classList.add('other-month');
            if (isToday(day)) cell.classList.add('today');

            const num = document.createElement('div');
            num.className = 'month-day-num';
            num.textContent = day.getDate();
            cell.appendChild(num);

            const dayEvents = byDate.get(toISO(day)) || [];
            dayEvents.slice(0, MAX_SHOW).forEach(ev => {
                const chip = document.createElement('div');
                chip.className = 'month-event';
                chip.textContent = `${ev.time} ${ev.discipline}${ev.type ? ` (${ev.type})` : ''}`;
                chip.title = chip.textContent;
                chip.addEventListener('click', e => {
                    e.stopPropagation();
                    showEventDetails(ev, chip);
                });
                cell.appendChild(chip);
            });
            if (dayEvents.length > MAX_SHOW) {
                const more = document.createElement('div');
                more.className = 'month-more';
                more.textContent = `+${dayEvents.length - MAX_SHOW} ещё`;
                cell.appendChild(more);
            }

            grid.appendChild(cell);
        }
    }

    root.appendChild(grid);
}

// ==================== NAVIGATION ====================
function navigate(delta) {
    if (state.view === 'month') {
        state.currentDate = addMonths(state.currentDate, delta);
    } else if (state.view === 'week') {
        state.currentDate = addDays(state.currentDate, delta * 7);
    } else {
        state.currentDate = addDays(state.currentDate, delta);
    }
    render(delta > 0 ? 'next' : 'prev');
}

function goToToday() {
    state.currentDate = new Date();
    render('fade');
}

function viewLabel(v) {
    return { month: 'Месяц', week: 'Неделя', day: 'День' }[v];
}

function cycleView() {
    const order = ['month', 'week', 'day'];
    const idx = order.indexOf(state.view);
    state.view = order[(idx + 1) % order.length];
    localStorage.setItem('schedule-view', state.view);
    document.getElementById('viewBtn').textContent = viewLabel(state.view);
    render('fade');
}

function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('schedule-theme', state.theme);
    document.documentElement.setAttribute('data-theme', state.theme);
    document.getElementById('themeBtn').textContent =
        state.theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
}

// ==================== POPOVER POSITIONING ====================
function positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = rect.right + 8;
    let top = rect.top;
    if (left + popRect.width > window.innerWidth - 8) left = rect.left - popRect.width - 8;
    if (left < 8) left = 8;
    if (top + popRect.height > window.innerHeight - 8) top = window.innerHeight - popRect.height - 8;
    if (top < 8) top = 8;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
}

// ==================== EVENT POPOVER ====================
function showEventDetails(ev, anchor) {
    const pop = document.getElementById('eventPopover');
    pop.classList.remove('popover--group');
    pop.innerHTML = eventDetailsHtml(ev);
    pop.classList.add('open');
    positionPopover(pop, anchor);
}

function eventDetailsHtml(ev) {
    const titleText = ev.discipline + (ev.type ? ` (${ev.type})` : '');
    return `
        <h3>${escapeHtml(titleText)}</h3>
        <div class="popover-row"><span class="label">Время</span><span>${ev.time} – ${ev.endTime}</span></div>
        <div class="popover-row"><span class="label">Дата</span><span>${ev.dateObj.getDate()} ${MONTHS_GEN[ev.dateObj.getMonth()]} ${ev.dateObj.getFullYear()}</span></div>
        ${ev.rooms ? `<div class="popover-row"><span class="label">Место</span><span>${escapeHtml(ev.rooms)}</span></div>` : ''}
        ${ev.teachers && ev.teachers.length ? `<div class="popover-row"><span class="label">Преподаватель</span><span>${escapeHtml(ev.teachers.join(', '))}</span></div>` : ''}
        <div class="popover-row"><span class="label">Группа</span><span>${escapeHtml(ev.group)}</span></div>
        ${ev.subgroup ? `<div class="popover-row"><span class="label">Подгруппа</span><span>${escapeHtml(ev.subgroup)}</span></div>` : ''}
    `;
}

function hideEventDetails() {
    const pop = document.getElementById('eventPopover');
    pop.classList.remove('open', 'popover--group');
}

// ==================== GROUP POPOVER ====================
function showGroupDetails(events, anchor) {
    const pop = document.getElementById('eventPopover');
    pop.classList.add('open', 'popover--group');
    renderGroupList(events, anchor, pop);
    positionPopover(pop, anchor);
}

function renderGroupList(events, anchor, pop) {
    pop.classList.add('popover--group');
    pop.innerHTML = `
        <div class="popover-header">
            <h3>${events.length} мероприятий</h3>
        </div>
        <div class="group-list">
            ${events.map((ev, i) => {
                const titleText = ev.discipline + (ev.type ? ` (${ev.type})` : '');
                return `
                    <div class="group-item" data-idx="${i}">
                        <div class="group-item-time">${ev.time}–${ev.endTime}</div>
                        <div class="group-item-title">${escapeHtml(titleText)}</div>
                        ${ev.rooms ? `<div class="group-item-room">${escapeHtml(ev.rooms)}</div>` : ''}
                    </div>
                `;
            }).join('')}
        </div>
    `;

    pop.querySelectorAll('.group-item').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const idx = parseInt(el.dataset.idx, 10);
            renderGroupDetailItem(events[idx], events, anchor, pop);
        });
    });
}

function renderGroupDetailItem(ev, events, anchor, pop) {
    pop.classList.remove('popover--group');
    pop.innerHTML = `
        <button class="popover-back" type="button">← К списку</button>
        ${eventDetailsHtml(ev)}
    `;
    pop.querySelector('.popover-back').addEventListener('click', e => {
        e.stopPropagation();
        renderGroupList(events, anchor, pop);
    });
}

// ==================== DATE PICKER ====================
const pickerState = { year: 0, month: 0 };

function openDatePicker() {
    pickerState.year = state.currentDate.getFullYear();
    pickerState.month = state.currentDate.getMonth();
    renderPicker();
    document.getElementById('dateModal').classList.add('open');
}

function closeDatePicker() {
    document.getElementById('dateModal').classList.remove('open');
}

function renderPicker() {
    const { year, month } = pickerState;
    document.getElementById('pickerTitle').textContent = `${MONTHS_NOM[month]} ${year}`;

    const grid = document.getElementById('pickerGrid');
    grid.innerHTML = '';

    const firstOfMonth = new Date(year, month, 1);
    const start = startOfWeek(firstOfMonth);
    const selISO = toISO(state.currentDate);

    for (let w = 0; w < 6; w++) {
        for (let dIdx = 0; dIdx < 7; dIdx++) {
            const day = addDays(start, w * 7 + dIdx);
            const cell = document.createElement('div');
            cell.className = 'picker-day';
            if (day.getMonth() !== month) cell.classList.add('other');
            if (isToday(day)) cell.classList.add('today');
            if (toISO(day) === selISO) cell.classList.add('selected');
            cell.textContent = day.getDate();
            cell.addEventListener('click', () => {
                state.currentDate = new Date(day);
                closeDatePicker();
                render('fade');
            });
            grid.appendChild(cell);
        }
    }
}

// ==================== UNIFIED FILTER (two columns) ====================
function setupUnifiedFilter() {
    const root = document.getElementById('filterRoot');
    const trigger = root.querySelector('.filter-trigger');
    const dropdown = root.querySelector('.filter-dropdown');
    const search = root.querySelector('.filter-search');
    const clearBtn = root.querySelector('.filter-clear');
    const groupsListEl = document.getElementById('filterGroupsList');
    const teachersListEl = document.getElementById('filterTeachersList');
    const counterEl = document.getElementById('filterCounter');

    function updateTriggerLabel() {
        const total = state.selectedGroups.size + state.selectedTeachers.size;
        trigger.querySelector('.filter-label').textContent =
            total === 0 ? 'Фильтр' : `Фильтр · ${total}`;
    }

    function updateCounter() {
        const g = state.selectedGroups.size;
        const t = state.selectedTeachers.size;
        const parts = [];
        if (g > 0) parts.push(`групп: ${g}`);
        if (t > 0) parts.push(`преподавателей: ${t}`);
        counterEl.textContent = parts.length ? `Выбрано — ${parts.join(', ')}` : 'Ничего не выбрано';
    }

    function buildOption(value, type) {
        const row = document.createElement('label');
        row.className = 'filter-option';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = type === 'group'
            ? state.selectedGroups.has(value)
            : state.selectedTeachers.has(value);

        cb.addEventListener('change', () => {
            const set = type === 'group' ? state.selectedGroups : state.selectedTeachers;
            if (cb.checked) set.add(value);
            else set.delete(value);

            saveSetToStorage(
                type === 'group' ? 'schedule-selected-groups' : 'schedule-selected-teachers',
                set,
            );

            updateTriggerLabel();
            updateCounter();
            applyFilters();
            render();
        });

        const text = document.createElement('span');
        text.className = 'filter-option-value';
        text.textContent = value;

        row.appendChild(cb);
        row.appendChild(text);
        return row;
    }

    function renderLists(query = '') {
        const q = query.trim().toLowerCase();

        groupsListEl.innerHTML = '';
        const matchedGroups = state.groups.filter(g => !q || g.toLowerCase().includes(q));
        if (matchedGroups.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'filter-option-empty';
            empty.textContent = 'Не найдено';
            groupsListEl.appendChild(empty);
        } else {
            for (const g of matchedGroups) groupsListEl.appendChild(buildOption(g, 'group'));
        }

        teachersListEl.innerHTML = '';
        const matchedTeachers = state.teachers.filter(t => !q || t.toLowerCase().includes(q));
        if (matchedTeachers.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'filter-option-empty';
            empty.textContent = 'Не найдено';
            teachersListEl.appendChild(empty);
        } else {
            for (const t of matchedTeachers) teachersListEl.appendChild(buildOption(t, 'teacher'));
        }
    }

    function openFilter() {
        document.querySelectorAll('.filter.open').forEach(el => el.classList.remove('open'));
        root.classList.add('open');
        search.value = '';
        renderLists('');
        updateCounter();
        // История — чтобы кнопка "Назад" на телефоне закрывала модалку
        history.pushState({ filterOpen: true }, '');
        setTimeout(() => search.focus(), 50);
    }

    function closeFilter() {
        if (!root.classList.contains('open')) return;
        if (history.state && history.state.filterOpen) {
            history.back();  // popstate закроет модалку
        } else {
            root.classList.remove('open');
        }
    }

    trigger.addEventListener('click', e => {
        e.stopPropagation();
        if (root.classList.contains('open')) closeFilter();
        else openFilter();
    });

    const closeBtn = dropdown.querySelector('.filter-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            closeFilter();
        });
    }

    window.addEventListener('popstate', () => {
        if (root.classList.contains('open')) {
            root.classList.remove('open');
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && root.classList.contains('open')) {
            closeFilter();
        }
    });

    search.addEventListener('input', () => renderLists(search.value));

    clearBtn.addEventListener('click', e => {
        e.stopPropagation();
        state.selectedGroups.clear();
        state.selectedTeachers.clear();
        saveSetToStorage('schedule-selected-groups', state.selectedGroups);
        saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);
        updateTriggerLabel();
        updateCounter();
        applyFilters();
        render();
        renderLists(search.value);
    });

    dropdown.addEventListener('click', e => e.stopPropagation());

    updateTriggerLabel();
    updateCounter();

    // Реагируем на изменение ширины окна (поворот экрана, resize)
    window.addEventListener('resize', updateDateLabel);
}

// ==================== PULL TO REFRESH ====================
function setupPullToRefresh() {
    // Только на устройствах с тач-интерфейсом
    if (!('ontouchstart' in window)) return;

    const THRESHOLD = 70;   // сколько пикселей протянуть, чтобы сработало
    const MAX_PULL = 100;   // максимум, насколько выедет индикатор

    const calendar = document.getElementById('calendar');

    const indicator = document.createElement('div');
    indicator.className = 'ptr-indicator';
    indicator.innerHTML = '<div class="ptr-spinner"></div>';
    document.body.appendChild(indicator);

    let startY = 0;
    let currentPull = 0;
    let isPulling = false;

    let startY = 0;
    let currentPull = 0;
    let isPulling = false;

    calendar.addEventListener('touchstart', e => {
        if (calendar.scrollTop > 0) return;
        if (indicator.classList.contains('ptr-loading')) return;
        startY = e.touches[0].clientY;
        isPulling = true;
        currentPull = 0;
    }, { passive: false });

    calendar.addEventListener('touchmove', e => {
        if (!isPulling) return;

        const dy = e.touches[0].clientY - startY;

        // Если палец пошёл вверх — сбрасываем индикатор, отдаём жест скроллу
        if (dy <= 0) {
            currentPull = 0;
            indicator.style.transform = 'translate(-50%, -70px)';
            indicator.classList.remove('ptr-ready');
            return;
        }

        // Если контейнер уже отскроллен — не перехватываем жест
        if (calendar.scrollTop > 0) {
            isPulling = false;
            currentPull = 0;
            indicator.style.transform = 'translate(-50%, -70px)';
            indicator.classList.remove('ptr-ready');
            return;
        }

        // Забираем жест себе — блокируем нативный скролл и rubber-band
        if (e.cancelable) e.preventDefault();

        // Демпфирование: чем дальше тянем, тем медленнее растёт
        currentPull = Math.min(MAX_PULL, dy * 0.5);

        // Индикатор выезжает из-за верха
        indicator.style.transform = `translate(-50%, ${-70 + currentPull}px)`;
        indicator.classList.toggle('ptr-ready', currentPull >= THRESHOLD);
    }, { passive: false });

    const endPull = () => {
        if (!isPulling) return;
        isPulling = false;

        if (currentPull >= THRESHOLD) {
            indicator.classList.add('ptr-loading');
            indicator.classList.remove('ptr-ready');
            indicator.style.transform = `translate(-50%, ${-70 + THRESHOLD}px)`;
            // Обновляем "отпечаток" кэша — следующая загрузка пойдёт в обход кэша
            localStorage.setItem('schedule-cache-bust', Date.now().toString());
            // Небольшая задержка, чтобы пользователь увидел спиннер
            setTimeout(() => location.reload(), 250);
        } else {
            indicator.classList.remove('ptr-ready');
            indicator.style.transform = 'translate(-50%, -70px)';
        }
        currentPull = 0;
    };

    calendar.addEventListener('touchend', endPull);
    calendar.addEventListener('touchcancel', endPull);
}

// ==================== INIT ====================
async function init() {
    document.documentElement.setAttribute('data-theme', state.theme);
    document.getElementById('themeBtn').textContent =
        state.theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    document.getElementById('viewBtn').textContent = viewLabel(state.view);

    let raw;
    try {
        raw = await loadData();
    } catch (e) {
        document.getElementById('calendar').innerHTML =
            `<div class="empty-state">Не удалось загрузить расписание: ${escapeHtml(e.message)}</div>`;
        return;
    }

    state.allEvents = expandEvents(raw);

    const groups = new Set();
    const teachers = new Set();
    for (const ev of state.allEvents) {
        if (ev.group) groups.add(ev.group);
        (ev.teachers || []).forEach(t => teachers.add(t));
    }
    state.groups = [...groups].sort();
    state.teachers = [...teachers].sort();

    // Убираем из сохранённых фильтров то, чего больше нет в данных
    for (const g of [...state.selectedGroups]) {
        if (!state.groups.includes(g)) state.selectedGroups.delete(g);
    }
    for (const t of [...state.selectedTeachers]) {
        if (!state.teachers.includes(t)) state.selectedTeachers.delete(t);
    }
    saveSetToStorage('schedule-selected-groups', state.selectedGroups);
    saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);

    applyFilters();
    setupUnifiedFilter();

    document.getElementById('prevBtn').addEventListener('click', () => navigate(-1));
    document.getElementById('nextBtn').addEventListener('click', () => navigate(1));
    document.getElementById('todayBtn').addEventListener('click', goToToday);
    document.getElementById('viewBtn').addEventListener('click', cycleView);
    document.getElementById('themeBtn').addEventListener('click', toggleTheme);
    document.getElementById('dateLabel').addEventListener('click', openDatePicker);

    document.getElementById('pickerPrev').addEventListener('click', () => {
        pickerState.month--;
        if (pickerState.month < 0) { pickerState.month = 11; pickerState.year--; }
        renderPicker();
    });
    document.getElementById('pickerNext').addEventListener('click', () => {
        pickerState.month++;
        if (pickerState.month > 11) { pickerState.month = 0; pickerState.year++; }
        renderPicker();
    });
    document.getElementById('dateModal').addEventListener('click', e => {
        if (e.target.id === 'dateModal') closeDatePicker();
    });

    document.getElementById('eventPopover').addEventListener('click', e => e.stopPropagation());

    document.addEventListener('click', (e) => {
        hideEventDetails();
        // На десктопе закрываем фильтр при клике вне его
        if (window.innerWidth > 900) {
            const filterRoot = document.getElementById('filterRoot');
            if (filterRoot && filterRoot.classList.contains('open') && !filterRoot.contains(e.target)) {
                filterRoot.classList.remove('open');
                if (history.state && history.state.filterOpen) history.back();
            }
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            hideEventDetails();
            closeDatePicker();
            // Escape для фильтра обрабатывается внутри setupUnifiedFilter
        }
    });

    setupPullToRefresh();
    render();
}

document.addEventListener('DOMContentLoaded', init);