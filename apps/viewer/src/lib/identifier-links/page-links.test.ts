/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileIdentifierPattern } from './config.js';
import { findIdentifierBoxes, resolvePageLinks, type PdfTextItemLike } from './page-links.js';
import type { IdentifierIndex, IdentifierTarget } from './identifier-index.js';

const PATTERN = compileIdentifierPattern('^[A-Z]{2}\\.?\\d{2}(?:\\.\\d{1,3})+$')!;

function item(str: string, x = 100, y = 200, width = str.length * 5, height = 10): PdfTextItemLike {
  return { str, transform: [1, 0, 0, 1, x, y], width, height };
}

function target(overrides: Partial<IdentifierTarget> = {}): IdentifierTarget {
  return {
    modelId: 'm1',
    expressId: 1,
    guid: 'G',
    name: 'Wall',
    typeName: 'IfcWall',
    storeyGuid: 'S1',
    sourceKind: 'name',
    rawValue: 'DD.01.02.003',
    ...overrides,
  };
}

describe('findIdentifierBoxes', () => {
  it('finds a full-token code and positions its box proportionally', () => {
    const boxes = findIdentifierBoxes([item('DD.01.02.003', 100, 200, 60, 10)], PATTERN);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].code, 'DD.01.02.003');
    assert.equal(boxes[0].x, 100);
    assert.equal(boxes[0].y, 200);
    assert.equal(boxes[0].w, 60);
    assert.equal(boxes[0].h, 10);
  });

  it('finds a code embedded after other words with a shifted sub-box', () => {
    // "Miestnost DD.01.02" — 18 chars, per-char = 90/18 = 5.
    const boxes = findIdentifierBoxes([item('Miestnost DD.01.02', 0, 0, 90, 10)], PATTERN);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].code, 'DD.01.02');
    assert.equal(boxes[0].x, 50, 'starts after "Miestnost " (10 chars × 5)');
    assert.equal(boxes[0].w, 40, '8 code chars × 5');
  });

  it('trims clinging punctuation before matching', () => {
    const boxes = findIdentifierBoxes([item('(DD.01.02):', 0, 0, 55, 10)], PATTERN);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].raw, 'DD.01.02');
    assert.equal(boxes[0].x, 5, 'leading "(" excluded from the box');
  });

  it('normalizes separator variants into the same code', () => {
    const boxes = findIdentifierBoxes([item('DD-01-02-003')], PATTERN);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].code, 'DD.01.02.003');
  });

  it('ignores plain text, dimensions and scales', () => {
    const boxes = findIdentifierBoxes(
      [item('Pôdorys 1.NP'), item('1:50'), item('2400'), item('A1')],
      PATTERN,
    );
    assert.equal(boxes.length, 0);
  });

  it('skips rotated text runs', () => {
    const rotated: PdfTextItemLike = {
      str: 'DD.01.02',
      transform: [0, 1, -1, 0, 10, 10],
      width: 40,
      height: 10,
    };
    assert.equal(findIdentifierBoxes([rotated], PATTERN).length, 0);
  });

  it('finds multiple codes in one item', () => {
    const boxes = findIdentifierBoxes([item('DD.01.02 SN.11.01')], PATTERN);
    assert.deepEqual(
      boxes.map((b) => b.code),
      ['DD.01.02', 'SN.11.01'],
    );
  });
});

describe('resolvePageLinks', () => {
  const index: IdentifierIndex = {
    byCode: new Map([
      ['DD.01.02.003', [target({ expressId: 1, storeyGuid: 'S1' }), target({ expressId: 2, storeyGuid: 'S2' })]],
      ['SN.11.01', [target({ expressId: 3, storeyGuid: 'S2' })]],
    ]),
    scannedEntities: 3,
    buildTimeMs: 0,
  };
  const boxes = findIdentifierBoxes(
    [item('DD.01.02.003'), item('SN.11.01'), item('ZZ.99.99')],
    PATTERN,
  );

  it('resolves matched codes and leaves unknown codes targetless', () => {
    const links = resolvePageLinks(boxes, index);
    assert.equal(links.length, 3);
    assert.equal(links[0].targets.length, 2);
    assert.equal(links[1].targets.length, 1);
    assert.equal(links[2].targets.length, 0, 'recognized but not in the model');
  });

  it('prefers same-storey candidates for duplicated codes', () => {
    const links = resolvePageLinks(boxes, index, { preferStoreyGuid: 'S2' });
    assert.equal(links[0].targets.length, 1);
    assert.equal(links[0].targets[0].expressId, 2);
    // Single candidates stay untouched even off-storey.
    assert.equal(links[1].targets.length, 1);
  });

  it('keeps all candidates when none is on the preferred storey', () => {
    const links = resolvePageLinks(boxes, index, { preferStoreyGuid: 'S9' });
    assert.equal(links[0].targets.length, 2);
  });
});
