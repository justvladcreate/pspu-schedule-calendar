'use strict';

import { state } from './state.js';

function pluralRu(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

let currentApi = null;

export function hashChanges(changes) {
    const str = JSON.stringify(changes);
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return String(h);
}

/** Фильтрует изменения теми же правилами, что и applyFilters. */
export function filterChangesByFilters(changes) {
    const sg = state.selectedGroups;
    const st = state.selectedTeachers;
    if (sg.size === 0 && st.size === 0) return changes;

    return changes.filter(ch => {
        const groupOld = ch.old ? ch.old.group : '';
        const groupNew = ch.new ? ch.new.group : '';
        const group = groupNew || groupOld;

        if (sg.size > 0 && !sg.has(group)) return false;

        if (st.size > 0) {
            const tOld = (ch.old && ch.old.teachers) || [];
            const tNew = (ch.new && ch.new.teachers) || [];
            const all = tOld.concat(tNew);
            if (!all.some(x => st.has(x))) return false;
        }
        return true;
    });
}

export function getVisibleChanges() {
    return filterChangesByFilters(state.pendingChanges || []);
}

export function setupUpdateBanner({ onOpen }) {
    const banner = document.getElementById('updateBanner');
    const textEl = document.getElementById('updateBannerText');
    const closeBtn = document.getElementById('updateBannerClose');
    let currentHash = '';

    function hide() {
        banner.classList.remove('open');
    }

    function show(count, hash) {
        currentHash = hash;
        const word = pluralRu(count, 'изменение', 'изменения', 'изменений');
        textEl.textContent = `В расписании ${count} ${word}`;
        banner.classList.add('open');
    }

    function refresh() {
        const visible = getVisibleChanges();
        if (visible.length === 0) {
            hide();
            return;
        }
        const hash = hashChanges(visible);
        const dismissed = localStorage.getItem('schedule-dismissed-diff-hash');
        if (hash === dismissed) {
            hide();
            return;
        }
        show(visible.length, hash);
    }

    banner.addEventListener('click', (e) => {
        if (closeBtn.contains(e.target)) return;

        // Открыл модалку = уже видел. Помечаем хеш dismissed,
        // чтобы после reload баннер не всплывал.
        const visible = getVisibleChanges();
        if (visible.length > 0) {
            const hash = hashChanges(visible);
            try { localStorage.setItem('schedule-dismissed-diff-hash', hash); } catch {}
        }

        hide();
        onOpen();
    });

    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const visible = getVisibleChanges();
        if (visible.length > 0) {
            const hash = hashChanges(visible);
            try { localStorage.setItem('schedule-dismissed-diff-hash', hash); } catch {}
        }
        hide();
    });

    currentApi = { show, hide, refresh };
    return currentApi;
}

/** Вызывать при смене фильтров. Если баннер уже был создан — обновит его. */
export function refreshBanner() {
    if (currentApi) currentApi.refresh();
}