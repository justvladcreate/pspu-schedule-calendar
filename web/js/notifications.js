'use strict';

import { state } from './state.js';
import { PUSH_API_BASE, PUSH_VAPID_PUBLIC_KEY } from './config.js';
import { showToast } from './toast.js';

const ENABLED_KEY = 'schedule-push-enabled';
const PREFS_KEY = 'schedule-push-prefs';
const PROMPT_KEY = 'schedule-push-prompt-at';
const PROMPT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

let initialized = false;
let enabled = loadEnabled();
let prefs = loadPrefs();
let currentSubscription = null;

let ui = null;
let draftAll = false;
let draftGroups = new Set();
let draftTeachers = new Set();

/* ============================================================
 *  БАЗОВЫЕ ПРОВЕРКИ / ХРАНИЛИЩЕ
 * ============================================================ */

export function isPushSupported() {
    return (
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window
    );
}

export function isPushConfigured() {
    return !!(PUSH_API_BASE && PUSH_VAPID_PUBLIC_KEY);
}

function isIos() {
    return (
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
}

function isStandalone() {
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        navigator.standalone === true
    );
}

function loadEnabled() {
    try {
        return localStorage.getItem(ENABLED_KEY) === '1';
    } catch {
        return false;
    }
}

function saveEnabled() {
    try {
        if (enabled) localStorage.setItem(ENABLED_KEY, '1');
        else localStorage.removeItem(ENABLED_KEY);
    } catch {}
}

function normalizePrefs(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const groups = Array.isArray(raw.groups)
        ? raw.groups.filter((x) => typeof x === 'string')
        : [];
    const teachers = Array.isArray(raw.teachers)
        ? raw.teachers.filter((x) => typeof x === 'string')
        : [];

    return {
        all: !!raw.all,
        groups: [...new Set(groups)],
        teachers: [...new Set(teachers)],
    };
}

function loadPrefs() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return null;
        return normalizePrefs(JSON.parse(raw));
    } catch {
        return null;
    }
}

function savePrefsLocal() {
    try {
        if (prefs) localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        else localStorage.removeItem(PREFS_KEY);
    } catch {}
}

function defaultPrefs() {
    const groups = [...(state.favoritesGroups || [])];
    const teachers = [...(state.favoritesTeachers || [])];

    if (groups.length || teachers.length) {
        return { all: false, groups, teachers };
    }

    return { all: true, groups: [], teachers: [] };
}

function ensurePrefs() {
    if (!prefs) {
        prefs = defaultPrefs();
        savePrefsLocal();
    }
    return prefs;
}

function notifyChange() {
    document.dispatchEvent(new CustomEvent('pushstatechange'));
}

/* ============================================================
 *  ВЗАИМОДЕЙСТВИЕ С PUSH-СЕРВИСОМ
 * ============================================================ */

function urlBase64ToUint8Array(value) {
    const normalized = String(value).trim();
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const base64 = (normalized + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);

    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);

    return out;
}

function withTimeout(promise, ms = 12000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error('timeout')), ms);
        }),
    ]);
}

async function workerRequest(path, payload) {
    const base = String(PUSH_API_BASE).trim().replace(/\/+$/, '');
    const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    let data = null;
    try {
        data = await response.json();
    } catch {}

    if (!response.ok) {
        const error = new Error(data?.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }

    return data;
}

async function getRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    try {
        return await withTimeout(navigator.serviceWorker.ready, 12000);
    } catch {
        return null;
    }
}

async function getSubscription() {
    const registration = await getRegistration();
    if (!registration) return null;
    try {
        return await registration.pushManager.getSubscription();
    } catch {
        return null;
    }
}

async function ensureSubscription() {
    const registration = await getRegistration();
    if (!registration) throw new Error('no_service_worker');

    const existing = await registration.pushManager.getSubscription();
    if (existing) {
        currentSubscription = existing;
        return existing;
    }

    const options = {
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(PUSH_VAPID_PUBLIC_KEY),
    };

    try {
        const subscription = await registration.pushManager.subscribe(options);
        currentSubscription = subscription;
        return subscription;
    } catch (error) {
        // Возможно, осталась подписка со старым VAPID-ключом.
        const stale = await registration.pushManager.getSubscription();
        if (!stale) throw error;

        try {
            await stale.unsubscribe();
        } catch {}

        const subscription = await registration.pushManager.subscribe(options);
        currentSubscription = subscription;
        return subscription;
    }
}

async function syncSubscription(subscription = null) {
    const sub = subscription || (await getSubscription());
    if (!sub) throw new Error('no_subscription');

    ensurePrefs();

    await workerRequest('/subscribe', {
        subscription: sub.toJSON(),
        prefs: {
            all: !!prefs.all,
            groups: prefs.groups,
            teachers: prefs.teachers,
        },
    });

    currentSubscription = sub;
}

/* ============================================================
 *  ПУБЛИЧНОЕ СОСТОЯНИЕ
 * ============================================================ */

export function getPushState() {
    const supported = isPushSupported();
    const configured = isPushConfigured();
    const permission = 'Notification' in window
        ? Notification.permission
        : 'unsupported';

    const iosNeedsInstall = isIos() && !isStandalone();

    let hint = '';
    if (!configured) {
        hint = 'Сервер уведомлений ещё не настроен.';
    } else if (!supported) {
        hint = iosNeedsInstall
            ? 'На iPhone уведомления работают только после добавления сайта на экран «Домой».'
            : 'Этот браузер не поддерживает push-уведомления.';
    } else if (iosNeedsInstall) {
        hint = 'На iPhone сначала добавьте сайт на экран «Домой» — иначе браузер не покажет уведомления.';
    } else if (permission === 'denied') {
        hint = 'Уведомления заблокированы в настройках браузера. Разрешите их для этого сайта.';
    } else if (!enabled) {
        hint = 'Включите уведомления, чтобы узнавать об изменениях расписания.';
    } else {
        hint = 'Уведомления приходят, даже когда сайт закрыт.';
    }

    return {
        supported,
        configured,
        enabled: enabled && supported && configured && permission === 'granted',
        permission,
        prefs: ensurePrefs(),
        hint,
        iosNeedsInstall,
    };
}

/* ============================================================
 *  ВКЛЮЧЕНИЕ / ВЫКЛЮЧЕНИЕ
 * ============================================================ */

export async function enablePush() {
    if (!isPushConfigured()) return { ok: false, error: 'not_configured' };
    if (!isPushSupported()) {
        return { ok: false, error: isIos() && !isStandalone() ? 'ios_install' : 'unsupported' };
    }
    if (Notification.permission === 'denied') {
        return { ok: false, error: 'denied' };
    }

    let permission = Notification.permission;
    if (permission === 'default') {
        try {
            permission = await Notification.requestPermission();
        } catch {
            return { ok: false, error: 'dismissed' };
        }
    }
    if (permission !== 'granted') {
        return { ok: false, error: permission === 'denied' ? 'denied' : 'dismissed' };
    }

    try {
        const subscription = await ensureSubscription();
        ensurePrefs();
        await syncSubscription(subscription);

        enabled = true;
        saveEnabled();
        notifyChange();

        return { ok: true };
    } catch (error) {
        console.warn('[push] enable failed:', error);
        return { ok: false, error: error.message || 'failed' };
    }
}

export async function disablePush() {
    enabled = false;
    saveEnabled();
    notifyChange();

    try {
        const subscription = await getSubscription();
        if (!subscription) return;

        try {
            await workerRequest('/unsubscribe', { endpoint: subscription.endpoint });
        } catch (error) {
            console.warn('[push] unsubscribe on server failed:', error);
        }

        try {
            await subscription.unsubscribe();
        } catch {}
    } catch (error) {
        console.warn('[push] disable failed:', error);
    } finally {
        currentSubscription = null;
        notifyChange();
    }
}

export async function sendTestNotification() {
    if (!enabled) return { ok: false, error: 'disabled' };

    const subscription = currentSubscription || (await getSubscription());
    if (!subscription) return { ok: false, error: 'no_subscription' };

    try {
        await workerRequest('/test', { endpoint: subscription.endpoint });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message || 'failed' };
    }
}

export async function updatePushPrefs(nextPrefs) {
    prefs = normalizePrefs(nextPrefs);
    savePrefsLocal();
    notifyChange();

    if (!enabled) return { ok: true };

    try {
        await syncSubscription();
        return { ok: true };
    } catch (error) {
        console.warn('[push] prefs sync failed:', error);
        return { ok: false, error: error.message || 'failed' };
    }
}

/* ============================================================
 *  МОДАЛКА НАСТРОЙКИ УВЕДОМЛЕНИЙ
 * ============================================================ */

function renderOptions(container, values, selected) {
    container.innerHTML = '';

    if (!values.length) {
        const empty = document.createElement('div');
        empty.className = 'filter-option-empty';
        empty.textContent = 'Не найдено';
        container.appendChild(empty);
        return;
    }

    for (const value of values) {
        const row = document.createElement('label');
        row.className = 'filter-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selected.has(value);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) selected.add(value);
            else selected.delete(value);
            updatePrefsCounter();
        });

        const text = document.createElement('span');
        text.className = 'filter-option-value';
        text.textContent = value;

        row.appendChild(checkbox);
        row.appendChild(text);
        container.appendChild(row);
    }
}

function renderPrefsLists(query = '') {
    if (!ui) return;

    const q = query.trim().toLowerCase();
    const groups = state.groups.filter((g) => !q || g.toLowerCase().includes(q));
    const teachers = state.teachers.filter((t) => !q || t.toLowerCase().includes(q));

    renderOptions(ui.groupsList, groups, draftGroups);
    renderOptions(ui.teachersList, teachers, draftTeachers);
}

function updatePrefsCounter() {
    if (!ui) return;

    let text;
    if (draftAll) {
        text = 'Все изменения расписания';
    } else {
        const g = draftGroups.size;
        const t = draftTeachers.size;
        if (g === 0 && t === 0) {
            text = 'Ничего не выбрано — уведомлений не будет';
        } else {
            const parts = [];
            if (g) parts.push(`групп: ${g}`);
            if (t) parts.push(`преподавателей: ${t}`);
            text = `Выбрано — ${parts.join(', ')}`;
        }
    }

    ui.counter.textContent = text;

    const disabled = draftAll;
    ui.columns.classList.toggle('is-disabled', disabled);
    ui.search.disabled = disabled;
}

function openPrefs() {
    if (!ui) return;

    ensurePrefs();
    draftAll = !!prefs.all;
    draftGroups = new Set(prefs.groups);
    draftTeachers = new Set(prefs.teachers);

    ui.all.checked = draftAll;
    ui.search.value = '';
    renderPrefsLists('');
    updatePrefsCounter();

    ui.modal.classList.add('open');
}

function closePrefs() {
    if (!ui) return;
    ui.modal.classList.remove('open');
}

async function saveAndClosePrefs() {
    const next = {
        all: draftAll,
        groups: [...draftGroups],
        teachers: [...draftTeachers],
    };

    const result = await updatePushPrefs(next);
    closePrefs();

    if (!result.ok) {
        showToast('Не удалось сохранить настройки — проверьте интернет');
    }
}

/* ============================================================
 *  ПРЕДЛОЖЕНИЕ ВКЛЮЧИТЬ УВЕДОМЛЕНИЯ
 * ============================================================ */

function maybePromptPush() {
    if (!isPushConfigured() || !isPushSupported()) return;
    if (!('Notification' in window) || Notification.permission !== 'default') return;

    let lastPrompt = 0;
    try {
        lastPrompt = Number(localStorage.getItem(PROMPT_KEY)) || 0;
    } catch {}

    if (Date.now() - lastPrompt < PROMPT_INTERVAL_MS) return;

    setTimeout(() => {
        // Пользователь мог уже включить/заблокировать уведомления.
        if (Notification.permission !== 'default') return;

        try {
            localStorage.setItem(PROMPT_KEY, String(Date.now()));
        } catch {}

        showToast('Включить уведомления об изменениях расписания?', {
            duration: 15000,
            action: {
                label: 'Включить',
                onClick: async () => {
                    const result = await enablePush();
                    showToast(
                        result.ok
                            ? 'Уведомления включены'
                            : 'Не удалось включить уведомления',
                    );
                },
            },
        });
    }, 7000);
}

/* ============================================================
 *  ИНИЦИАЛИЗАЦИЯ
 * ============================================================ */

export function setupNotifications() {
    if (initialized) {
        return { openPrefs, closePrefs, sendTestNotification, getState: getPushState };
    }

    const modal = document.getElementById('pushModal');
    if (modal) {
        ui = {
            modal,
            closeBtn: modal.querySelector('.push-close'),
            all: document.getElementById('pushAll'),
            search: document.getElementById('pushSearch'),
            groupsList: document.getElementById('pushGroupsList'),
            teachersList: document.getElementById('pushTeachersList'),
            columns: document.getElementById('pushColumns'),
            counter: document.getElementById('pushCounter'),
            doneBtn: document.getElementById('pushDone'),
            testBtn: document.getElementById('pushTestBtn'),
        };

        if (ui.closeBtn) ui.closeBtn.addEventListener('click', closePrefs);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closePrefs();
        });

        if (ui.all) {
            ui.all.addEventListener('change', () => {
                draftAll = ui.all.checked;
                updatePrefsCounter();
            });
        }

        if (ui.search) {
            ui.search.addEventListener('input', () => {
                renderPrefsLists(ui.search.value);
            });
        }

        if (ui.doneBtn) {
            ui.doneBtn.addEventListener('click', saveAndClosePrefs);
        }

        if (ui.testBtn) {
            ui.testBtn.addEventListener('click', async () => {
                ui.testBtn.disabled = true;
                const oldText = ui.testBtn.textContent;
                ui.testBtn.textContent = 'Отправка…';

                const result = await sendTestNotification();

                ui.testBtn.disabled = false;
                ui.testBtn.textContent = oldText;

                if (result.ok) {
                    showToast('Тестовое уведомление отправлено');
                } else {
                    showToast('Не удалось отправить тестовое уведомление');
                }
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !modal.classList.contains('open')) return;
            // Не даём «Персонализации» закрыться вместе с этой модалкой.
            e.stopImmediatePropagation();
            closePrefs();
        });
    }

    initialized = true;

    // Восстанавливаем подписку после перезагрузки: сервер мог потерять
    // запись, а браузер — обновить endpoint.
    if (enabled) {
        setTimeout(async () => {
            if (!isPushSupported() || !isPushConfigured()) {
                enabled = false;
                saveEnabled();
                notifyChange();
                return;
            }
            if (Notification.permission !== 'granted') {
                enabled = false;
                saveEnabled();
                notifyChange();
                return;
            }

            try {
                const subscription = await ensureSubscription();
                await syncSubscription(subscription);
            } catch (error) {
                console.warn('[push] restore failed:', error);
            }
        }, 1500);
    }

    maybePromptPush();

    return { openPrefs, closePrefs, sendTestNotification, getState: getPushState };
}
