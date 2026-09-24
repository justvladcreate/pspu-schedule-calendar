'use strict';

/**
 * Обновляет ТОЛЬКО относительное время в #updatedTime.
 * Префикс и aria-label — забота online.js.
 */
export function updateUpdatedLabel(iso) {
    const el = document.getElementById('updatedTime');
    if (!el) return;

    if (!iso) {
        el.textContent = '—';
        return;
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        el.textContent = '—';
        return;
    }
    el.textContent = formatRelativeTime(d);
}

export function formatRelativeTime(dateObj) {
    const diffMs = Date.now() - dateObj.getTime();
    if (diffMs < 0) return 'только что';

    const sec   = Math.floor(diffMs / 1000);
    const min   = Math.floor(sec / 60);
    const hour  = Math.floor(min / 60);
    const day   = Math.floor(hour / 24);
    const month = Math.floor(day / 30);

    if (min < 1)     return 'только что';
    if (min < 60)    return `${min} ${pluralRu(min, 'минуту', 'минуты', 'минут')} назад`;
    if (hour < 24)   return `${hour} ${pluralRu(hour, 'час', 'часа', 'часов')} назад`;
    if (day < 30)    return `${day} ${pluralRu(day, 'день', 'дня', 'дней')} назад`;
    if (month < 12)  return `${month} ${pluralRu(month, 'месяц', 'месяца', 'месяцев')} назад`;
    return 'больше года назад';
}

export function pluralRu(n, one, few, many) {
    const mod10  = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

/**
 * Клик по updatedBtn в «нормальном» режиме (онлайн, без fallback).
 *
 * Оффлайн-клик и fallback-клик перехватывает online.js в capture-фазе —
 * сюда управление не доходит.
 *
 * Пока здесь ничего нет. На фиче 7 переедет сюда открытие модалки
 * изменений (diff с прошлого визита).
 */
export function setupUpdatedButton() {
    const btn = document.getElementById('updatedBtn');
    if (!btn) return;
    // intentionally empty — placeholder для фичи 7
}