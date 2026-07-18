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
      [item('Pôdorys 1.NP', 0, 300), item('1:50', 0, 260), item('2400', 0, 220), item('A1', 0, 180)],
      PATTERN,
    );
    assert.equal(boxes.length, 0);
  });

  it('matches rotated text with an axis-aligned bounding box', () => {
    // 90° CCW: baseline runs up (+y), the up direction points to -x.
    const rotated: PdfTextItemLike = {
      str: 'DD.01.02',
      transform: [0, 1, -1, 0, 10, 10],
      width: 40,
      height: 10,
    };
    const boxes = findIdentifierBoxes([rotated], PATTERN);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].code, 'DD.01.02');
    assert.deepEqual(
      { x: boxes[0].x, y: boxes[0].y, w: boxes[0].w, h: boxes[0].h },
      { x: 0, y: 10, w: 10, h: 40 },
    );
  });

  it('finds multiple codes in one item', () => {
    const boxes = findIdentifierBoxes([item('DD.01.02 SN.11.01')], PATTERN);
    assert.deepEqual(
      boxes.map((b) => b.code),
      ['DD.01.02', 'SN.11.01'],
    );
  });
});

describe('findIdentifierBoxes — per-glyph CAD output (mergeTextItems)', () => {
  it('reassembles a code emitted one glyph at a time', () => {
    // AutoCAD/Revit print drivers emit each character as its own text item.
    const glyphs = ['Z', 'V', '0', '1', '.', '0', '2'].map((ch, i) =>
      item(ch, 100 + i * 5, 200, 5, 10),
    );
    const boxes = findIdentifierBoxes(glyphs, PATTERN);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].code, 'ZV01.02');
    assert.equal(boxes[0].x, 100);
    assert.equal(boxes[0].w, 35);
  });

  it('keeps word gaps as token boundaries when merging a line', () => {
    // "DVERE" and the code on one line, separated by a word-sized gap.
    const glyphs = [
      ...['D', 'V', 'E', 'R', 'E'].map((ch, i) => item(ch, 100 + i * 5, 200, 5, 10)),
      ...['D', 'D', '0', '1', '.', '0', '2'].map((ch, i) => item(ch, 132 + i * 5, 200, 5, 10)),
    ];
    const boxes = findIdentifierBoxes(glyphs, PATTERN);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].code, 'DD01.02');
  });

  it('does not chain distinct physical lines into one band on a dense sheet', () => {
    // Regression: a bubble's number (h=9, baseline 200) and its header (h=5.5,
    // baseline 208.2, overlapping x-range) sit farther apart than the line
    // tolerance — but a dense sheet has other text at intermediate baselines.
    // Chained clustering fused them into a pseudo-token like "02.01DD01";
    // anchored clustering must keep them separate so the proximity join can
    // form the real code.
    const filler1 = item('4510', 400, 203.5, 20, 9); // unrelated dimension between the baselines
    const filler2 = item('2100', 700, 206.5, 20, 9);
    const number = item('02.01', 100, 200, 15.1, 9);
    const header: PdfTextItemLike = {
      str: 'DD01',
      transform: [1, 0, 0, 1, 103.2, 208.2],
      width: 8.9,
      height: 5.5,
    };
    const boxes = findIdentifierBoxes([number, filler1, filler2, header], PATTERN);
    assert.ok(
      boxes.some((b) => b.code === 'DD01.02.01' && b.layer === 'proximity'),
      `expected DD01.02.01, got ${JSON.stringify(boxes.map((b) => b.code))}`,
    );
  });

  it('never fuses different-font-size runs into one word', () => {
    // Same baseline band, overlapping x, but 9pt vs 5.5pt glyphs — two labels
    // crammed together must not concatenate into "02.01DD01".
    const number = item('02.01', 100, 200, 15.1, 9);
    const header: PdfTextItemLike = {
      str: 'DD01',
      transform: [1, 0, 0, 1, 103.2, 203],
      width: 8.9,
      height: 5.5,
    };
    const boxes = findIdentifierBoxes([number, header], PATTERN);
    assert.ok(!boxes.some((b) => b.code.includes('02.01DD01')), 'no fused pseudo-token');
  });

  it('does not merge glyphs across different lines', () => {
    // Same x-range, stacked lines — the bubble case: ZV01 over 02 must stay
    // two runs and join via the proximity layer, not string concatenation.
    const glyphs = [
      ...['Z', 'V', '0', '1'].map((ch, i) => item(ch, 100 + i * 5, 210, 5, 10)),
      ...['0', '2'].map((ch, i) => item(ch, 105 + i * 5, 195, 5, 10)),
    ];
    const boxes = findIdentifierBoxes(glyphs, PATTERN);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].code, 'ZV01.02');
    assert.equal(boxes[0].layer, 'proximity');
  });
});

describe('findIdentifierBoxes — proximity join (split label bubbles)', () => {
  it('joins a vertically stacked pair top→bottom', () => {
    // "DD01" printed above "02.03" in one bubble — neither matches alone.
    const boxes = findIdentifierBoxes(
      [item('DD01', 100, 210, 20, 10), item('02.03', 100, 195, 25, 10)],
      PATTERN,
    );
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].code, 'DD01.02.03');
    assert.equal(boxes[0].layer, 'proximity');
    // Union bbox spans both fragments.
    assert.deepEqual(
      { x: boxes[0].x, y: boxes[0].y, w: boxes[0].w, h: boxes[0].h },
      { x: 100, y: 195, w: 25, h: 25 },
    );
  });

  it('joins a horizontal pair left→right', () => {
    const boxes = findIdentifierBoxes(
      [item('02.03', 124, 200, 25, 10), item('DD01', 100, 200, 20, 10)],
      PATTERN,
    );
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].code, 'DD01.02.03');
  });

  it('does not join fragments beyond the proximity threshold', () => {
    const boxes = findIdentifierBoxes(
      [item('DD01', 100, 200, 20, 10), item('02.03', 300, 200, 25, 10)],
      PATTERN,
    );
    assert.equal(boxes.length, 0);
  });

  it('does not join pairs whose combination misses the pattern', () => {
    // Dimension chains next to an assembly code must stay plain text.
    const boxes = findIdentifierBoxes(
      [item('DD01', 100, 210, 20, 10), item('2400', 100, 195, 20, 10)],
      PATTERN,
    );
    assert.equal(boxes.length, 0);
  });

  it('full matches never re-join with nearby fragments', () => {
    const boxes = findIdentifierBoxes(
      [item('DD01.02', 100, 210, 35, 10), item('03', 100, 195, 10, 10)],
      PATTERN,
    );
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].layer, 'full');
    assert.equal(boxes[0].code, 'DD01.02');
  });

  it('joins a stacked pair on a rotated (/Rotate 90) page in reading order', () => {
    // Frame produced by mapTextTransformToViewport for a Rotate-90 page:
    // baseline points down the viewed page (u = (0,-1)), "up" is viewed +x.
    const W = 595;
    const rot = (x: number, y: number, str: string, width: number): PdfTextItemLike => ({
      str,
      transform: [0, -1, 1, 0, y, W - x],
      width,
      height: 10,
    });
    const boxes = findIdentifierBoxes([rot(100, 210, 'DD01', 20), rot(100, 195, '02.03', 25)], PATTERN);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].code, 'DD01.02.03', 'reading order judged in the text frame');
    assert.equal(boxes[0].layer, 'proximity');
  });

  it('joins the KNOWN model code, not a nearer dimension that also matches', () => {
    // A door bubble "DD01" over "05.03", with a "900" dimension even closer to
    // DD01. Both DD01.900 and DD01.05.03 match the pattern, but only the door
    // exists in the model — known-first pairing must keep the real code.
    const boxes = findIdentifierBoxes(
      [
        item('DD01', 100, 210, 20, 8),
        item('900', 100, 204, 15, 8), // 6pt below DD01 — nearer
        item('05.03', 100, 196, 25, 8), // 14pt below DD01 — farther
      ],
      PATTERN,
      (code) => code === 'DD01.05.03',
    );
    const joined = boxes.filter((b) => b.layer === 'proximity');
    assert.ok(
      joined.some((b) => b.code === 'DD01.05.03'),
      `expected DD01.05.03, got ${JSON.stringify(joined.map((b) => b.code))}`,
    );
    assert.ok(!joined.some((b) => b.code === 'DD01.900'), 'dimension must not steal the label');
  });

  it('without the known-code hint, falls back to nearest pattern match', () => {
    const boxes = findIdentifierBoxes(
      [item('DD01', 100, 210, 20, 8), item('05.03', 100, 196, 25, 8)],
      PATTERN,
    );
    assert.ok(boxes.some((b) => b.code === 'DD01.05.03'));
  });

  it('picks the nearest candidate when several fragments qualify', () => {
    const boxes = findIdentifierBoxes(
      [
        item('DD01', 100, 210, 20, 10),
        item('02.03', 100, 198, 25, 10),
        item('04.05', 100, 186, 25, 10),
      ],
      PATTERN,
    );
    const joined = boxes.filter((b) => b.layer === 'proximity');
    assert.equal(joined.length, 1);
    assert.equal(joined[0].code, 'DD01.02.03');
  });
});

describe('findIdentifierBoxes + resolvePageLinks — case-sensitive GlobalId keys', () => {
  const GUID_PATTERN = compileIdentifierPattern('^[0-9A-Za-z_$]{22}$')!;
  const guid = '2O2Fr$t4X7Zf8NOew3FLKI';

  it('matches a printed GUID via its exact form and resolves by exact key', () => {
    const boxes = findIdentifierBoxes([item(guid, 0, 0, 110, 10)], GUID_PATTERN);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].exactKey, guid);

    const index: IdentifierIndex = {
      byCode: new Map([[guid, [target({ expressId: 9, rawValue: guid })]]]),
      scannedEntities: 1,
      buildTimeMs: 0,
    };
    const links = resolvePageLinks(boxes, index);
    assert.equal(links[0].targets.length, 1);
    assert.equal(links[0].targets[0].expressId, 9);
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
  // Distinct lines — co-located items would (correctly) merge into one run.
  const boxes = findIdentifierBoxes(
    [item('DD.01.02.003', 100, 240), item('SN.11.01', 100, 200), item('ZZ.99.99', 100, 160)],
    PATTERN,
  );

  const byCode = (links: ReturnType<typeof resolvePageLinks>, code: string) => {
    const hit = links.find((l) => l.code === code);
    assert.ok(hit, `link ${code} present`);
    return hit;
  };

  it('resolves matched codes and leaves unknown codes targetless', () => {
    const links = resolvePageLinks(boxes, index);
    assert.equal(links.length, 3);
    assert.equal(byCode(links, 'DD.01.02.003').targets.length, 2);
    assert.equal(byCode(links, 'SN.11.01').targets.length, 1);
    assert.equal(byCode(links, 'ZZ.99.99').targets.length, 0, 'recognized but not in the model');
  });

  it('prefers same-storey candidates for duplicated codes', () => {
    const links = resolvePageLinks(boxes, index, { preferStoreyGuid: 'S2' });
    const dd = byCode(links, 'DD.01.02.003');
    assert.equal(dd.targets.length, 1);
    assert.equal(dd.targets[0].expressId, 2);
    // Single candidates stay untouched even off-storey.
    assert.equal(byCode(links, 'SN.11.01').targets.length, 1);
  });

  it('keeps all candidates when none is on the preferred storey', () => {
    const links = resolvePageLinks(boxes, index, { preferStoreyGuid: 'S9' });
    assert.equal(byCode(links, 'DD.01.02.003').targets.length, 2);
  });
});
