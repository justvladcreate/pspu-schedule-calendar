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
            let lastTr = null;

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

    // Подсветка — через inline-стиль, чтобы перебить Google CSS
    const prevOutline = cell.style.outline;
    const prevOutlineOffset = cell.style.outlineOffset;
    const prevBg = cell.style.backgroundColor;

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