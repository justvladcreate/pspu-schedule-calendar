'use strict';

/* ============================================================
 *  История модалок для системной кнопки «назад».
 *
 *  Когда модалка получает класс .open — в историю пушится state.
 *  Когда пользователь жмёт «назад» — popstate закрывает верхнюю
 *  модалку из стека, а не уводит со страницы.
 *
 *  Программное закрытие (крестик, клик вне, Esc) тоже проходит
 *  через историю, чтобы не накапливать state'ы.
 *
 *  Работает через MutationObserver на class — так не нужно
 *  трогать код каждой модалки.
 * ============================================================ */

const OPEN_CLASS = 'open';
const stack = [];
let suppressPop = false;
let initialized = false;

export function setupModalHistory() {
    if (initialized) return;
    initialized = true;

    const backdrops = document.querySelectorAll('.modal-backdrop');
    if (backdrops.length === 0) return;

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            const el = m.target;
            if (!el.classList || !el.classList.contains('modal-backdrop')) continue;
            const inStack = stack.includes(el);
            const isOpen = el.classList.contains(OPEN_CLASS);

            if (isOpen && !inStack) {
                stack.push(el);
                history.pushState({ __modal: el.id, __depth: stack.length }, '');
            } else if (!isOpen && inStack) {
                // Программное закрытие — откатываем свой state.
                const idx = stack.indexOf(el);
                if (idx !== -1) stack.splice(idx, 1);
                suppressPop = true;
                history.back();
            }
        }
    });

    backdrops.forEach(el => {
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    });

    window.addEventListener('popstate', () => {
        if (suppressPop) {
            suppressPop = false;
            return;
        }
        const el = stack.pop();
        if (!el) return;
        el.classList.remove(OPEN_CLASS);
        // Если других открытых модалок нет — снимаем блокировку скролла.
        const anyOpen = document.querySelector('.modal-backdrop.open');
        if (!anyOpen) document.body.classList.remove('modal-open');
    });
}