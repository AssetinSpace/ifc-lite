/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { AUTOLOAD_MAX_MODELS, parseAutoloadUrls } from './autoload.js';

const BASE = 'https://viewer.example/';

describe('parseAutoloadUrls', () => {
  it('parses the federated ?models= list (AIM: ASR + VZT)', () => {
    assert.deepEqual(
      parseAutoloadUrls('?models=https://x/ASR.ifc,https://x/VZT.ifc', BASE),
      ['https://x/ASR.ifc', 'https://x/VZT.ifc'],
    );
  });

  it('falls back to the legacy single ?model=', () => {
    assert.deepEqual(parseAutoloadUrls('?model=https://x/a.ifc', BASE), ['https://x/a.ifc']);
  });

  it('models wins over model; blank entries are dropped', () => {
    assert.deepEqual(
      parseAutoloadUrls('?models=https://x/a.ifc,,%20&model=https://y/b.ifc', BASE),
      ['https://x/a.ifc'],
    );
    assert.deepEqual(parseAutoloadUrls('', BASE), []);
  });

  it('keeps relative URLs (same-origin fetch), returned verbatim', () => {
    assert.deepEqual(parseAutoloadUrls('?model=/samples/building.ifc', BASE), [
      '/samples/building.ifc',
    ]);
  });

  it('rejects non-http(s) schemes — the viewer fetches on the user\'s behalf', () => {
    assert.deepEqual(
      parseAutoloadUrls('?models=javascript:alert(1),file:///etc/passwd,https://x/ok.ifc', BASE),
      ['https://x/ok.ifc'],
    );
    assert.deepEqual(parseAutoloadUrls('?model=blob:https://x/123', BASE), []);
    // Note: a literal comma inside a `models` entry still splits (pre-existing
    // wire-format caveat — entries must be URL-encoded by the host); the
    // resulting fragments are then subject to the same scheme gate.
    assert.deepEqual(parseAutoloadUrls('?model=data:text/plain;base64,AAAA', BASE), []);
  });

  it('caps the number of autoloaded models (memory-DoS guard)', () => {
    const urls = Array.from({ length: AUTOLOAD_MAX_MODELS + 5 }, (_, i) => `https://x/${i}.ifc`);
    const out = parseAutoloadUrls(`?models=${urls.join(',')}`, BASE);
    assert.equal(out.length, AUTOLOAD_MAX_MODELS);
    assert.equal(out[0], 'https://x/0.ifc');
  });
});
