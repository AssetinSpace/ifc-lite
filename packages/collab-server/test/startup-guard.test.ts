/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Regression tests for the audit 2026-07-12 finding: a deploy that forgets
// COLLAB_TOKEN_SECRET silently served a world-writable CRDT store on 0.0.0.0
// (anonymous editor default + all-interfaces default bind).

import { describe, expect, it } from 'vitest';
import { checkStartupPosture, isLoopbackHost } from '../src/startup-guard.js';

describe('isLoopbackHost', () => {
  it('classifies loopback vs network binds', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
  });
});

describe('checkStartupPosture', () => {
  it('refuses a network bind without a token secret (the forgotten-env-var deploy)', () => {
    const res = checkStartupPosture({
      host: '0.0.0.0',
      hasTokenSecret: false,
      allowAnonymous: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('COLLAB_TOKEN_SECRET');
      expect(res.error).toContain('COLLAB_ALLOW_ANONYMOUS');
    }
  });

  it('allows a network bind with a token secret (production posture)', () => {
    expect(
      checkStartupPosture({ host: '0.0.0.0', hasTokenSecret: true, allowAnonymous: false }),
    ).toEqual({ ok: true });
  });

  it('allows anonymous loopback (local dev stays frictionless)', () => {
    expect(
      checkStartupPosture({ host: '127.0.0.1', hasTokenSecret: false, allowAnonymous: false }),
    ).toEqual({ ok: true });
    expect(
      checkStartupPosture({ host: 'localhost', hasTokenSecret: false, allowAnonymous: false }),
    ).toEqual({ ok: true });
  });

  it('allows an explicit anonymous opt-in on a network bind, with a warning', () => {
    const res = checkStartupPosture({
      host: '0.0.0.0',
      hasTokenSecret: false,
      allowAnonymous: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warning).toContain('world-writable');
    }
  });
});
