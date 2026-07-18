/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  compileIdentifierPattern,
  DEFAULT_IDENTIFIER_PATTERN,
  identifierKeyForSource,
  matchesIdentifierPattern,
  normalizeIdentifier,
  sanitizeIdentifierLinkConfig,
} from './config.js';

describe('normalizeIdentifier', () => {
  it('uppercases and trims', () => {
    assert.equal(normalizeIdentifier('  dd.01.02.003 '), 'DD.01.02.003');
  });

  it('collapses spaces, hyphens, dashes and underscores to dots', () => {
    assert.equal(normalizeIdentifier('DD-01-02-003'), 'DD.01.02.003');
    assert.equal(normalizeIdentifier('DD 01 02 003'), 'DD.01.02.003');
    assert.equal(normalizeIdentifier('DD–01—02_003'), 'DD.01.02.003');
    assert.equal(normalizeIdentifier('DD - 01'), 'DD.01');
  });

  it('collapses duplicate dots and strips edge dots', () => {
    assert.equal(normalizeIdentifier('.DD..01.'), 'DD.01');
  });

  it('returns empty for whitespace-only input', () => {
    assert.equal(normalizeIdentifier('   '), '');
  });
});

describe('identifierKeyForSource', () => {
  it('keeps GlobalId keys exact — case, underscores and $ survive', () => {
    assert.equal(identifierKeyForSource('globalId', ' 2O2Fr$t4X7Zf8NOew3FLKI '), '2O2Fr$t4X7Zf8NOew3FLKI');
  });

  it('normalizes every other source kind', () => {
    assert.equal(identifierKeyForSource('name', 'dd-01-02'), 'DD.01.02');
    assert.equal(identifierKeyForSource('tag', ' sn 11 '), 'SN.11');
  });
});

describe('compileIdentifierPattern', () => {
  it('accepts anchored and unanchored patterns identically', () => {
    const anchored = compileIdentifierPattern('^[A-Z]{2}\\.\\d{2}$');
    const bare = compileIdentifierPattern('[A-Z]{2}\\.\\d{2}');
    assert.ok(anchored && bare);
    for (const re of [anchored, bare]) {
      assert.ok(re.test('DD.01'));
      assert.ok(!re.test('XDD.01'), 'must be a full match, not a substring');
      assert.ok(!re.test('DD.01X'));
    }
  });

  it('returns null for an invalid regex or empty pattern', () => {
    assert.equal(compileIdentifierPattern('['), null);
    assert.equal(compileIdentifierPattern('   '), null);
  });

  it('default pattern matches the documented code shapes', () => {
    const re = compileIdentifierPattern(DEFAULT_IDENTIFIER_PATTERN);
    assert.ok(re);
    assert.ok(matchesIdentifierPattern(re, 'DD.01.02.003'));
    assert.ok(matchesIdentifierPattern(re, 'DD01.06.03'));
    assert.ok(matchesIdentifierPattern(re, 'dd-01-02-003'), 'normalization applies first');
    assert.ok(!matchesIdentifierPattern(re, '1:50'));
    assert.ok(!matchesIdentifierPattern(re, 'A1'));
    assert.ok(!matchesIdentifierPattern(re, 'WALL'));
  });
});

describe('sanitizeIdentifierLinkConfig', () => {
  it('falls back to defaults for garbage input', () => {
    const cfg = sanitizeIdentifierLinkConfig('nonsense');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.pattern, DEFAULT_IDENTIFIER_PATTERN);
    assert.deepEqual(cfg.sources, [{ kind: 'name' }]);
  });

  it('keeps valid fields and drops invalid sources', () => {
    const cfg = sanitizeIdentifierLinkConfig({
      enabled: true,
      pattern: 'ABC\\d+',
      debug: true,
      sources: [
        { kind: 'tag' },
        { kind: 'bogus' },
        { kind: 'pset', psetName: 'Pset_X', propertyName: 'Code' },
      ],
    });
    assert.equal(cfg.enabled, true);
    // v1 migration: the old single pattern described OCCURRENCE codes.
    assert.equal(cfg.occurrence.pattern, 'ABC\\d+');
    assert.equal(cfg.pattern, DEFAULT_IDENTIFIER_PATTERN);
    assert.equal(cfg.debug, true);
    assert.deepEqual(cfg.sources, [
      { kind: 'tag' },
      { kind: 'pset', psetName: 'Pset_X', propertyName: 'Code' },
    ]);
  });

  it('keeps the v2 shape (occurrence block) as-is', () => {
    const cfg = sanitizeIdentifierLinkConfig({
      enabled: true,
      pattern: '^TT\\d{2}$',
      occurrence: {
        mode: 'composed',
        pattern: '^TT\\d{2}\\.\\d{3}$',
        discriminatorSources: [{ kind: 'pset', psetName: '', propertyName: 'Mark' }],
      },
      sources: [{ kind: 'name' }],
    });
    assert.equal(cfg.pattern, '^TT\\d{2}$');
    assert.equal(cfg.occurrence.mode, 'composed');
    assert.equal(cfg.occurrence.pattern, '^TT\\d{2}\\.\\d{3}$');
    assert.deepEqual(cfg.occurrence.discriminatorSources, [
      { kind: 'pset', psetName: '', propertyName: 'Mark' },
    ]);
  });

  it('restores the default source list when every source is invalid', () => {
    const cfg = sanitizeIdentifierLinkConfig({ sources: [{ kind: 'nope' }] });
    assert.deepEqual(cfg.sources, [{ kind: 'name' }]);
  });
});
