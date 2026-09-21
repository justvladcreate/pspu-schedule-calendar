'use strict';

import { escapeHtml } from './utils.js';
import { renderMarkdown } from './markdown.js';

export function setupReadmeModal() {
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