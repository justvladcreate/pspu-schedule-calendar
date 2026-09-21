'use strict';

import { state } from './state.js';
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

    const SWIPE_THRESHOLD = 60;
    let startX = 0, startY = 0, tracking = false;

    calendar.addEventListener('touchstart', e => {
        if (e.touches.length >= 2) {
            tracking = false;
            if (state.view === 'week') {
                pinchStartDist = dist(e.touches[0], e.touches[1]);
                pinchStartCol  = getColWidth();
            }
            return;
        }
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, { passive: true });

    calendar.addEventListener('touchmove', e => {
        if (e.touches.length === 2 && e.cancelable) {
            e.preventDefault();
        }

        if (e.touches.length !== 2 || !pinchStartDist) return;
        if (state.view !== 'week') return;

        const scale = dist(e.touches[0], e.touches[1]) / pinchStartDist;
        const next  = pinchStartCol * scale;
        setColWidth(Math.max(MIN_COL(), Math.min(MAX_COL, next)));
    }, { passive: false });

    calendar.addEventListener('touchend', e => {
        if (e.touches.length < 2) pinchStartDist = 0;

        if (!tracking) return;
        tracking = false;

        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;

        if (Math.abs(dx) < SWIPE_THRESHOLD) return;
        if (Math.abs(dy) > Math.abs(dx)) return;

        const dir = dx < 0 ? 1 : -1;

        if (state.view === 'week') {
            const atLeft  = calendar.scrollLeft <= 1;
            const atRight = calendar.scrollLeft + calendar.clientWidth
                            >= calendar.scrollWidth - 1;
            if (dir === -1 && atLeft)  { navigate(-1); return; }
            if (dir ===  1 && atRight) { navigate( 1); return; }
            return;
        }
        navigate(dir);
    }, { passive: true });

    calendar.addEventListener('touchcancel', () => {
        pinchStartDist = 0;
        tracking = false;
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
    const MAX_PULL = 100;

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