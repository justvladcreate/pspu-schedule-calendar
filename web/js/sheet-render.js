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
        // Сносим предыдущий stage целиком — iframe и обёртка уходят вместе.
        container.querySelectorAll('.original-render-stage').forEach(s => s.remove());

        const stage = document.createElement('div');
        stage.className = 'original-render-stage';

        const iframe = document.createElement('iframe');
        iframe.className = 'original-render-frame';
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.setAttribute('loading', 'eager');
        iframe.setAttribute('title', 'Оригинальное расписание');
        // Временно растягиваем — пока грузится. Настоящий размер
        // выставим после load, когда измерим контент.
        iframe.style.width  = '100%';
        iframe.style.height = '100%';

        let settled = false;
        const onLoad = () => {
            if (settled) return;
            settled = true;
            try {
                const doc = iframe.contentDocument;
                const win = iframe.contentWindow;
                if (!doc) throw new Error('contentDocument unavailable');

                // Даём Google CSS доехать, иначе scrollWidth/Height
                // измеряются до применения стилей.
                setTimeout(() => {
                    try {
                        const htmlEl = doc.documentElement;
                        const bodyEl = doc.body || htmlEl;

                        // На время замера снимаем overflow: hidden —
                        // при нём scrollWidth возвращает размер viewport'а,
                        // а не полную ширину контента, и таблица обрезается.
                        htmlEl.style.setProperty('overflow', 'visible', 'important');
                        bodyEl.style.setProperty('overflow', 'visible', 'important');

                        // Берём scrollWidth/Height самой таблицы Google —
                        // у неё фиксированные ширины колонок, поэтому
                        // эти значения равны истинному размеру контента.
                        const table = doc.querySelector('table');
                        let nativeW, nativeH;

                        if (table) {
                            nativeW = Math.max(table.scrollWidth, table.offsetWidth, 800);
                            nativeH = Math.max(table.scrollHeight, table.offsetHeight, 600);
                        } else {
                            // Fallback: если по какой-то причине таблицы нет.
                            nativeW = Math.max(htmlEl.scrollWidth, bodyEl.scrollWidth, 800);
                            nativeH = Math.max(htmlEl.scrollHeight, bodyEl.scrollHeight, 600);
                        }

                        // Возвращаем overflow: hidden.
                        htmlEl.style.removeProperty('overflow');
                        bodyEl.style.removeProperty('overflow');

                        iframe.style.width  = nativeW + 'px';
                        iframe.style.height = nativeH + 'px';

                        resolve({ iframe, stage, doc, win, nativeW, nativeH });
                    } catch (e) {
                        reject(e);
                    }
                }, 30);
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
        stage.appendChild(iframe);
        container.appendChild(stage);
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
 * Подсвечивает ячейку и плавно скроллит к ней РОДИТЕЛЬСКИЙ wrap.
 * Внутри iframe мы теперь не скроллим — iframe статичный,
 * прокрутка живёт в .original-sheet-wrap.
 *
 * zoom — текущий scale, нужен чтобы перевести координаты td
 * (внутри stage) в координаты скролла wrap'а.
 */
export function focusCellInFrame(wrapEl, iframe, cell, zoom) {
    if (!wrapEl || !iframe || !cell) return;

    // Скролл родителя к позиции td. getBoundingClientRect даёт
    // координаты в визуальных пикселях, а wrap.scrollLeft — в
    // натуральных пикселях stage. Делим на zoom, чтобы получить
    // «сырую» координату внутри stage.
    requestAnimationFrame(() => {
        const wrapRect = wrapEl.getBoundingClientRect();
        const cellRect = cell.getBoundingClientRect();

        const scale = zoom || 1;

        // Позиция центра ячейки относительно левого/верхнего края wrap,
        // в ВИЗУАЛЬНЫХ пикселях (iframe уже с transform: scale).
        const cellCenterVisualX = cellRect.left + cellRect.width  / 2 - wrapRect.left;
        const cellCenterVisualY = cellRect.top  + cellRect.height / 2 - wrapRect.top;

        // scrollLeft/scrollTop wrap'а живут в НАТУРАЛЬНЫХ пикселях stage,
        // поэтому визуальные делим на scale. Формула:
        //   targetScrollX = scrollLeft + (cellCenterVisualX - wrapWidth/2) / scale
        // Даёт центрирование ячейки в видимой области wrap'а.
        const targetScrollX = wrapEl.scrollLeft
            + (cellCenterVisualX - wrapRect.width  / 2) / scale;
        const targetScrollY = wrapEl.scrollTop
            + (cellCenterVisualY - wrapRect.height / 2) / scale;

        wrapEl.scrollTo({
            left: Math.max(0, targetScrollX),
            top:  Math.max(0, targetScrollY),
            behavior: 'smooth',
        });
    });

    // Подсветка — через inline-стиль, перебиваем Google CSS.
    cell.style.outline = '2px solid #4285f4';
    cell.style.outlineOffset = '-2px';
    cell.style.backgroundColor = '#e8f0fe';

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

export function setupFrameGestures(iframe, wrapEl, { getZoom, setZoom, onCommit }) {
    if (!iframe || !wrapEl) return () => {};

    /* Слушатели жестов вешаем на РОДИТЕЛЬСКИЙ wrap — потому что
       теперь скроллит он, а iframe получает события через
       bubbling, когда пользователь тапает внутри него. */

    let pinching = false;
    let startDist = 0;
    let startScale = 1;
    let anchorX = 0, anchorY = 0;      // координата пальца внутри wrap'а
    let startScrollX = 0, startScrollY = 0;
    let rafPending = false;
    let pendingZoom = 1;
    let pendingScrollX = 0, pendingScrollY = 0;

    const dist = (t1, t2) => {
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        return Math.hypot(dx, dy);
    };

    const onGesture = (e) => { if (e.cancelable) e.preventDefault(); };

    function onTouchStart(e) {
        if (e.touches.length !== 2) return;
        pinching = true;
        startDist   = dist(e.touches[0], e.touches[1]);
        startScale  = getZoom();

        const r = wrapEl.getBoundingClientRect();
        const t1 = e.touches[0], t2 = e.touches[1];
        // Точка между пальцами ВНУТРИ wrap'а (визуальные пиксели).
        anchorX = (t1.clientX + t2.clientX) / 2 - r.left;
        anchorY = (t1.clientY + t2.clientY) / 2 - r.top;

        startScrollX = wrapEl.scrollLeft;
        startScrollY = wrapEl.scrollTop;
    }

    function onTouchMove(e) {
        if (!pinching || e.touches.length !== 2) return;
        if (e.cancelable) e.preventDefault();

        const d = dist(e.touches[0], e.touches[1]);
        if (startDist < 1) return;

        let z = startScale * (d / startDist);
        z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

        // Универсальная формула: точка stage под пальцем остаётся
        // на месте при смене scale. stageX = (anchor + startScroll)/startScale,
        // потом newScroll = stageX * z - anchor.
        const ratio = z / startScale;
        const newScrollX = (anchorX + startScrollX) * ratio - anchorX;
        const newScrollY = (anchorY + startScrollY) * ratio - anchorY;

        pendingZoom = z;
        pendingScrollX = newScrollX;
        pendingScrollY = newScrollY;

        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;

                // setZoom меняет только stage.width/height и transform
                // iframe. Layout внутри iframe не трогается — нет
                // пересчёта 260 td. Всё дешево.
                setZoom(pendingZoom);

                // Скролл — сразу после, тоже в этом кадре. Двойного
                // reflow не будет: setZoom меняет размер stage,
                // затем мы просто двигаем scrollLeft/Top.
                wrapEl.scrollLeft = pendingScrollX;
                wrapEl.scrollTop  = pendingScrollY;
            });
        }
    }

    function onTouchEnd(e) {
        if (e.touches.length >= 2) return;
        if (!pinching) return;
        pinching = false;

        if (typeof onCommit === 'function') {
            try { onCommit(getZoom()); } catch {}
        }
    }

    // Слушаем на wrap — если пользователь тапает по iframe, событие
    // всплывёт наверх, но target останется внутри iframe. Это ок,
    // нам важны координаты касаний в системе wrap'а.
    wrapEl.addEventListener('touchstart', onTouchStart, { passive: true });
    wrapEl.addEventListener('touchmove',  onTouchMove,  { passive: false });
    wrapEl.addEventListener('touchend',    onTouchEnd,   { passive: true });
    wrapEl.addEventListener('touchcancel', onTouchEnd,   { passive: true });

    // iOS-only: блокируем page-zoom. Вешаем и на wrap, и в сам iframe
    // (для Safari, где gesture* события приходят в iframe-контекст).
    wrapEl.addEventListener('gesturestart',  onGesture, { passive: false });
    wrapEl.addEventListener('gesturechange', onGesture, { passive: false });
    wrapEl.addEventListener('gestureend',    onGesture, { passive: false });

    let iframeGestureCleanup = null;
    try {
        const innerDoc = iframe.contentDocument;
        if (innerDoc) {
            innerDoc.addEventListener('gesturestart',  onGesture, { passive: false });
            innerDoc.addEventListener('gesturechange', onGesture, { passive: false });
            innerDoc.addEventListener('gestureend',    onGesture, { passive: false });
            iframeGestureCleanup = () => {
                innerDoc.removeEventListener('gesturestart',  onGesture);
                innerDoc.removeEventListener('gesturechange', onGesture);
                innerDoc.removeEventListener('gestureend',    onGesture);
            };
        }
    } catch {}

    return () => {
        wrapEl.removeEventListener('touchstart', onTouchStart);
        wrapEl.removeEventListener('touchmove',  onTouchMove);
        wrapEl.removeEventListener('touchend',   onTouchEnd);
        wrapEl.removeEventListener('touchcancel', onTouchEnd);
        wrapEl.removeEventListener('gesturestart',  onGesture);
        wrapEl.removeEventListener('gesturechange', onGesture);
        wrapEl.removeEventListener('gestureend',    onGesture);
        if (iframeGestureCleanup) iframeGestureCleanup();
    };
}