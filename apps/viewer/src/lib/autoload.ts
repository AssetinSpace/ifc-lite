/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parsing + validation for the `?model=` / `?models=` autoload query params
 * (ViewerLayout). Pure so it can be unit-tested: the viewer will fetch these
 * URLs on the user's behalf, so they get a basic sanity gate — http(s) only
 * (no `data:`/`blob:`/`javascript:` smuggling) and a hard count cap so a
 * crafted link can't queue dozens of multi-GB parses into one tab.
 */

/** Max models a single link may autoload; anything beyond is dropped (logged). */
export const AUTOLOAD_MAX_MODELS = 16;

/**
 * Per-model download cap for autoload fetches. Real federated IFC models run
 * to a few hundred MB; the cap only exists so a crafted `?models=` link can't
 * stream a multi-GB body into one tab and OOM it before the parser even runs.
 */
export const AUTOLOAD_MAX_MODEL_BYTES = 512 * 1024 * 1024;

/**
 * Read a fetch body enforcing `maxBytes` — rejects early on a lying or absent
 * Content-Length by counting streamed bytes. Returns a Blob for File().
 */
export async function readBodyWithCap(res: Response, maxBytes: number): Promise<Blob> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`model exceeds autoload cap (${declared} > ${maxBytes} bytes)`);
  }
  if (!res.body) {
    const blob = await res.blob();
    if (blob.size > maxBytes) {
      throw new Error(`model exceeds autoload cap (${blob.size} > ${maxBytes} bytes)`);
    }
    return blob;
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`model exceeds autoload cap (> ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return new Blob(chunks);
}

/**
 * Window event dispatched by the ViewerLayout autoload loop after EVERY
 * requested model has been attempted (loaded or failed — it always fires, so
 * listeners can't deadlock on a broken URL). The AIM bridge keys its
 * MODELS_LOADED announcement on this instead of the store's first 0→N size
 * transition: the sequential `?models=` autoload would otherwise announce
 * after the FIRST model, and a deep-link focus targeting an entity in a later
 * model (e.g. VZT in an ASR+VZT federation) would resolve to nothing.
 */
export const AUTOLOAD_COMPLETE_EVENT = 'ifc-lite:autoload-complete';

/**
 * Extract the list of model URLs to autoload from a query string.
 * `models` (comma-separated, entries URL-encoded by the host) wins over the
 * legacy single `model`. Relative URLs are allowed (same-origin fetch) —
 * they're resolved against `baseUrl` for validation only; the original
 * entry is returned untouched for the actual fetch.
 */
export function parseAutoloadUrls(search: string, baseUrl: string): string[] {
  const params = new URLSearchParams(search);
  const multi = params.get('models');
  const single = params.get('model');
  const entries = (multi ? multi.split(',') : single ? [single] : [])
    .map((u) => u.trim())
    .filter(Boolean);

  const valid = entries.filter((entry) => {
    try {
      const proto = new URL(entry, baseUrl).protocol;
      if (proto === 'http:' || proto === 'https:') return true;
      console.warn('[viewer] autoload: skipping non-http(s) model URL', entry);
      return false;
    } catch {
      console.warn('[viewer] autoload: skipping unparseable model URL', entry);
      return false;
    }
  });

  if (valid.length > AUTOLOAD_MAX_MODELS) {
    console.warn(
      `[viewer] autoload: ${valid.length} models requested, loading first ${AUTOLOAD_MAX_MODELS}`,
    );
    return valid.slice(0, AUTOLOAD_MAX_MODELS);
  }
  return valid;
}
