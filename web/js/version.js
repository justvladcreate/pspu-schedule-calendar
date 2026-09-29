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
        el.removeAttribute('title');
        return;
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
        el.textContent = '—';
        el.removeAttribute('title');
        return;
    }

    // Полный — всегда в title/aria-label (для тултипа и скринридеров).
    const full = formatRelativeTime(d);

    // Видимый — по ширине окна:
    //   > 400px → «2 дн назад»   (short)
    //   ≤ 400px → «2д»           (tiny)
    const tiny = window.innerWidth <= 400;

    const visible = tiny
        ? formatRelativeTimeTiny(d)
        : formatRelativeTimeShort(d);

    el.textContent = visible;
    el.setAttribute('title', full);
    el.setAttribute('aria-label', full);
}

/**
 * Компактный формат относительного времени для мобильного тулбара.
 *
 *   0–59 сек    → «сейчас»
 *   1–59 мин    → «5м»
 *   1–23 ч      → «3ч»
 *   1–29 дн     → «2д»
 *   1–11 мес    → «5мес»
 *   12+ мес     → «1г»
 *
 * Отличие от formatRelativeTime: без «назад» и без склонений —
 * экономит ~70–90 px, чего как раз хватает, чтобы тулбар
 * уложился в 2 строки.
 */
export function formatRelativeTimeShort(dateObj) {
    const diffMs = Date.now() - dateObj.getTime();
    if (diffMs < 0) return 'сейчас';

    const sec   = Math.floor(diffMs / 1000);
    const min   = Math.floor(sec / 60);
    const hour  = Math.floor(min / 60);
    const day   = Math.floor(hour / 24);
    const month = Math.floor(day / 30);
    const year  = Math.floor(day / 365);

    if (min < 1)     return 'сейчас';
    if (min < 60)    return `${min} мин назад`;
    if (hour < 24)   return `${hour} ч назад`;
    if (day < 30)    return `${day} дн назад`;
    if (month < 12)  return `${month} мес назад`;
    return `${year} г назад`;
}

/**
 * Сверхкороткий формат для самой тесной раскладки.
 *   5 мин → «5м»
 *   3 ч   → «3ч»
 *   2 дн  → «2д»
 *   5 мес → «5мес»
 *   1 г   → «1г»
 */
export function formatRelativeTimeTiny(dateObj) {
    const diffMs = Date.now() - dateObj.getTime();
    if (diffMs < 0) return 'сейчас';

    const sec   = Math.floor(diffMs / 1000);
    const min   = Math.floor(sec / 60);
    const hour  = Math.floor(min / 60);
    const day   = Math.floor(hour / 24);
    const month = Math.floor(day / 30);
    const year  = Math.floor(day / 365);

    if (min < 1)     return 'сейчас';
    if (min < 60)    return `${min}м`;
    if (hour < 24)   return `${hour}ч`;
    if (day < 30)    return `${day}д`;
    if (month < 12)  return `${month}мес`;
    return `${year}г`;
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
 * Клик по updatedBtn в «нормальном» режиме (онлайн + данные загружены).
 *
 * Оффлайн и fallback перехватывает online.js в capture-фазе —
 * сюда управление доходит только в норме.
 *
 * onOpen — колбэк, который открывает модалку изменений
 * (см. main.js: передаёт changesModalApi.open(getVisibleChanges())).
 */
export function setupUpdatedButton({ onOpen } = {}) {
    const btn = document.getElementById('updatedBtn');
    if (!btn) return;
    if (typeof onOpen !== 'function') return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onOpen();
    });
}