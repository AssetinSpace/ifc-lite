/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  AUTOLOAD_MAX_MODELS,
  DEFAULT_MODEL_ORIGINS,
  parseAutoloadUrls,
} from './autoload.js';

const BASE = 'https://viewer.example/';
// The storage origin the AIM host federates from. Passed explicitly so these
// tests describe the rule rather than whatever the build-time env happens to be.
const ALLOWED = ['https://x'];

describe('parseAutoloadUrls', () => {
  it('parses the federated ?models= list (AIM: ASR + VZT)', () => {
    assert.deepEqual(
      parseAutoloadUrls('?models=https://x/ASR.ifc,https://x/VZT.ifc', BASE, ALLOWED),
      ['https://x/ASR.ifc', 'https://x/VZT.ifc'],
    );
  });

  it('falls back to the legacy single ?model=', () => {
    assert.deepEqual(parseAutoloadUrls('?model=https://x/a.ifc', BASE, ALLOWED), [
      'https://x/a.ifc',
    ]);
  });

  it('models wins over model; blank entries are dropped', () => {
    assert.deepEqual(
      parseAutoloadUrls('?models=https://x/a.ifc,,%20&model=https://y/b.ifc', BASE, ALLOWED),
      ['https://x/a.ifc'],
    );
    assert.deepEqual(parseAutoloadUrls('', BASE, ALLOWED), []);
  });

  it('keeps relative URLs (same-origin fetch), returned verbatim', () => {
    assert.deepEqual(parseAutoloadUrls('?model=/samples/building.ifc', BASE, ALLOWED), [
      '/samples/building.ifc',
    ]);
  });

  it('rejects non-http(s) schemes — the viewer fetches on the user\'s behalf', () => {
    assert.deepEqual(
      parseAutoloadUrls(
        '?models=javascript:alert(1),file:///etc/passwd,https://x/ok.ifc',
        BASE,
        ALLOWED,
      ),
      ['https://x/ok.ifc'],
    );
    assert.deepEqual(parseAutoloadUrls('?model=blob:https://x/123', BASE, ALLOWED), []);
    // Note: a literal comma inside a `models` entry still splits (pre-existing
    // wire-format caveat — entries must be URL-encoded by the host); the
    // resulting fragments are then subject to the same scheme gate.
    assert.deepEqual(parseAutoloadUrls('?model=data:text/plain;base64,AAAA', BASE, ALLOWED), []);
  });

  it('caps the number of autoloaded models (memory-DoS guard)', () => {
    const urls = Array.from({ length: AUTOLOAD_MAX_MODELS + 5 }, (_, i) => `https://x/${i}.ifc`);
    const out = parseAutoloadUrls(`?models=${urls.join(',')}`, BASE, ALLOWED);
    assert.equal(out.length, AUTOLOAD_MAX_MODELS);
    assert.equal(out[0], 'https://x/0.ifc');
  });

  // Upstream restricts ?model= to strictly same-origin (drive-by model
  // injection via a crafted link). We can't — the AIM host federates from
  // object storage on another origin — so the equivalent gate is
  // same-origin OR an explicit allowlist, applied to both params.
  describe('origin allowlist', () => {
    it('refuses an origin that is neither the viewer\'s nor allowlisted', () => {
      assert.deepEqual(parseAutoloadUrls('?model=https://attacker/evil.ifc', BASE, ALLOWED), []);
      assert.deepEqual(
        parseAutoloadUrls('?models=https://x/ok.ifc,https://attacker/evil.ifc', BASE, ALLOWED),
        ['https://x/ok.ifc'],
      );
    });

    it('always allows the viewer\'s own origin, absolute or relative', () => {
      assert.deepEqual(parseAutoloadUrls('?model=https://viewer.example/a.ifc', BASE, []), [
        'https://viewer.example/a.ifc',
      ]);
      assert.deepEqual(parseAutoloadUrls('?model=/a.ifc', BASE, []), ['/a.ifc']);
    });

    it('an empty allowlist degrades to upstream\'s same-origin-only rule', () => {
      assert.deepEqual(parseAutoloadUrls('?models=https://x/ASR.ifc', BASE, []), []);
    });

    it('ships a default allowlist so a stock fork deploy federates', () => {
      const origin = DEFAULT_MODEL_ORIGINS[0];
      assert.ok(origin, 'expected at least one default model origin');
      assert.deepEqual(parseAutoloadUrls(`?model=${origin}/ifc/ASR.ifc`, BASE, DEFAULT_MODEL_ORIGINS), [
        `${origin}/ifc/ASR.ifc`,
      ]);
    });
  });
});
