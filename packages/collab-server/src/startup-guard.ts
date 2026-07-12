/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Startup posture check for the reference CLI (`bin.ts`).
 *
 * Without `COLLAB_TOKEN_SECRET` the server runs the library's dev default —
 * `allowAnonymousEditor` (everyone can write) — while the bin's default bind
 * is `0.0.0.0` (hosts like Railway/Fly require it). Those two defaults
 * compose into a silently world-writable CRDT store when a deploy forgets
 * the one env var: room poisoning plus disk-fill via 100 MB blob PUTs.
 *
 * Policy: anonymous mode on a non-loopback bind refuses to start unless the
 * operator opts in explicitly with `COLLAB_ALLOW_ANONYMOUS=1`. Loopback stays
 * frictionless for local dev. Library embedders are unaffected — this guard
 * lives in the CLI, not in `startCollabServer`.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when the bind address only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

export type StartupPosture =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

export function checkStartupPosture(opts: {
  host: string;
  hasTokenSecret: boolean;
  allowAnonymous: boolean;
}): StartupPosture {
  const { host, hasTokenSecret, allowAnonymous } = opts;
  if (hasTokenSecret || isLoopbackHost(host)) {
    return { ok: true };
  }
  if (allowAnonymous) {
    return {
      ok: true,
      warning:
        `COLLAB_ALLOW_ANONYMOUS=1 on ${host}: every client is an anonymous editor — ` +
        'rooms and blobs are world-writable. Use only on a trusted network.',
    };
  }
  return {
    ok: false,
    error:
      `Refusing to bind ${host} without access control: no COLLAB_TOKEN_SECRET is set, ` +
      'so every client would be an anonymous editor (world-writable rooms + blob storage). ' +
      'Set COLLAB_TOKEN_SECRET to enable signed room tokens, bind a loopback host ' +
      '(COLLAB_HOST=127.0.0.1), or opt in explicitly with COLLAB_ALLOW_ANONYMOUS=1.',
  };
}
