'use strict';

/**
 * Меню «Ещё» для узких экранов (≤400px).
 *
 * Видимость кнопок — задача CSS (@media ≤400px), не JS.
 * Здесь только открытие/закрытие меню и клики по пунктам.
 */

const ITEMS = [
    {
        id: 'exportIcsBtn',
        label: 'Экспорт в календарь',
        icon: `<svg class="icon" viewBox="0 0 24 24" width="18" height="18"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                   <rect x="3" y="4" width="18" height="18" rx="2"/>
                   <path d="M16 2v4M8 2v4M3 10h18"/>
                   <path d="M12 14v4M10 16h4"/>
               </svg>`,
    },
    {
        id: 'shareBtn',
        label: 'Поделиться',
        icon: `<svg class="icon" viewBox="0 0 24 24" width="18" height="18"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                   <circle cx="18" cy="5" r="3"/>
                   <circle cx="6" cy="12" r="3"/>
                   <circle cx="18" cy="19" r="3"/>
                   <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                   <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
               </svg>`,
    },
    {
        id: 'themeBtn',
        label: 'Сменить тему',
        icon: `<svg class="icon" viewBox="0 0 24 24" width="18" height="18"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                   <circle cx="12" cy="12" r="9"/>
                   <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>
               </svg>`,
    },
];

export function setupMoreMenu() {
    const trigger = document.getElementById('moreBtn');
    const menu = document.getElementById('moreMenu');
    if (!trigger || !menu) return;

    // Наполняем меню
    menu.innerHTML = '';
    for (const item of ITEMS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'more-menu-item';
        btn.setAttribute('role', 'menuitem');
        btn.dataset.target = item.id;
        btn.innerHTML = item.icon + `<span>${item.label}</span>`;
        menu.appendChild(btn);
    }

    function positionMenu() {
        const r = trigger.getBoundingClientRect();
        const m = menu.getBoundingClientRect();

        let top = r.bottom + 6;
        let right = window.innerWidth - r.right;

        if (top + m.height > window.innerHeight - 8) {
            top = Math.max(8, r.top - m.height - 6);
        }
        if (right < 8) right = 8;

        menu.style.top = top + 'px';
        menu.style.right = right + 'px';
    }

    function open() {
        menu.classList.add('open');
        positionMenu();
        trigger.setAttribute('aria-expanded', 'true');
        document.addEventListener('click', onOutsideClick, true);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', close);
    }
    function close() {
        menu.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', onOutsideClick, true);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', close);
    }
    function onOutsideClick(e) {
        if (menu.contains(e.target) || trigger.contains(e.target)) return;
        close();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.classList.contains('open')) close();
        else open();
    });

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('.more-menu-item');
        if (!item) return;
        const target = document.getElementById(item.dataset.target);
        close();
        if (target) setTimeout(() => target.click(), 0);
    });
}