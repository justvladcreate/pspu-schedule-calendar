'use strict';

let toastTimer = null;

/**
 * Показывает всплывающий тост.
 *
 * Совместимая сигнатура:
 *   showToast('Текст')
 *   showToast('Текст', 1500)
 *
 * Расширенная:
 *   showToast('Текст', {
 *     duration: 5000,
 *     action:   { label: 'Отменить', onClick: () => {...} },
 *     closable: true,   // по умолчанию true
 *   })
 *
 * Клик по ✕ прячет тост немедленно. Крестик можно отключить,
 * передав closable: false (например, для очень коротких
 * авто-уведомлений вроде «Скопировано»).
 */
export function showToast(message, opts = 2200) {
    const el = document.getElementById('toast');
    if (!el) return;

    const options  = typeof opts === 'number' ? { duration: opts } : opts;
    const duration = typeof options.duration === 'number' ? options.duration : 2200;
    const action   = options.action || null;
    const closable = options.closable !== false;

    // Пересобираем содержимое — оно может нести кнопку действия и крестик.
    el.textContent = '';

    const textEl = document.createElement('span');
    textEl.className = 'toast-text';
    textEl.textContent = message;
    el.appendChild(textEl);

    const hideNow = () => {
        el.classList.remove('toast--visible');
        if (toastTimer) {
            clearTimeout(toastTimer);
            toastTimer = null;
        }
    };

    if (action && typeof action.onClick === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toast-action';
        btn.textContent = action.label || 'Отменить';
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            try { action.onClick(); }
            catch (e) { console.warn('[toast] action failed:', e); }
            hideNow();
        });
        el.appendChild(btn);
    }

    if (closable) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'toast-close';
        close.setAttribute('aria-label', 'Закрыть');
        close.textContent = '✕';
        close.addEventListener('click', (ev) => {
            ev.stopPropagation();
            hideNow();
        });
        el.appendChild(close);
    }

    el.classList.add('toast--visible');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.classList.remove('toast--visible');
        toastTimer = null;
    }, duration);
}