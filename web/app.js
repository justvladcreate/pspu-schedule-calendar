'use strict';

// ==================== CONFIG ====================
const DATA_URL = 'data.json';
const HOUR_START = 8;
const HOUR_END = 22;
const HOUR_HEIGHT = 60;
const PAIR_MINUTES = 90;
const MAX_INLINE_EVENTS = 3;

const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAYS_FULL  = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// ==================== STATE ====================
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
    } catch {}
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
    viewingOld: false,
    currentData: null,
    displayedIso: null,
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
async function loadData(url = 'data.json') {
    const bust = localStorage.getItem('schedule-cache-bust') || '0';
    const resp = await fetch(`${url}?v=${bust}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
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

    // Ничего не выбрано — не показываем ни одного события
    if (sg.size === 0 && st.size === 0) {
        state.filteredEvents = [];
        return;
    }

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
function layoutDayEvents(events) {
    if (events.length === 0) return [];

    const sorted = [...events].sort((a, b) => {
        const ta = timeToMinutes(a.time);
        const tb = timeToMinutes(b.time);
        if (ta !== tb) return ta - tb;
        return timeToMinutes(a.endTime) - timeToMinutes(b.endTime);
    });

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

    const result = [];

    for (const cluster of clusters) {
        if (cluster.length > MAX_INLINE_EVENTS) {
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

        const columns = [];
        const placement = [];

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

// ==================== EMPTY STATE ====================
function hasActiveFilters() {
    return state.selectedGroups.size > 0 || state.selectedTeachers.size > 0;
}

function openFilterDropdown() {
    const trigger = document.querySelector('.filter-trigger');
    if (trigger) trigger.click();
}

function makeEmptyState() {
    const el = document.createElement('div');
    el.className = 'empty-state';

    if (state.allEvents.length === 0) {
        el.textContent = 'Мероприятий нет';
    } else if (!hasActiveFilters()) {
        el.innerHTML = `
            <button class="empty-state-btn" type="button">
                <svg class="icon" viewBox="0 0 24 24" width="16" height="16"
                     fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
                <span>Выберите фильтр</span>
            </button>
        `;
        el.querySelector('.empty-state-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openFilterDropdown();
        });
    } else {
        el.textContent = 'Нет мероприятий по выбранным фильтрам';
    }
    return el;
}

function shouldShowEmptyState() {
    return state.filteredEvents.length === 0;
}

// ==================== RENDER DISPATCH ====================
function render(animation = null) {
    const cal = document.getElementById('calendar');
    cal.innerHTML = '';
    cal.className = 'calendar view-' + state.view;

    if (shouldShowEmptyState()) {
        cal.appendChild(makeEmptyState());
    } else if (state.view === 'month') {
        renderMonth(cal);
    } else if (state.view === 'week') {
        renderWeek(cal);
    } else {
        renderDay(cal);
    }

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

            if (dayEvents.length > MAX_SHOW) {
                const group = document.createElement('div');
                group.className = 'month-event month-event--group';
                group.textContent = `${dayEvents.length} мероприятий`;
                group.title = `${dayEvents.length} мероприятий — нажмите, чтобы увидеть`;
                group.addEventListener('click', e => {
                    e.stopPropagation();
                    showGroupDetails(dayEvents, group);
                });
                cell.appendChild(group);
            } else {
                dayEvents.forEach(ev => {
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

function updateViewButton() {
    const btn = document.getElementById('viewBtn');
    btn.dataset.view = state.view;
    btn.setAttribute('aria-label', `Вид: ${viewLabel(state.view)}`);
}

function updateThemeButton() {
    const btn = document.getElementById('themeBtn');
    btn.dataset.themeCurrent = state.theme;
    btn.setAttribute(
        'aria-label',
        state.theme === 'dark'
            ? 'Переключить на светлую тему'
            : 'Переключить на тёмную тему'
    );
}

// ==================== VERSION (Обновлено / прошлая версия) ====================
function updateUpdatedLabel(iso) {
    const el = document.getElementById('updatedTime');
    const btn = document.getElementById('updatedBtn');
    if (!iso) {
        el.textContent = '—';
        btn.setAttribute('aria-label', 'Обновлено: неизвестно');
        return;
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        el.textContent = '—';
        return;
    }
    const relative = formatRelativeTime(d);
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const full = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;

    el.textContent = relative;
    btn.setAttribute('aria-label', `Обновлено: ${full}. Нажмите, чтобы переключить версию`);
}

function formatRelativeTime(dateObj) {
    const diffMs = Date.now() - dateObj.getTime();
    if (diffMs < 0) return 'только что';

    const sec   = Math.floor(diffMs / 1000);
    const min   = Math.floor(sec / 60);
    const hour  = Math.floor(min / 60);
    const day   = Math.floor(hour / 24);
    const month = Math.floor(day / 30);

    if (min < 1)     return 'только что';
    if (min < 60)    return `${min} ${pluralRu(min, 'минуту', 'минуты', 'минут')} назад`;
    if (hour < 24)   return `${hour} ${pluralRu(hour, 'час', 'часа', 'часов')} назад`;
    if (day < 30)    return `${day} ${pluralRu(day, 'день', 'дня', 'дней')} назад`;
    if (month < 12)  return `${month} ${pluralRu(month, 'месяц', 'месяца', 'месяцев')} назад`;
    return 'больше года назад';
}

function pluralRu(n, one, few, many) {
    const mod10  = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

let toastTimer = null;

function showToast(message, duration = 2200) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('toast--visible');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.classList.remove('toast--visible');
        toastTimer = null;
    }, duration);
}

function updateVersionUi() {
    const wrap = document.getElementById('updatedWrap');
    const sub  = document.getElementById('updatedSub');
    if (state.viewingOld) {
        wrap.classList.add('is-old');
        sub.hidden = false;
    } else {
        wrap.classList.remove('is-old');
        sub.hidden = true;
    }
}

function applyData(data) {
    state.allEvents = expandEvents(data.events || []);
    state.displayedIso = data.generated_at || null;
    updateUpdatedLabel(state.displayedIso);
    updateVersionUi();

    const groups = new Set();
    const teachers = new Set();
    for (const ev of state.allEvents) {
        if (ev.group) groups.add(ev.group);
        (ev.teachers || []).forEach(t => teachers.add(t));
    }
    state.groups   = [...groups].sort();
    state.teachers = [...teachers].sort();

    // Пользовательский выбор не должен сбрасываться при переключении между
    // текущей и старой версией. Устаревшие записи (которых больше нет в
    // данных) убираются только при загрузке страницы — в init().

    saveSetToStorage('schedule-selected-groups',   state.selectedGroups);
    saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);

    applyFilters();
    updateTriggerLabel();
    updateCounter();
    render('fade');
}

function setupVersionToggle() {
    const btn = document.getElementById('updatedBtn');
    btn.addEventListener('click', async () => {
        if (state.viewingOld) {
            state.viewingOld = false;
            applyData(state.currentData);
            showToast('Вы просматриваете текущую версию');
            return;
        }
        try {
            const oldData = await loadData('old_data.json');
            state.viewingOld = true;
            applyData(oldData);
            showToast('Вы просматриваете старую версию');
        } catch (e) {
            console.warn('Прошлая версия недоступна:', e);
            showToast('Старая версия недоступна');
            btn.disabled = true;
            btn.setAttribute('title', 'Прошлая версия пока недоступна');
        }
    });
}

// ==================== README MODAL ====================
function setupReadmeModal() {
    const banner = document.getElementById('warningBanner');
    const modal  = document.getElementById('readmeModal');
    const body   = document.getElementById('readmeBody');
    const close  = modal.querySelector('.readme-close');
    let loaded = false;

    async function open() {
        modal.classList.add('open');
        if (loaded) return;
        body.innerHTML = '<div class="readme-loading">Загрузка…</div>';
        try {
            const resp = await fetch('readme.md?v=' + Date.now());
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const text = await resp.text();
            body.innerHTML = renderMarkdown(text);
            loaded = true;
        } catch (e) {
            body.innerHTML =
                `<p style="color:var(--danger-text)">Не удалось загрузить текст: ${escapeHtml(e.message)}</p>`;
        }
    }
    function hide() { modal.classList.remove('open'); }

    banner.addEventListener('click', open);
    close.addEventListener('click', hide);
    modal.addEventListener('click', e => { if (e.target === modal) hide(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.classList.contains('open')) hide();
    });
}

// ==================== MARKDOWN (минимальный) ====================
function renderMarkdown(src) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const inline = s => {
        s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
        s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">');
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener">$1</a>');
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        return s;
    };

    const lines = esc(src).split('\n');
    const out = [];
    let para = [], listType = null, inCode = false, codeBuf = [];

    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
    const flushPara = () => { if (para.length) { out.push('<p>' + para.join(' ') + '</p>'); para = []; } };

    for (const line of lines) {
        if (line.startsWith('```')) {
            if (inCode) { out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>'); codeBuf = []; inCode = false; }
            else { flushPara(); closeList(); inCode = true; }
            continue;
        }
        if (inCode) { codeBuf.push(line); continue; }

        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) { flushPara(); closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

        if (line.trim() === '') { flushPara(); closeList(); continue; }

        const ul = line.match(/^[-*+]\s+(.*)$/);
        if (ul) { flushPara(); if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push('<li>' + inline(ul[1]) + '</li>'); continue; }

        const ol = line.match(/^\d+\.\s+(.*)$/);
        if (ol) { flushPara(); if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push('<li>' + inline(ol[1]) + '</li>'); continue; }

        const bq = line.match(/^>\s?(.*)$/);
        if (bq) { flushPara(); closeList(); out.push('<blockquote>' + inline(bq[1]) + '</blockquote>'); continue; }

        if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushPara(); closeList(); out.push('<hr>'); continue; }

        para.push(inline(line));
    }
    if (inCode) out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>');
    flushPara(); closeList();
    return out.join('\n');
}

function cycleView() {
    const order = ['month', 'week', 'day'];
    const idx = order.indexOf(state.view);
    state.view = order[(idx + 1) % order.length];
    localStorage.setItem('schedule-view', state.view);
    updateViewButton();
    render('fade');
}

function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('schedule-theme', state.theme);
    document.documentElement.setAttribute('data-theme', state.theme);
    updateThemeButton();
}

// ==================== CALENDAR GESTURES (wheel / swipe / pinch) ====================
function setupCalendarGestures() {
    const calendar = document.getElementById('calendar');

    ['gesturestart', 'gesturechange', 'gestureend'].forEach(name => {
        calendar.addEventListener(name, e => e.preventDefault(), { passive: false });
    });

    let wheelLocked = false;
    calendar.addEventListener('wheel', e => {
        if (state.view !== 'month') return;
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        if (Math.abs(e.deltaY) < 4) return;

        e.preventDefault();
        if (wheelLocked) return;
        wheelLocked = true;
        navigate(e.deltaY > 0 ? 1 : -1);
        setTimeout(() => { wheelLocked = false; }, 250);
    }, { passive: false });

    // ---- Ctrl/Cmd + wheel: зум колонок недели ----
    const TIME_COL      = 56;
    const DEFAULT_COL   = 110;
    const MIN_COL       = () => Math.max(30, (window.innerWidth - TIME_COL) / 7);
    const MAX_COL       = DEFAULT_COL;

    const getColWidth = () => {
        const v = getComputedStyle(document.documentElement)
            .getPropertyValue('--m-day-col');
        return parseFloat(v) || DEFAULT_COL;
    };
    const setColWidth = px => {
        document.documentElement.style.setProperty('--m-day-col', px + 'px');
    };
    const dist = (t1, t2) =>
        Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

    calendar.addEventListener('wheel', e => {
        if (state.view !== 'week') return;
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const step = e.deltaY > 0 ? -8 : 8;
        const cur  = getColWidth();
        const next = Math.max(MIN_COL(), Math.min(MAX_COL, cur + step));
        setColWidth(next);
    }, { passive: false });

    // ---------- PINCH (week only) ----------
    let pinchStartDist = 0;
    let pinchStartCol  = 0;

    // ---------- SWIPE ----------
    const SWIPE_THRESHOLD = 60;
    let startX = 0, startY = 0, tracking = false;

    calendar.addEventListener('touchstart', e => {
        if (e.touches.length >= 2) {
            tracking = false;
            if (state.view === 'week') {
                pinchStartDist = dist(e.touches[0], e.touches[1]);
                pinchStartCol  = getColWidth();
            }
            return;
        }
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, { passive: true });

    calendar.addEventListener('touchmove', e => {
        if (e.touches.length === 2 && e.cancelable) {
            e.preventDefault();
        }

        if (e.touches.length !== 2 || !pinchStartDist) return;
        if (state.view !== 'week') return;

        const scale = dist(e.touches[0], e.touches[1]) / pinchStartDist;
        const next  = pinchStartCol * scale;
        setColWidth(Math.max(MIN_COL(), Math.min(MAX_COL, next)));
    }, { passive: false });

    calendar.addEventListener('touchend', e => {
        if (e.touches.length < 2) pinchStartDist = 0;

        if (!tracking) return;
        tracking = false;

        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;

        if (Math.abs(dx) < SWIPE_THRESHOLD) return;
        if (Math.abs(dy) > Math.abs(dx)) return;

        const dir = dx < 0 ? 1 : -1;

        if (state.view === 'week') {
            const atLeft  = calendar.scrollLeft <= 1;
            const atRight = calendar.scrollLeft + calendar.clientWidth
                            >= calendar.scrollWidth - 1;
            if (dir === -1 && atLeft)  { navigate(-1); return; }
            if (dir ===  1 && atRight) { navigate( 1); return; }
            return;
        }
        navigate(dir);
    }, { passive: true });

    calendar.addEventListener('touchcancel', () => {
        pinchStartDist = 0;
        tracking = false;
    });

    window.addEventListener('resize', () => {
        if (state.view !== 'week') return;
        const cur = getColWidth();
        const clamped = Math.max(MIN_COL(), Math.min(MAX_COL, cur));
        if (Math.abs(clamped - cur) > 0.5) setColWidth(clamped);
    });
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

function updateTriggerLabel() {
    const trigger = document.querySelector('.filter-trigger');
    if (!trigger) return;

    const total = state.selectedGroups.size + state.selectedTeachers.size;
    const badge = trigger.querySelector('.filter-badge');
    if (!badge) return;

    const newText = total === 0 ? '' : (total > 99 ? '99+' : String(total));
    const changed = badge.textContent !== newText;

    badge.textContent = newText;

    if (total === 0) {
        badge.classList.remove('filter-badge--visible');
    } else {
        badge.classList.add('filter-badge--visible');
        if (changed) {
            badge.classList.remove('badge-pulse');
            void badge.offsetWidth;         // перезапуск анимации
            badge.classList.add('badge-pulse');
        }
    }
}

function updateCounter() {
    const counterEl = document.getElementById('filterCounter');
    if (!counterEl) return;

    const g = state.selectedGroups.size;
    const t = state.selectedTeachers.size;
    const totalG = state.groups.length;
    const totalT = state.teachers.length;
    const found = state.filteredEvents.length;

    let selectionText;
    if (g === 0 && t === 0) {
        selectionText = 'Ничего не выбрано';
    } else if (g === totalG && t === totalT && (totalG + totalT) > 0) {
        selectionText = 'Выбрано всё';
    } else {
        const parts = [];
        if (g > 0) parts.push(`групп: ${g}`);
        if (t > 0) parts.push(`преподавателей: ${t}`);
        selectionText = `Выбрано — ${parts.join(', ')}`;
    }

    const foundText = `найдено: ${found}`;
    counterEl.textContent = `${selectionText} · ${foundText}`;
}

function setupUnifiedFilter() {
    const root = document.getElementById('filterRoot');
    const trigger = root.querySelector('.filter-trigger');
    const dropdown = root.querySelector('.filter-dropdown');
    const search = root.querySelector('.filter-search');
    const clearBtn = root.querySelector('[data-action="clear"]');
    const selectAllBtn = root.querySelector('[data-action="select-all"]');
    const doneBtn = root.querySelector('.filter-done');
    const groupsListEl = document.getElementById('filterGroupsList');
    const teachersListEl = document.getElementById('filterTeachersList');

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

            applyFilters();
            updateTriggerLabel();
            updateCounter();
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
        history.pushState({ filterOpen: true }, '');
        setTimeout(() => search.focus(), 50);
    }

    function closeFilter() {
        if (!root.classList.contains('open')) return;
        if (history.state && history.state.filterOpen) {
            history.back();
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

    if (doneBtn) {
        doneBtn.addEventListener('click', e => {
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

    selectAllBtn.addEventListener('click', e => {
        e.stopPropagation();

        state.selectedGroups.clear();
        state.selectedTeachers.clear();
        for (const g of state.groups)   state.selectedGroups.add(g);
        for (const t of state.teachers) state.selectedTeachers.add(t);

        saveSetToStorage('schedule-selected-groups',   state.selectedGroups);
        saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);

        applyFilters();
        updateTriggerLabel();
        updateCounter();
        render();
        renderLists(search.value);
    });

    clearBtn.addEventListener('click', e => {
        e.stopPropagation();
        state.selectedGroups.clear();
        state.selectedTeachers.clear();
        saveSetToStorage('schedule-selected-groups', state.selectedGroups);
        saveSetToStorage('schedule-selected-teachers', state.selectedTeachers);
        applyFilters();
        updateTriggerLabel();
        updateCounter();
        render();
        renderLists(search.value);
    });

    dropdown.addEventListener('click', e => e.stopPropagation());

    updateTriggerLabel();
    updateCounter();

    window.addEventListener('resize', updateDateLabel);
}

// ==================== PULL TO REFRESH ====================
function setupPullToRefresh() {
    if (!('ontouchstart' in window)) return;

    const THRESHOLD = 70;
    const MAX_PULL = 100;

    const calendar = document.getElementById('calendar');

    const indicator = document.createElement('div');
    indicator.className = 'ptr-indicator';
    indicator.innerHTML = '<div class="ptr-spinner"></div>';
    document.body.appendChild(indicator);

    let startX = 0;
    let startY = 0;
    let currentPull = 0;
    let isPulling = false;

    const resetPull = () => {
        currentPull = 0;
        indicator.style.transform = 'translate(-50%, -70px)';
        indicator.classList.remove('ptr-ready');
    };

    calendar.addEventListener('touchstart', e => {
        if (e.touches.length > 1) {
            isPulling = false;
            resetPull();
            return;
        }
        if (calendar.scrollTop > 0) return;
        if (indicator.classList.contains('ptr-loading')) return;

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isPulling = true;
        currentPull = 0;
    }, { passive: true });

    calendar.addEventListener('touchmove', e => {
        if (!isPulling) return;

        if (e.touches.length > 1) {
            isPulling = false;
            resetPull();
            return;
        }

        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;

        if (Math.abs(dx) > Math.abs(dy)) {
            isPulling = false;
            resetPull();
            return;
        }

        if (dy <= 0) {
            resetPull();
            return;
        }

        if (calendar.scrollTop > 0) {
            isPulling = false;
            resetPull();
            return;
        }

        if (e.cancelable) e.preventDefault();

        currentPull = Math.min(MAX_PULL, dy * 0.5);
        indicator.style.transform = `translate(-50%, ${-70 + currentPull}px)`;
        indicator.classList.toggle('ptr-ready', currentPull >= THRESHOLD);
    }, { passive: false });

    const endPull = e => {
        if (!isPulling) return;
        if (e && e.touches && e.touches.length > 0) return;

        isPulling = false;

        if (currentPull >= THRESHOLD) {
            indicator.classList.add('ptr-loading');
            indicator.classList.remove('ptr-ready');
            indicator.style.transform = `translate(-50%, ${-70 + THRESHOLD}px)`;
            localStorage.setItem('schedule-cache-bust', Date.now().toString());
            setTimeout(() => location.reload(), 250);
        } else {
            resetPull();
        }
        currentPull = 0;
    };

    calendar.addEventListener('touchend', endPull);
    calendar.addEventListener('touchcancel', endPull);
}

// ==================== EXPORT TO GOOGLE CALENDAR ====================
const ICS_BASE = "https://pspu-ics-worker.vladjust059.workers.dev";

function buildIcsUrl() {
    const groups   = [...state.selectedGroups];
    const teachers = [...state.selectedTeachers];

    const isAll = (state.groups.length + state.teachers.length) > 0
        && groups.length   === state.groups.length
        && teachers.length === state.teachers.length;

    // Ничего не выбрано ИЛИ выбрано всё — универсальная ссылка /ics
    if ((groups.length === 0 && teachers.length === 0) || isAll) {
        return `${ICS_BASE}/ics`;
    }

    const enc = s => encodeURIComponent(s);
    const gPart = groups.length   ? `g/${groups.map(enc).join(",")}`   : "";
    const tPart = teachers.length ? `t/${teachers.map(enc).join(",")}` : "";

    if (gPart && tPart) return `${ICS_BASE}/${gPart}/${tPart}`;
    if (gPart)          return `${ICS_BASE}/${gPart}`;
    return `${ICS_BASE}/${tPart}`;
}

function setupExportModal() {
    const modal    = document.getElementById('exportModal');
    const urlEl    = document.getElementById('exportUrl');
    const copyBtn  = document.getElementById('copyUrlBtn');
    const copyTxt  = copyBtn.querySelector('.export-copy-text');
    const closeBtn = modal.querySelector('.export-close');
    const openBtn  = document.getElementById('openGcalBtn');

    let currentUrl = '';
    let copyTimer  = null;

    async function tryCopy() {
        try {
            await navigator.clipboard.writeText(currentUrl);
            copyBtn.classList.add('is-copied');
            copyTxt.textContent = 'Скопировано';
            if (copyTimer) clearTimeout(copyTimer);
            copyTimer = setTimeout(() => {
                copyBtn.classList.remove('is-copied');
                copyTxt.textContent = 'Копировать';
                copyTimer = null;
            }, 2000);
            return true;
        } catch (e) {
            console.warn('Clipboard недоступен:', e);
            return false;
        }
    }

    function open() {
        currentUrl = buildIcsUrl();
        urlEl.textContent = currentUrl;
        copyBtn.classList.remove('is-copied');
        copyTxt.textContent = 'Копировать';
        modal.classList.add('open');

        // Автоматически копируем — пользователю останется только вставить
        tryCopy();
    }

    function close() {
        modal.classList.remove('open');
        if (copyTimer) {
            clearTimeout(copyTimer);
            copyTimer = null;
        }
    }

    copyBtn.addEventListener('click', tryCopy);
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    openBtn.addEventListener('click', () => {
        window.open(
            "https://calendar.google.com/calendar/u/0/r/settings/addbyurl",
            "_blank",
            "noopener"
        );
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });

    return { open };
}

// ==================== INIT ====================
async function init() {
    document.documentElement.setAttribute('data-theme', state.theme);
    updateViewButton();
    updateThemeButton();

    let currentData;
    try {
        currentData = await loadData('data.json');
    } catch (e) {
        document.getElementById('calendar').innerHTML =
            `<div class="empty-state">Не удалось загрузить расписание: ${escapeHtml(e.message)}</div>`;
        return;
    }

    state.currentData = currentData;
    state.allEvents = expandEvents(currentData.events || []);
    updateUpdatedLabel(currentData.generated_at || null);

    const groups = new Set();
    const teachers = new Set();
    for (const ev of state.allEvents) {
        if (ev.group) groups.add(ev.group);
        (ev.teachers || []).forEach(t => teachers.add(t));
    }
    state.groups = [...groups].sort();
    state.teachers = [...teachers].sort();

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
    const exportModal = setupExportModal();
    document.getElementById('exportIcsBtn').addEventListener('click', exportModal.open);
    setupVersionToggle();

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

    document.addEventListener('click', (e) => {
        hideEventDetails();
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
        }
    });

    setupPullToRefresh();
    setupCalendarGestures();
    setupReadmeModal();
    render();
    setInterval(() => {
        if (state.displayedIso) updateUpdatedLabel(state.displayedIso);
    }, 60 * 1000);

}

document.addEventListener('DOMContentLoaded', init);