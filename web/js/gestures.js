'use strict';

import { state, saveDayColWidth } from './state.js';
import { navigate } from './navigation.js';

export function setupCalendarGestures() {
    const calendar = document.getElementById('calendar');

    ['gesturestart', 'gesturechange', 'gestureend'].forEach(name => {
        calendar.addEventListener(name, e => e.preventDefault(), { passive: false });
    });

    let wheelLocked = false;
    calendar.addEventListener('wheel', e => {
        if (state.view !== 'month') return;
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        if (Math.abs(e.deltaY) < 4) return;

        e.preventDefault();
        if (wheelLocked) return;
        wheelLocked = true;
        navigate(e.deltaY > 0 ? 1 : -1);
        setTimeout(() => { wheelLocked = false; }, 250);
    }, { passive: false });

    const TIME_COL      = 56;
    const DEFAULT_COL   = 110;
    const MIN_COL       = () => Math.max(30, (window.innerWidth - TIME_COL) / 7);
    const MAX_COL       = DEFAULT_COL;

    const getColWidth = () => {
        const v = getComputedStyle(document.documentElement)
            .getPropertyValue('--m-day-col');
        return parseFloat(v) || DEFAULT_COL;
    };
    const setColWidth = px => {
        document.documentElement.style.setProperty('--m-day-col', px + 'px');
        saveDayColWidth(px);
    };
    const dist = (t1, t2) =>
        Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

    calendar.addEventListener('wheel', e => {
        if (state.view !== 'week') return;
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const step = e.deltaY > 0 ? -8 : 8;
        const cur  = getColWidth();
        const next = Math.max(MIN_COL(), Math.min(MAX_COL, cur + step));
        setColWidth(next);
    }, { passive: false });

    let pinchStartDist = 0;
    let pinchStartCol  = 0;

    /* ============================================================
     *  СВАЙП ДЛЯ НАВИГАЦИИ
     *
     *  Ключевые отличия от «наивной» версии:
     *    1. Ось фиксируется в touchmove, а не вычисляется из touchend.
     *       Как только палец ушёл на 12px в любую сторону — решаем,
     *       горизонтальный это жест или вертикальный, и больше не
     *       пересчитываем. Это убирает «случайные» срабатывания при
     *       вертикальном скролле.
     *    2. Время жеста ограничено: дольше 900мс — не свайп.
     *    3. |dx| должен быть в 1.5 раза больше |dy| (а не просто ≥).
     *    4. Вертикальный уход больше 80px — отмена, даже если ось «x».
     *    5. Финальная позиция берётся из последнего touchmove, а не из
     *       changedTouches (на Android changedTouches иногда фризится).
     *    6. Край недели проверяется по состоянию на TOUCHSTART, а не
     *       на TOUCHEND. Иначе «дослайдил до края и отпустил» = навигация.
     * ============================================================ */

    const SWIPE_THRESHOLD = 90;    // минимальная горизонтальная дистанция
    const SWIPE_MAX_DY    = 80;    // вертикальный «уход» — отмена
    const SWIPE_MAX_MS    = 900;   // длиннее — не свайп
    const SWIPE_LOCK_PX   = 12;    // после какого смещения фиксируем ось
    const SWIPE_RATIO     = 1.5;   // |dx| должен быть в 1.5 раза больше |dy|

    let startX = 0, startY = 0, startTime = 0;
    let lastX = 0, lastY = 0;
    let startScrollLeft = 0;
    let startScrollable = false;
    let tracking = false;
    let swipeAxis = null;          // 'x' | 'y' | null
    let startTarget = null;

    calendar.addEventListener('touchstart', e => {
        if (e.touches.length >= 2) {
            tracking = false;
            swipeAxis = null;
            if (state.view === 'week') {
                pinchStartDist = dist(e.touches[0], e.touches[1]);
                pinchStartCol  = getColWidth();
            }
            return;
        }

        startX = lastX = e.touches[0].clientX;
        startY = lastY = e.touches[0].clientY;
        startTime = performance.now();

        // Фиксируем состояние скролла В МОМЕНТ КАСАНИЯ.
        // Именно это решает проблему «доехал до края — улетел на след. неделю».
        startScrollLeft = calendar.scrollLeft;
        startScrollable = calendar.scrollWidth > calendar.clientWidth + 1;

        startTarget = e.target;
        swipeAxis = null;
        tracking = true;
    }, { passive: true });

    calendar.addEventListener('touchmove', e => {
        // pinch — как было
        if (e.touches.length === 2 && e.cancelable) {
            e.preventDefault();
        }

        if (e.touches.length === 2 && pinchStartDist && state.view === 'week') {
            const scale = dist(e.touches[0], e.touches[1]) / pinchStartDist;
            const next  = pinchStartCol * scale;
            setColWidth(Math.max(MIN_COL(), Math.min(MAX_COL, next)));
            return;
        }

        // свайп — один палец
        if (!tracking || e.touches.length !== 1) return;

        const t = e.touches[0];
        lastX = t.clientX;
        lastY = t.clientY;

        if (swipeAxis) return;   // ось уже зафиксирована — не пересчитываем

        const dx  = lastX - startX;
        const dy  = lastY - startY;
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);

        if (adx < SWIPE_LOCK_PX && ady < SWIPE_LOCK_PX) return;

        swipeAxis = adx > ady * SWIPE_RATIO ? 'x' : 'y';
    }, { passive: false });

    calendar.addEventListener('touchend', e => {
        if (e.touches.length < 2) pinchStartDist = 0;

        if (!tracking) return;
        tracking = false;

        // Ось не зафиксирована — это тап или микродвижение
        if (swipeAxis !== 'x') { swipeAxis = null; return; }
        swipeAxis = null;

        const dx = lastX - startX;
        const dy = lastY - startY;
        const dt = performance.now() - startTime;

        if (Math.abs(dx) < SWIPE_THRESHOLD) return;
        if (Math.abs(dy) > SWIPE_MAX_DY)    return;
        if (dt > SWIPE_MAX_MS)              return;

        const dir = dx < 0 ? 1 : -1;

        // Если жест стартовал внутри горизонтального скроллера в «Нагрузке» —
        // не перехватываем.
        if (startTarget) {
            const scroller = startTarget.closest(
                '.load-heatmap-scroll, .load-strip-view-bars'
            );
            if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) {
                return;
            }
        }

        if (state.view === 'week') {
            // Вид недели целиком влез в экран — любой свайп = навигация.
            if (!startScrollable) {
                navigate(dir);
                return;
            }

            // Край проверяем по состоянию НА СТАРТЕ жеста.
            // Иначе «доехал до края и отпустил» = навигация.
            const edge = 2;
            const wasAtLeft  = startScrollLeft <= edge;
            const wasAtRight = startScrollLeft + calendar.clientWidth
                               >= calendar.scrollWidth - edge;

            if (dir === -1 && wasAtLeft)  { navigate(-1); return; }
            if (dir ===  1 && wasAtRight) { navigate( 1); return; }
            return;   // доехал до края, но стартовал не с края — не листаем
        }

        navigate(dir);
    }, { passive: true });

    calendar.addEventListener('touchcancel', () => {
        pinchStartDist = 0;
        tracking = false;
        swipeAxis = null;
        startTarget = null;
    });

    window.addEventListener('resize', () => {
        if (state.view !== 'week') return;
        const cur = getColWidth();
        const clamped = Math.max(MIN_COL(), Math.min(MAX_COL, cur));
        if (Math.abs(clamped - cur) > 0.5) setColWidth(clamped);
    });
}

export function setupPullToRefresh() {
    if (!('ontouchstart' in window)) return;

    const THRESHOLD = 70;
    const MAX_PULL  = 100;

    const calendar = document.getElementById('calendar');

    const indicator = document.createElement('div');
    indicator.className = 'ptr-indicator';
    indicator.innerHTML = '<div class="ptr-spinner"></div>';
    document.body.appendChild(indicator);

    let startX = 0;
    let startY = 0;
    let currentPull = 0;
    let isPulling = false;

    const resetPull = () => {
        currentPull = 0;
        indicator.style.transform = 'translate(-50%, -70px)';
        indicator.classList.remove('ptr-ready');
    };

    calendar.addEventListener('touchstart', e => {
        if (e.touches.length > 1) {
            isPulling = false;
            resetPull();
            return;
        }
        if (calendar.scrollTop > 0) return;
        if (indicator.classList.contains('ptr-loading')) return;

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isPulling = true;
        currentPull = 0;
    }, { passive: true });

    calendar.addEventListener('touchmove', e => {
        if (!isPulling) return;

        if (e.touches.length > 1) {
            isPulling = false;
            resetPull();
            return;
        }

        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;

        if (Math.abs(dx) > Math.abs(dy)) {
            isPulling = false;
            resetPull();
            return;
        }

        if (dy <= 0) {
            resetPull();
            return;
        }

        if (calendar.scrollTop > 0) {
            isPulling = false;
            resetPull();
            return;
        }

        if (e.cancelable) e.preventDefault();

        currentPull = Math.min(MAX_PULL, dy * 0.5);
        indicator.style.transform = `translate(-50%, ${-70 + currentPull}px)`;
        indicator.classList.toggle('ptr-ready', currentPull >= THRESHOLD);
    }, { passive: false });

    const endPull = e => {
        if (!isPulling) return;
        if (e && e.touches && e.touches.length > 0) return;

        isPulling = false;

        if (currentPull >= THRESHOLD) {
            indicator.classList.add('ptr-loading');
            indicator.classList.remove('ptr-ready');
            indicator.style.transform = `translate(-50%, ${-70 + THRESHOLD}px)`;
            localStorage.setItem('schedule-cache-bust', Date.now().toString());
            setTimeout(() => location.reload(), 250);
        } else {
            resetPull();
        }
        currentPull = 0;
    };

    calendar.addEventListener('touchend', endPull);
    calendar.addEventListener('touchcancel', endPull);
}
