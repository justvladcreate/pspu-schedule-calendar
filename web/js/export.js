'use strict';

import { ICS_BASE } from './config.js';
import { state } from './state.js';

export function buildIcsUrl() {
    const groups   = [...state.selectedGroups];
    const teachers = [...state.selectedTeachers];

    const isAll = (state.groups.length + state.teachers.length) > 0
        && groups.length   === state.groups.length
        && teachers.length === state.teachers.length;

    if ((groups.length === 0 && teachers.length === 0) || isAll) {
        return `${ICS_BASE}/ics`;
    }

    const enc = s => encodeURIComponent(s);
    const gPart = groups.length   ? `g/${groups.map(enc).join(",")}`   : "";
    const tPart = teachers.length ? `t/${teachers.map(enc).join(",")}` : "";

    if (gPart && tPart) return `${ICS_BASE}/${gPart}/${tPart}`;
    if (gPart)          return `${ICS_BASE}/${gPart}`;
    return `${ICS_BASE}/${tPart}`;
}

export function setupExportModal() {
    const modal    = document.getElementById('exportModal');
    const urlEl    = document.getElementById('exportUrl');
    const copyBtn  = document.getElementById('copyUrlBtn');
    const copyTxt  = copyBtn.querySelector('.export-copy-text');
    const closeBtn = modal.querySelector('.export-close');
    const openBtn  = document.getElementById('openGcalBtn');

    let currentUrl = '';
    let copyTimer  = null;

    async function tryCopy() {
        try {
            await navigator.clipboard.writeText(currentUrl);
            copyBtn.classList.add('is-copied');
            copyTxt.textContent = 'Скопировано';
            if (copyTimer) clearTimeout(copyTimer);
            copyTimer = setTimeout(() => {
                copyBtn.classList.remove('is-copied');
                copyTxt.textContent = 'Копировать';
                copyTimer = null;
            }, 2000);
            return true;
        } catch (e) {
            console.warn('Clipboard недоступен:', e);
            return false;
        }
    }

    function open() {
        currentUrl = buildIcsUrl();
        urlEl.textContent = currentUrl;
        copyBtn.classList.remove('is-copied');
        copyTxt.textContent = 'Копировать';
        modal.classList.add('open');

        tryCopy();
    }

    function close() {
        modal.classList.remove('open');
        if (copyTimer) {
            clearTimeout(copyTimer);
            copyTimer = null;
        }
    }

    copyBtn.addEventListener('click', tryCopy);
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    openBtn.addEventListener('click', () => {
        window.open(
            "https://calendar.google.com/calendar/u/0/r/settings/addbyurl",
            "_blank",
            "noopener"
        );
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });

    return { open };
}