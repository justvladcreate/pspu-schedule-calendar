'use strict';

export function renderMarkdown(src) {
    // Нормализуем переносы строк: CRLF / CR → LF.
    // Без этого `$` в регулярках не матчится перед `\r`, и все
    // заголовки / списки / blockquotes разваливаются в один абзац.
    src = String(src).replace(/\r\n?/g, '\n');

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

        // ">" уже превращён esc() в "&gt;", поэтому ищем именно эту форму.
        const bq = line.match(/^&gt;\s?(.*)$/);
        if (bq) { flushPara(); closeList(); out.push('<blockquote>' + inline(bq[1]) + '</blockquote>'); continue; }

        if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushPara(); closeList(); out.push('<hr>'); continue; }

        para.push(inline(line));
    }
    if (inCode) out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>');
    flushPara(); closeList();
    return out.join('\n');
}