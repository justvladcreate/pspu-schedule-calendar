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
export function findCellInFrame(doc, position, searchText) {
    const tds = [...doc.querySelectorAll('td')];
    if (!tds.length) return null;

    if (position) {
        const target = parsePositionLocal(position);
        if (target) {
            // Строим карту координат по colspan/rowspan
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

                    // Также находим, если target попадает внутрь span
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
        }
    }

    if (searchText) {
        const needle = String(searchText).trim().toLowerCase();
        if (needle) {
            for (const td of tds) {
                if ((td.textContent || '').toLowerCase().includes(needle)) return td;
            }
            const firstWord = needle.split(/\s+/)[0];
            if (firstWord && firstWord.length >= 5) {
                for (const td of tds) {
                    if ((td.textContent || '').toLowerCase().includes(firstWord)) return td;
                }
            }
        }
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

        // Только визуальный отклик. В localStorage не пишем —
        // иначе 60 записей в секунду на слабом Android = фризы.
        setZoom(z);

        // scrollTo — одним rAF на кадр, а не по каждому move.
        pendingScrollX = scrollX;
        pendingScrollY = scrollY;
        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
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