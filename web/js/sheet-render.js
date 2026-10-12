'use strict';

/* ============================================================
 *  Рендер-обёртка: srcdoc-iframe + поиск/фокус ячейки.
 *
 *  iframe.srcdoc наследует origin родителя — значит, можем
 *  дотянуться до contentDocument и управлять подсветкой.
 *  Стили полностью на стороне Google (см. sheets.js).
 * ============================================================ */

/**
 * Вставляет HTML в srcdoc-iframe внутри container.
 * Возвращает Promise<{ iframe, doc, win }> после onload.
 */
export function mountSheetFrame(container, html) {
    return new Promise((resolve, reject) => {
        container.querySelectorAll('.original-render-frame').forEach(f => f.remove());

        const iframe = document.createElement('iframe');
        iframe.className = 'original-render-frame';
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.setAttribute('loading', 'eager');
        iframe.setAttribute('title', 'Оригинальное расписание');

        let settled = false;
        const onLoad = () => {
            if (settled) return;
            settled = true;
            try {
                const doc = iframe.contentDocument;
                const win = iframe.contentWindow;
                if (!doc) throw new Error('contentDocument unavailable');
                resolve({ iframe, doc, win });
            } catch (e) {
                reject(e);
            }
        };

        iframe.addEventListener('load', onLoad, { once: true });
        iframe.addEventListener('error', () => {
            if (settled) return;
            settled = true;
            reject(new Error('iframe load failed'));
        }, { once: true });

        iframe.srcdoc = html;
        container.appendChild(iframe);
    });
}

/**
 * Ищет <td> в iframe по A1-позиции или по тексту.
 * Возвращает td или null.
 */
/**
 * Ищет <td> в iframe. Три стратегии по убыванию точности:
 *
 *   1. position как A1 ("D5") — быстро и точно, если формат такой.
 *   2. weekday + pair_number — структурный поиск: находим строку
 *      таблицы, где в столбце «День» = нужный день, а в столбце
 *      «№» = нужный номер пары. Так мы попадаем в правильную
 *      ячейку даже если дисциплина повторяется в листе.
 *   3. Ско́ринг по дисциплине + датам + преподавателю — резерв.
 *
 * opts = {
 *   position   : "D5" | 2 | null,
 *   discipline : "Основы предпринимательства",
 *   dates      : ["28.09.2026", ...],
 *   teachers   : ["Рожнёва И.В.", ...],
 *   weekday    : "ПН",
 *   pairNumber : 5,
 * }
 */
export function findCellInFrame(doc, opts) {
    const tds = [...doc.querySelectorAll('td')];
    if (!tds.length) return null;

    const o = opts || {};
    const position   = o.position;
    const weekday    = o.weekday;
    const pairNumber = o.pairNumber;

    // 1) position как A1
    if (typeof position === 'string') {
        const target = parsePositionLocal(position);
        if (target) {
            const td = findByCoord(doc, target);
            if (td) return td;
        }
    }

    // 2) Структурный поиск: день недели + номер пары
    if (weekday && pairNumber != null) {
        const td = findByDayPair(doc, weekday, pairNumber);
        if (td) return td;
    }

    // 3) Текстовый скоринг
    return findByTextScore(tds, o);
}

/* ---------- Стратегия 2: день + пара ---------- */

function findByDayPair(doc, weekday, pairNumber) {
    const tables = doc.querySelectorAll('table');

    for (const table of tables) {
        const grid = buildGridMap(table);
        if (grid.rowCount === 0) continue;

        // Ищем строку-заголовок с колонками «День», «№», «Дисциплина»
        let headerRow = -1;
        let dayCol = -1, pairCol = -1, discCol = -1;

        const maxHeaderScan = Math.min(grid.rowCount, 30);
        for (let r = 0; r < maxHeaderScan; r++) {
            let tryDay = -1, tryPair = -1, tryDisc = -1;
            for (let c = 0; c < 40; c++) {
                const cell = grid.map.get(r + ',' + c);
                if (!cell) continue;
                const text = (cell.td.textContent || '').trim().toLowerCase();
                if (!text) continue;

                if (tryDay === -1 && /^день/.test(text))         tryDay  = c;
                else if (tryPair === -1 && /^№?\s*$/.test(text)) tryPair = c;
                else if (tryDisc === -1 && /^дисциплин/.test(text)) tryDisc = c;
            }
            if (tryDay !== -1 && tryPair !== -1 && tryDisc !== -1) {
                headerRow = r;
                dayCol    = tryDay;
                pairCol   = tryPair;
                discCol   = tryDisc;
                break;
            }
        }

        if (headerRow === -1) continue;

        const dayNorm  = normalizeDay(weekday);
        const pairNorm = normalizePair(pairNumber);

        for (let r = headerRow + 1; r < grid.rowCount; r++) {
            const dayCell  = grid.map.get(r + ',' + dayCol);
            const pairCell = grid.map.get(r + ',' + pairCol);
            const discCell = grid.map.get(r + ',' + discCol);
            if (!discCell) continue;

            const dayText  = dayCell  ? (dayCell.td.textContent  || '').trim() : '';
            const pairText = pairCell ? (pairCell.td.textContent || '').trim() : '';

            if (normalizeDay(dayText) === dayNorm &&
                normalizePair(pairText) === pairNorm) {
                if (window.PSPU_DEBUG_FIND_CELL) {
                    console.debug('[findByDayPair] hit at row', r, {
                        dayText, pairText,
                        disc: (discCell.td.textContent || '').slice(0, 80),
                    });
                }
                return discCell.td;
            }
        }
    }
    return null;
}

/** Строит карту (row, col) → ячейка, раскрывая colspan/rowspan. */
function buildGridMap(table) {
    const map = new Map();
    const occupied = new Set();
    const rows = table.querySelectorAll('tbody tr, tr');

    let rowIdx = 0;
    for (const tr of rows) {
        let col = 0;
        for (const td of tr.children) {
            if (td.tagName !== 'TD') continue;
            while (occupied.has(rowIdx + ',' + col)) col++;

            const colspan = Math.max(1, parseInt(td.getAttribute('colspan') || '1', 10) || 1);
            const rowspan = Math.max(1, parseInt(td.getAttribute('rowspan') || '1', 10) || 1);

            for (let dr = 0; dr < rowspan; dr++) {
                for (let dc = 0; dc < colspan; dc++) {
                    map.set((rowIdx + dr) + ',' + (col + dc), { td, row: rowIdx, col });
                    occupied.add((rowIdx + dr) + ',' + (col + dc));
                }
            }
            col += colspan;
        }
        rowIdx++;
    }
    return { map, rowCount: rowIdx };
}

function normalizeDay(s) {
    if (!s) return '';
    const t = String(s).toLowerCase().replace(/[^а-яёa-z]/g, '');
    const map = {
        'понедельник': 'пн', 'пн': 'пн', 'mon': 'пн', 'monday': 'пн',
        'вторник':     'вт', 'вт': 'вт', 'tue': 'вт', 'tuesday': 'вт',
        'среда':       'ср', 'ср': 'ср', 'wed': 'ср', 'wednesday': 'ср',
        'четверг':     'чт', 'чт': 'чт', 'thu': 'чт', 'thursday': 'чт',
        'пятница':     'пт', 'пт': 'пт', 'fri': 'пт', 'friday': 'пт',
        'суббота':     'сб', 'сб': 'сб', 'sat': 'сб', 'saturday': 'сб',
        'воскресенье': 'вс', 'вс': 'вс', 'sun': 'вс', 'sunday': 'вс',
    };
    return map[t] || t.slice(0, 2);
}

function normalizePair(s) {
    if (s == null) return '';
    const m = String(s).match(/\d+/);
    return m ? m[0] : '';
}

/* ---------- Стратегия 3: текстовый скоринг ---------- */

function findByTextScore(tds, o) {
    const discipline = o.discipline;
    const dates      = o.dates    || [];
    const teachers   = o.teachers || [];

    if (!discipline && dates.length === 0 && teachers.length === 0) return null;

    const needle = discipline
        ? String(discipline).toLowerCase().replace(/\s+/g, ' ').trim()
        : '';
    const needleWords = needle
        ? needle.split(/\s+/).filter(w => w.length >= 5)
        : [];
    const needleStrong = needleWords.sort((a, b) => b.length - a.length)[0] || '';

    const dateShort = dates.map(d => {
        const p = String(d).split('.');
        return p.length >= 2 ? p[0] + '.' + p[1] : null;
    }).filter(Boolean);

    const teacherNeedles = teachers.map(t => String(t).toLowerCase()).filter(Boolean);

    let best = null;
    let bestScore = 0;

    for (const td of tds) {
        const raw = td.textContent || '';
        if (!raw) continue;
        const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();

        let score = 0;

        if (needle && text.includes(needle)) score += 3;
        else if (needleStrong && text.includes(needleStrong)) score += 1;

        if (dateShort.length) {
            let hit = 0;
            for (const d of dateShort) if (text.includes(d)) hit++;
            if (hit) score += (hit / dateShort.length) * 4;
        }

        if (teacherNeedles.length) {
            for (const t of teacherNeedles) {
                if (text.includes(t)) { score += 2; break; }
            }
        }

        if (score > bestScore) {
            bestScore = score;
            best = td;
        }
    }

    if (window.PSPU_DEBUG_FIND_CELL) {
        console.debug('[findByTextScore]', {
            discipline,
            dates: dateShort,
            teachers: teacherNeedles,
            candidates: tds.length,
            bestScore,
            bestText: best ? (best.textContent || '').slice(0, 80) : null,
        });
    }

    return bestScore > 0 ? best : null;
}

/* Поиск td по координатам (0-based) с учётом colspan/rowspan. */
function findByCoord(doc, target) {
    const occupied = new Set();
    let rowIdx = 0;

    const trs = doc.querySelectorAll('table tbody tr');
    for (const tr of trs) {
        let col = 0;
        for (const td of tr.children) {
            if (td.tagName !== 'TD') continue;
            while (occupied.has(rowIdx + ',' + col)) col++;

            const colspan = Math.max(1, parseInt(td.getAttribute('colspan') || '1', 10) || 1);
            const rowspan = Math.max(1, parseInt(td.getAttribute('rowspan') || '1', 10) || 1);

            if (rowIdx === target.row && col === target.col) return td;
            if (
                rowIdx <= target.row && target.row < rowIdx + rowspan &&
                col    <= target.col && target.col < col + colspan
            ) {
                return td;
            }

            for (let dr = 0; dr < rowspan; dr++) {
                for (let dc = 0; dc < colspan; dc++) {
                    occupied.add((rowIdx + dr) + ',' + (col + dc));
                }
            }
            col += colspan;
        }
        rowIdx++;
    }
    return null;
}

/* локальная копия, чтобы не тащить import циклов */
function parsePositionLocal(pos) {
    const m = String(pos).trim().match(/^([A-Z]+)(\d+)$/i);
    if (!m) return null;
    let n = 0;
    for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return { col: n - 1, row: parseInt(m[2], 10) - 1 };
}

/**
 * Подсвечивает ячейку и плавно скроллит к ней внутри iframe.
 * Вызывается после mountSheetFrame.
 */
export function focusCellInFrame(iframe, cell) {
    if (!cell) return;

    // Скролл внутри iframe
    try {
        cell.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch {
        cell.scrollIntoView();
    }

    // Подсветка — через inline-стиль, чтобы перебить Google CSS.
    // Не восстанавливаем предыдущее значение: iframe пересоздаётся
    // при каждом focusOn, старый DOM уходит вместе с ним.
    cell.style.outline = '2px solid #4285f4';
    cell.style.outlineOffset = '-2px';
    cell.style.backgroundColor = '#e8f0fe';

    // Пульс
    try {
        cell.animate(
            [
                { transform: 'scale(1)',    boxShadow: '0 0 0 0 rgba(66,133,244,0.55)' },
                { transform: 'scale(1.04)', boxShadow: '0 0 0 14px rgba(66,133,244,0)' },
                { transform: 'scale(1)',    boxShadow: '0 0 0 0 rgba(66,133,244,0.55)' },
            ],
            { duration: 1000, iterations: 2, easing: 'ease-out' }
        );
    } catch {}
}

/* ============================================================
 *  PINCH-TO-ZOOM внутри iframe.
 *
 *  Touch-события не всплывают из iframe в родительский документ,
 *  поэтому слушатели живут внутри contentDocument. Мат. часть:
 *  точка под пальцами должна остаться на месте — при смене scale
 *  корректируем внутренний scroll iframe.
 *
 *  getZoom()    — прочитать текущий scale
 *  setZoom(z)   — визуально применить новый scale (без записи в LS)
 *  onCommit(z)  — один раз по touchend, финальное сохранение
 * ============================================================ */

/* Диапазон pinch-to-zoom. Нижняя граница — чтобы «отдалить обзором»
   можно было увидеть сразу несколько колонок листа; верхняя —
   чтобы разглядеть мелкий шрифт в примечаниях. */
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 2.5;

export function setupFrameGestures(iframe, { getZoom, setZoom, onCommit }) {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) return () => {};

    // Отключаем браузерный pinch внутри iframe.
    const style = doc.createElement('style');
    style.textContent = 'html, body { touch-action: pan-x pan-y !important; }';
    doc.head.appendChild(style);

    let pinching = false;
    let startDist = 0;
    let startScale = 1;
    let midX = 0, midY = 0;
    let startScrollX = 0, startScrollY = 0;
    let rafPending = false;
    let pendingZoom = 1;
    let pendingScrollX = 0, pendingScrollY = 0;

    const dist = (t1, t2) => {
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        return Math.hypot(dx, dy);
    };

    /* iOS Safari: без этой блокировки двухпальцевый жест внутри
       iframe превращается в page-zoom — зумится вся страница с
       календарём. touch-action iOS частично игнорирует, а вот
       gesture* события — слушает. */
    const onGesture = (e) => { if (e.cancelable) e.preventDefault(); };

    function onTouchStart(e) {
        if (e.touches.length !== 2) return;
        pinching = true;
        startDist   = dist(e.touches[0], e.touches[1]);
        startScale  = getZoom();

        const r = iframe.getBoundingClientRect();
        const t1 = e.touches[0], t2 = e.touches[1];
        midX = (t1.clientX + t2.clientX) / 2 - r.left;
        midY = (t1.clientY + t2.clientY) / 2 - r.top;

        startScrollX = win.scrollX || 0;
        startScrollY = win.scrollY || 0;
    }

    function onTouchMove(e) {
        if (!pinching || e.touches.length !== 2) return;
        if (e.cancelable) e.preventDefault();

        const d = dist(e.touches[0], e.touches[1]);
        if (startDist < 1) return;

        let z = startScale * (d / startDist);
        z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

        const scrollX = startScrollX + midX * (1 / startScale - 1 / z);
        const scrollY = startScrollY + midY * (1 / startScale - 1 / z);

        // Накапливаем изменения и выплёскиваем их ОДНИМ rAF-ом.
        // Это важно: setZoom меняет iframe.width/height — тяжёлый
        // layout внутри iframe (Google Sheets пересчитывает таблицу).
        // Раньше scrollTo летел отдельным rAF — получалось два
        // layout'а на кадр, отсюда статтер на слабых телефонах.
        pendingZoom = z;
        pendingScrollX = scrollX;
        pendingScrollY = scrollY;

        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                setZoom(pendingZoom);   // visual only
                try { win.scrollTo(pendingScrollX, pendingScrollY); } catch {}
            });
        }
    }

    function onTouchEnd(e) {
        if (e.touches.length >= 2) return;
        if (!pinching) return;
        pinching = false;

        // Финал жеста — вот тут сохраняем zoom один раз.
        if (typeof onCommit === 'function') {
            try { onCommit(getZoom()); } catch {}
        }
    }

    doc.addEventListener('touchstart', onTouchStart, { passive: true });
    doc.addEventListener('touchmove',  onTouchMove,  { passive: false });
    doc.addEventListener('touchend',    onTouchEnd,   { passive: true });
    doc.addEventListener('touchcancel', onTouchEnd,   { passive: true });

    // iOS-only: блокируем page-zoom.
    doc.addEventListener('gesturestart',  onGesture, { passive: false });
    doc.addEventListener('gesturechange', onGesture, { passive: false });
    doc.addEventListener('gestureend',    onGesture, { passive: false });

    return () => {
        doc.removeEventListener('touchstart', onTouchStart);
        doc.removeEventListener('touchmove',  onTouchMove);
        doc.removeEventListener('touchend',   onTouchEnd);
        doc.removeEventListener('touchcancel', onTouchEnd);
        doc.removeEventListener('gesturestart',  onGesture);
        doc.removeEventListener('gesturechange', onGesture);
        doc.removeEventListener('gestureend',    onGesture);
    };
}