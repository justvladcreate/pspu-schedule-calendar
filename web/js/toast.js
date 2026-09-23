'use strict';

let toastTimer = null;

export function showToast(message, duration = 2200) {
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