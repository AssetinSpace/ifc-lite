/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One definition of "this is a small screen", shared by everything that
 * needs it before React is running (`UI_DEFAULTS`) and while it runs
 * (`ViewerLayout`'s resize listener, which owns `uiSlice.isMobile`).
 *
 * It was duplicated inside `ViewerLayout` alone for as long as only the
 * layout cared; the ribbon now needs the same answer at store-seed time,
 * and two copies of a breakpoint drift the day one of them is tuned.
 */

/** Below this CSS width the viewer is mobile whatever the input device. */
export const MOBILE_MAX_WIDTH = 768;

/**
 * Touch devices count as mobile up to here — a tablet in portrait, an iPad
 * in Split View, or a phone in landscape all sit above `MOBILE_MAX_WIDTH`
 * while still being driven by a thumb.
 */
export const TOUCH_MOBILE_MAX_WIDTH = 1024;

/** Pure predicate — the only place the two breakpoints are compared. */
export function isMobileViewport(width: number, hasTouch: boolean): boolean {
  return width < MOBILE_MAX_WIDTH || (hasTouch && width < TOUCH_MOBILE_MAX_WIDTH);
}

/** True when the browser reports any touch input. */
export function hasTouchInput(): boolean {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || (globalThis.navigator?.maxTouchPoints ?? 0) > 0;
}

/** Read the live viewport. SSR/Node (no `window.innerWidth`) reads desktop. */
export function readIsMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.innerWidth !== 'number') return false;
  return isMobileViewport(window.innerWidth, hasTouchInput());
}
