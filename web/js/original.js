'use strict';

/**
 * Модалка «Оригинал» — просмотр исходной Google Таблицы.
 *
 * Логика:
 *   • iframe грузится ЛЕНИВО при первом открытии;
 *   • URL берётся из <meta name="original-schedule-url"> (см. index.html);
 *   • если оффлайн — показываем заглушку с кнопкой «Открыть в новой вкладке»;
 *   • при клике на «открыть в новой вкладке» — открываем публичную ссылку в новой вкладке.
 */

const URL_META_SELECTOR = 'meta[name="original-schedule-url"]';
const EXTERNAL_META_SELECTOR = 'meta[name="original-schedule-external"]';

let iframeLoaded = false;

function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : '';
}

function isOnline() {
    return navigator.onLine !== false;
}

export function setupOriginalModal() {
    const btn      = document.getElementById('originalBtn');
    const modal    = document.getElementById('originalModal');
    const dialog   = modal && modal.querySelector('.original-modal');
    const closeBtn = modal && modal.querySelector('.original-close');
    const frame    = document.getElementById('originalFrame');
    const offline  = document.getElementById('originalOffline');
    const external = document.getElementById('originalExternal');
    const internalUrl = getMeta('original-schedule-url');
    const externalUrl = getMeta('original-schedule-external') || internalUrl;

    if (!btn || !modal || !frame) return;

    if (external) external.setAttribute('href', externalUrl);

    function open() {
        modal.classList.add('open');

        // Оффлайн — заглушка.
        if (!isOnline()) {
            if (offline) offline.hidden = false;
            frame.style.display = 'none';
            return;
        }
        if (offline) offline.hidden = true;
        frame.style.display = '';

        // Ленивая загрузка iframe.
        if (!iframeLoaded && internalUrl) {
            frame.src = internalUrl;
            iframeLoaded = true;

            // Google Таблицы не всегда шлют onload корректно
            // (некоторые внутренние редиректы его глушат).
            // Поэтому: как только iframe получил src, через небольшую
            // задержку показываем его. Спиннер не висит вечно.
            const reveal = () => dialog.classList.add('is-loaded');
            frame.addEventListener('load', reveal, { once: true });
            setTimeout(reveal, 400);
        } else if (iframeLoaded) {
            dialog.classList.add('is-loaded');
        }
    }

    function close() {
        modal.classList.remove('open');
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        open();
    });
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });
}