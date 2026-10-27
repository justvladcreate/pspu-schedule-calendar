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
        container.querySelectorAll('.original-render-stage').forEach(s => s.remove());

        const stage = document.createElement('div');
        stage.className = 'original-render-stage';

        const iframe = document.createElement('iframe');
        iframe.className = 'original-render-frame';
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.setAttribute('loading', 'eager');
        iframe.setAttribute('title', 'Оригинальное расписание');
        // Стартовые размеры — временные. Настоящие (nativeW × nativeH)
        // выставим после load. Этап «до измерения» живёт 30 мс.
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

                setTimeout(() => {
                    try {
                        const htmlEl = doc.documentElement;
                        const bodyEl = doc.body || htmlEl;

                        // На время замера снимаем overflow: hidden —
                        // иначе scrollWidth вернёт размер viewport'а.
                        htmlEl.style.setProperty('overflow', 'visible', 'important');
                        bodyEl.style.setProperty('overflow', 'visible', 'important');

                        const table = doc.querySelector('table');
                        let nativeW, nativeH;

                        if (table) {
                            nativeW = Math.max(table.scrollWidth, table.offsetWidth, 800);
                            nativeH = Math.max(table.scrollHeight, table.offsetHeight, 600);
                        } else {
                            nativeW = Math.max(htmlEl.scrollWidth, bodyEl.scrollWidth, 800);
                            nativeH = Math.max(htmlEl.scrollHeight, bodyEl.scrollHeight, 600);
                        }

                        htmlEl.style.removeProperty('overflow');
                        bodyEl.style.removeProperty('overflow');

                        // Фиксируем iframe по натуральному размеру.
                        // Больше не меняется — zoom работает через
                        // transform: scale, без reflow внутри iframe.
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
 * Ищет <td> в iframe. Стратегии по убыванию точности:
 *
 *   1. position как A1 ("D5") — быстро и точно, если формат такой.
 *   2. weekday + time_start — структурный поиск по строке листа,
 *      где «День» совпадает, а «Начало занятий» равно времени
 *      события. Самый надёжный вариант для расписания ПГГПУ:
 *      в одном слоте «№ пары» может быть несколько подстрок
 *      (например, практика с 12.00 внутри пары 3).
 *   3. weekday + pair_number — резерв для листов без колонки
 *      времени; результат проверяем по тексту, чтобы не уехать
 *      на соседнюю пару.
 *   4. Ско́ринг по дисциплине + датам + преподавателю.
 *
 * opts = {
 *   position   : "D5" | 2 | null,
 *   discipline : "Основы предпринимательства",
 *   dates      : ["28.09.2026", ...],
 *   teachers   : ["Рожнёва И.В.", ...],
 *   weekday    : "ПН",
 *   pairNumber : 5,
 *   timeStart  : "12:00",
 * }
 */
export function findCellInFrame(doc, opts) {
    const tds = [...doc.querySelectorAll('td')];
    if (!tds.length) return null;

    const o = opts || {};
    const position   = o.position;
    const weekday    = o.weekday;
    const pairNumber = o.pairNumber;
    const timeStart  = o.timeStart;

    // 1) position как A1
    if (typeof position === 'string') {
        const target = parsePositionLocal(position);
        if (target) {
            const td = findByCoord(doc, target);
            if (td) return td;
        }
    }

    // 2) Структурный поиск: день недели + время начала
    if (weekday && timeStart && normalizeTime(timeStart)) {
        const candidates = findByDayTime(doc, weekday, timeStart);
        if (candidates.length > 0) {
            const best = findByTextScore(candidates, o, { requireText: true });
            if (best) return best;
            if (candidates.length === 1) return candidates[0];
        }
    }

    // 3) Структурный поиск: день недели + номер пары
    if (weekday && pairNumber != null) {
        const candidates = findByDayPair(doc, weekday, pairNumber);
        if (candidates.length > 0) {
            const best = findByTextScore(candidates, o, { requireText: true });
            if (best) return best;
            // Если текст не совпал — не отдаём первую попавшуюся ячейку:
            // это может быть соседняя пара (как в слоте с несколькими
            // дисциплинами). Пусть решает общий текстовый скоринг.
        }
    }

    // 4) Текстовый скоринг по всей таблице (запасной вариант)
    if (o.discipline || (o.teachers && o.teachers.length) || (o.dates && o.dates.length)) {
        const td = findByTextScore(tds, o);
        if (td) return td;
    }

    return null;
}

/* ---------- Заголовок таблицы ---------- */

/**
 * Ищет строку-заголовок и номера колонок «День», «№»,
 * «Начало занятий» и «Дисциплина».
 */
function findHeaderColumns(grid) {
    const maxHeaderScan = Math.min(grid.rowCount, 30);
    for (let r = 0; r < maxHeaderScan; r++) {
        let dayCol = -1, pairCol = -1, timeCol = -1, discCol = -1;

        for (let c = 0; c < 40; c++) {
            const cell = grid.map.get(r + ',' + c);
            if (!cell) continue;
            const text = (cell.td.textContent || '').trim().toLowerCase();
            if (!text) continue;

            if (dayCol === -1 && /^день/.test(text))                dayCol  = c;
            else if (timeCol === -1 && /^(начало|время)/.test(text)) timeCol = c;
            else if (pairCol === -1 && /^№?\s*$/.test(text))        pairCol = c;
            else if (discCol === -1 && /^дисциплин/.test(text))     discCol = c;
        }

        if (dayCol !== -1 && discCol !== -1 && (timeCol !== -1 || pairCol !== -1)) {
            const discCell = grid.map.get(r + ',' + discCol);
            const discSpan = Math.max(1, parseInt(discCell.td.getAttribute('colspan') || '1', 10) || 1);
            return { row: r, dayCol, pairCol, timeCol, discCol, discSpan };
        }
    }
    return null;
}

/** Непустые ячейки строки начиная с колонки «Дисциплина». */
function collectRowCells(grid, rowIdx, startCol, span) {
    const out = [];
    const end = startCol + Math.max(1, span || 1);
    for (let c = startCol; c < end; c++) {
        const cell = grid.map.get(rowIdx + ',' + c);
        if (!cell) continue;
        if (!(cell.td.textContent || '').trim()) continue;
        if (!out.includes(cell.td)) out.push(cell.td);
    }
    return out;
}

/* ---------- Стратегия 2: день + время начала ---------- */

function findByDayTime(doc, weekday, timeStart) {
    const candidates = [];
    const dayNorm  = normalizeDay(weekday);
    const timeNorm = normalizeTime(timeStart);
    if (!timeNorm) return candidates;

    for (const table of doc.querySelectorAll('table')) {
        const grid = buildGridMap(table);
        if (grid.rowCount === 0) continue;

        const hdr = findHeaderColumns(grid);
        if (!hdr || hdr.timeCol === -1) continue;

        let currentDayText = '';
        for (let r = hdr.row + 1; r < grid.rowCount; r++) {
            const dayCell  = grid.map.get(r + ',' + hdr.dayCol);
            const timeCell = grid.map.get(r + ',' + hdr.timeCol);
            if (!timeCell) continue;

            const dayText = dayCell ? (dayCell.td.textContent || '').trim() : '';
            if (dayText) currentDayText = dayText;

            if (normalizeDay(currentDayText) !== dayNorm) continue;

            const timeText = (timeCell.td.textContent || '').trim();
            if (normalizeTime(timeText) !== timeNorm) continue;

            // В строке может быть несколько колонок дисциплин
            // (подгруппы), а основная может быть пустой. Поэтому
            // берём все непустые ячейки начиная с колонки «Дисциплина».
            if (window.PSPU_DEBUG_FIND_CELL) {
                console.debug('[findByDayTime] hit at row', r, {
                    dayText: currentDayText, timeText,
                });
            }
            for (const td of collectRowCells(grid, r, hdr.discCol, hdr.discSpan)) {
                if (!candidates.includes(td)) candidates.push(td);
            }
        }
    }
    return candidates;
}

/* ---------- Стратегия 3: день + пара ---------- */

function findByDayPair(doc, weekday, pairNumber) {
    const candidates = [];

    for (const table of doc.querySelectorAll('table')) {
        const grid = buildGridMap(table);
        if (grid.rowCount === 0) continue;

        const hdr = findHeaderColumns(grid);
        if (!hdr || hdr.pairCol === -1) continue;

        const dayNorm  = normalizeDay(weekday);
        const pairNorm = normalizePair(pairNumber);

        let currentDayText = '';
        for (let r = hdr.row + 1; r < grid.rowCount; r++) {
            const dayCell  = grid.map.get(r + ',' + hdr.dayCol);
            const pairCell = grid.map.get(r + ',' + hdr.pairCol);
            if (!pairCell) continue;

            // Если в ячейке есть текст (ПН, ВТ), запоминаем его для следующих строк
            const dayText = dayCell ? (dayCell.td.textContent || '').trim() : '';
            if (dayText) {
                currentDayText = dayText;
            }

            const pairText = (pairCell.td.textContent || '').trim();

            // Сравниваем с запомненным днём
            if (normalizeDay(currentDayText) === dayNorm &&
                normalizePair(pairText) === pairNorm) {
                if (window.PSPU_DEBUG_FIND_CELL) {
                    console.debug('[findByDayPair] hit at row', r, {
                        dayText: currentDayText, pairText,
                    });
                }
                for (const td of collectRowCells(grid, r, hdr.discCol, hdr.discSpan)) {
                    if (!candidates.includes(td)) candidates.push(td);
                }
            }
        }
    }
    return candidates;
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

/* Часы раньше 6 — это не время пары, а что-то вроде даты «3.09». */
const MIN_HOUR = 6;

/** «12:00», «12.00», «12-00» → «12:00». Пустая строка, если это не время. */
function normalizeTime(s) {
    if (s == null) return '';
    const m = String(s).match(/(\d{1,2})\s*[.:\-–]\s*(\d{2})/);
    if (!m) return '';
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < MIN_HOUR || h > 23 || min > 59) return '';
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

/** Текст для сравнения: без пунктуации и кавычек, ё → е, схлопнутые пробелы. */
function normalizeText(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^0-9a-zа-я]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/** Время из строки таблицы (колонка «Начало занятий»). */
function getRowTime(td) {
    const tr = td.closest('tr');
    if (!tr) return '';
    const cells = [...tr.querySelectorAll('td')].slice(0, 4);
    for (const cell of cells) {
        const txt = (cell.textContent || '').trim();
        if (!txt || txt.length > 7) continue;
        const t = normalizeTime(txt);
        if (t) return t;
    }
    return '';
}

/** Номер пары из строки таблицы. */
function getRowPair(td) {
    const tr = td.closest('tr');
    if (!tr) return '';
    const cells = [...tr.querySelectorAll('td')].slice(0, 4);
    for (const cell of cells) {
        const txt = (cell.textContent || '').trim();
        if (/^\d{1,2}$/.test(txt)) return txt;
    }
    return '';
}

/* ---------- Стратегия 4: текстовый скоринг ---------- */

function findByTextScore(tds, o, { requireText = false } = {}) {
    const discipline = o.discipline;
    const dates      = o.dates    || [];
    const teachers   = o.teachers || [];
    const pairNumber = o.pairNumber;
    const timeStart  = normalizeTime(o.timeStart);

    if (!discipline && dates.length === 0 && teachers.length === 0 && !timeStart) return null;

    const needle = discipline ? normalizeText(discipline) : '';
    const needleWords = needle
        ? needle.split(' ').filter(w => w.length >= 5)
        : [];
    const needleStrong = needleWords.slice().sort((a, b) => b.length - a.length)[0] || '';

    // Для сравнения с листом берём и «06.10», и «6.10»: в таблице
    // даты часто записаны без ведущего нуля.
    const dateShort = [];
    for (const d of dates) {
        const p = String(d).split('.');
        if (p.length < 2) continue;
        dateShort.push(p[0] + '.' + p[1]);
        const noZero = String(parseInt(p[0], 10)) + '.' + p[1];
        if (!dateShort.includes(noZero)) dateShort.push(noZero);
    }

    const teacherNeedles = teachers.map(t => String(t).toLowerCase()).filter(Boolean);
    const hasTextCriteria = !!(needle || dateShort.length || teacherNeedles.length);

    let best = null;
    let bestScore = 0;
    let bestTextScore = 0;
    // Лучшая ячейка, у которой есть именно текстовые совпадения.
    // Нужна, чтобы структурные бонусы (пара/время) не могли
    // «выиграть» у пустой ячейки без нужной дисциплины.
    let bestText = null;
    let bestTextTotal = -Infinity;

    for (const td of tds) {
        const raw = td.textContent || '';
        if (!raw) continue;
        const rawLower = raw.toLowerCase();
        const text = normalizeText(raw);

        /* Текстовая часть оценки. Отдельно от структурных бонусов:
           для кандидатов из «день + время/пара» важно понять, что
           в ячейке действительно нужная дисциплина, а не просто
           совпал номер пары. textHits — только положительные
           совпадения, без штрафа за ненайденного преподавателя. */
        let textScore = 0;
        let textHits = 0;

        if (needle && text.includes(needle)) { textScore += 8; textHits += 8; }
        else if (needleStrong && text.includes(needleStrong)) { textScore += 2; textHits += 2; }
        else if (needleWords.length) {
            // Частичное совпадение: кавычки/сокращения в ячейке могут
            // ломать точную фразу, но слова обычно остаются на месте.
            let hits = 0;
            for (const w of needleWords) if (text.includes(w)) hits++;
            if (hits >= Math.ceil(needleWords.length * 0.6)) { textScore += 3; textHits += 3; }
        }

        if (dateShort.length) {
            let hit = 0;
            for (const d of dateShort) if (rawLower.includes(d)) hit++;
            if (hit) {
                const dScore = (hit / dateShort.length) * 4;
                textScore += dScore;
                textHits += dScore;
            }
        }
        if (teacherNeedles.length) {
            let tHit = false;
            for (const t of teacherNeedles) {
                // Извлекаем фамилию (первое слово без точек и титулов)
                const parts = t.split(' ').filter(p => !p.includes('.') && !p.includes('доц') && !p.includes('преп') && !p.includes('проф'));
                const surname = normalizeText(parts.length ? parts[0] : t);

                if (surname && text.includes(surname)) {
                    tHit = true;
                    textScore += 10; // Даем огромный приоритет, если совпал преподаватель
                    textHits += 10;
                    break;
                }
            }
            // Если искали преподавателя, но не нашли — штрафуем ячейку,
            // но в textHits не учитываем: дисциплина всё равно может
            // быть правильной (в объединённой ячейке преподаватель
            // может быть указан отдельно).
            if (!tHit) textScore -= 10;
        }

        let score = textScore;

        // Совпадение номера пары (решает проблему соседних ячеек)
        if (pairNumber != null) {
            const rowPair = getRowPair(td);
            if (rowPair) {
                score += rowPair === normalizePair(pairNumber) ? 6 : -6;
            }
        }

        // Совпадение времени начала — самый точный структурный признак.
        if (timeStart) {
            const rowTime = getRowTime(td);
            if (rowTime && rowTime === timeStart) score += 30;
        }

        if (score > bestScore) {
            bestScore = score;
            bestTextScore = textScore;
            best = td;
        }

        if (textHits > 0 && score > bestTextTotal) {
            bestTextTotal = score;
            bestText = td;
        }
    }

    if (window.PSPU_DEBUG_FIND_CELL) {
        console.debug('[findByTextScore]', {
            discipline,
            dates: dateShort,
            teachers: teacherNeedles,
            candidates: tds.length,
            bestScore,
            bestTextScore,
            bestText: best ? (best.textContent || '').slice(0, 80) : null,
            pairNumber: o.pairNumber,
            timeStart,
        });

        // Детальный дамп по всем td
        const dump = tds.map(td => {
            return {
                text: (td.textContent || '').slice(0, 60),
                rowTime: getRowTime(td),
                rowPair: getRowPair(td),
            };
        });
        console.table(dump);
    }

    if (requireText) return bestText;
    if (hasTextCriteria) return bestText;
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
 * Нативные координаты ячейки внутри iframe viewport'а.
 * Обходим цепочку offsetParent'ов: td → tr → tbody → table → …
 * Это НЕ зависит от transform: scale на iframe — offsetTop/Left
 * всегда в нативных пикселях layout'а.
 */
function nativeOffsetInFrame(cell, frameDoc) {
    let x = 0, y = 0;
    let node = cell;
    const body = frameDoc.body || frameDoc.documentElement;

    while (node && node !== body && node !== frameDoc.documentElement) {
        x += node.offsetLeft || 0;
        y += node.offsetTop  || 0;
        node = node.offsetParent;
        if (!node) break;
    }
    return { x, y };
}

/**
 * Подсвечивает ячейку и плавно скроллит к ней РОДИТЕЛЬСКИЙ wrap.
 *
 * Координаты ячейки берём через offsetLeft/offsetTop — это нативные
 * пиксели внутри iframe. Позицию iframe в родителе — через
 * getBoundingClientRect (уже с учётом transform родителя). Масштаб
 * применяем один раз: native * zoom. Раньше использовался
 * cell.getBoundingClientRect(), и он вёл себя по-разному между
 * браузерами: возвращал то натив, то post-transform. Отсюда «оффсет»
 * на ПК и «улёт в угол» на телефоне.
 */
export function focusCellInFrame(wrapEl, iframe, cell, zoom) {
    if (!wrapEl || !iframe || !cell) return;

    requestAnimationFrame(() => {
        const wrapRect   = wrapEl.getBoundingClientRect();
        const iframeRect = iframe.getBoundingClientRect();
        const frameDoc   = iframe.contentDocument || iframe.ownerDocument;
        const scale      = zoom || 1;

        const nat = nativeOffsetInFrame(cell, frameDoc);
        const natW = cell.offsetWidth  || 0;
        const natH = cell.offsetHeight || 0;

        // Визуальные координаты верхнего левого угла ячейки
        // в родительском viewport'е. native * scale — единственное
        // место, где применяется zoom.
        const cellVisualLeft = iframeRect.left + nat.x * scale;
        const cellVisualTop  = iframeRect.top  + nat.y * scale;
        const cellVisualW    = natW * scale;
        const cellVisualH    = natH * scale;

        // Центр ячейки в родительском viewport'е.
        const cellCenterX = cellVisualLeft + cellVisualW / 2;
        const cellCenterY = cellVisualTop  + cellVisualH / 2;

        // Смещение центра ячейки от левого/верхнего края wrap'а
        // (в визуальных пикселях — они же пиксели stage).
        const dx = cellCenterX - wrapRect.left;
        const dy = cellCenterY - wrapRect.top;

        const targetScrollX = wrapEl.scrollLeft + dx - wrapRect.width  / 2;
        const targetScrollY = wrapEl.scrollTop  + dy - wrapRect.height / 2;

        wrapEl.scrollTo({
            left: Math.max(0, targetScrollX),
            top:  Math.max(0, targetScrollY),
            behavior: 'smooth',
        });
    });

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

    /* Благодаря pointer-events: none на iframe тачи идут сразу
       на wrap. Никаких contentDocument-костылей, никаких
       пересылок координат — всё в системе родителя. */

    let pinching = false;
    let startDist = 0;
    let startScale = 1;
    let anchorX = 0, anchorY = 0;      // середина жеста, в системе wrap'а
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
        startDist  = dist(e.touches[0], e.touches[1]);
        startScale = getZoom();

        const r = wrapEl.getBoundingClientRect();
        const t1 = e.touches[0], t2 = e.touches[1];
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

        // Формула anchor'а: точка контента под пальцами остаётся на месте.
        //   native_x = (anchor + scroll) / scale
        //   newScroll = native_x * newScale - anchor
        //             = (anchor + scroll) * (newScale/scale) - anchor
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

                // 1) setZoom меняет stage.width/height и transform iframe.
                setZoom(pendingZoom);

                // 2) Форсируем reflow, чтобы браузер пересчитал scrollWidth
                //    wrap'а под новый размер stage. Без этого scrollLeft
                //    обрезается по старым границам — и anchor «уезжает».
                void wrapEl.scrollWidth;

                // 3) Применяем скролл в этом же кадре.
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

    // Слушаем на wrap. Одно-пальцевый скролл не перехватываем —
    // его делает сам wrap (overflow: auto + touch-action).
    wrapEl.addEventListener('touchstart', onTouchStart, { passive: true });
    wrapEl.addEventListener('touchmove',  onTouchMove,  { passive: false });
    wrapEl.addEventListener('touchend',    onTouchEnd,   { passive: true });
    wrapEl.addEventListener('touchcancel', onTouchEnd,   { passive: true });

    // iOS-only: глушим page-zoom.
    wrapEl.addEventListener('gesturestart',  onGesture, { passive: false });
    wrapEl.addEventListener('gesturechange', onGesture, { passive: false });
    wrapEl.addEventListener('gestureend',    onGesture, { passive: false });

    return () => {
        wrapEl.removeEventListener('touchstart', onTouchStart);
        wrapEl.removeEventListener('touchmove',  onTouchMove);
        wrapEl.removeEventListener('touchend',   onTouchEnd);
        wrapEl.removeEventListener('touchcancel', onTouchEnd);
        wrapEl.removeEventListener('gesturestart',  onGesture);
        wrapEl.removeEventListener('gesturechange', onGesture);
        wrapEl.removeEventListener('gestureend',    onGesture);
    };
}