'use strict';

export const DATA_URL = 'data.json';
export const HOUR_START = 8;
export const HOUR_END = 22;
export const HOUR_HEIGHT = 60;
export const PAIR_MINUTES = 90;
export const MAX_INLINE_EVENTS = 3;

export const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const WEEKDAYS_FULL  = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const MONTHS_GEN   = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_NOM   = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export const ICS_BASE = "https://pspu-ics-worker.vladjust059.workers.dev";

/* ============================================================
 *  PUSH-УВЕДОМЛЕНИЯ
 *
 *  Заполните после деплоя cloudflare/push-worker.js:
 *    PUSH_API_BASE            — URL воркера без слэша в конце;
 *    PUSH_VAPID_PUBLIC_KEY    — публичный VAPID-ключ (base64url).
 *
 *  Пока значения пустые, уведомления в настройках отключены.
 * ============================================================ */
export const PUSH_API_BASE = "https://push-worker.vladjust059.workers.dev";
export const PUSH_VAPID_PUBLIC_KEY = "BGWze2kmriZ4U2L_wj4CBMrwsjDaEnk9JQC2_3-PF8mDKJDRQBDO7laqeJpOUc2IwqZk2kj41gdO96NToJkRhjI";