'use strict';

export function loadSetFromStorage(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set();
    }
}

export function saveSetToStorage(key, set) {
    try {
        localStorage.setItem(key, JSON.stringify([...set]));
    } catch {}
}

export const state = {
    allEvents: [],
    filteredEvents: [],
    groups: [],
    teachers: [],
    selectedGroups: loadSetFromStorage('schedule-selected-groups'),
    selectedTeachers: loadSetFromStorage('schedule-selected-teachers'),
    currentDate: new Date(),
    view: localStorage.getItem('schedule-view') || 'week',
    theme: localStorage.getItem('schedule-theme') || 'dark',
    viewingOld: false,
    currentData: null,
    displayedIso: null,
};