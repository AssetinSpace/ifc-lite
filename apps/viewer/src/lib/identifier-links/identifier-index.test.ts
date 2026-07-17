/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { DEFAULT_IDENTIFIER_LINK_CONFIG, type IdentifierLinkConfig } from './config.js';
import { buildIdentifierIndex, lookupIdentifier } from './identifier-index.js';

function makeModel(id: string, entities: Array<{ expressId: number; type: string; globalId?: string; name?: string }>) {
  return {
    id,
    ifcDataStore: createSyntheticDataStore({
      schemaVersion: 'IFC4',
      fileSize: 0,
      entities,
    }),
  };
}

const CONFIG: IdentifierLinkConfig = {
  ...DEFAULT_IDENTIFIER_LINK_CONFIG,
  enabled: true,
  sources: [{ kind: 'name' }],
  pattern: '^[A-Z]{2}\\.\\d{2}(?:\\.\\d{2,3})*$',
};

describe('buildIdentifierIndex', () => {
  it('indexes pattern-matching names case-insensitively and skips the rest', async () => {
    const model = makeModel('m1', [
      { expressId: 1, type: 'IfcWall', globalId: 'GUID-1', name: 'dd.01.02' },
      { expressId: 2, type: 'IfcDoor', globalId: 'GUID-2', name: 'Standard door' },
      { expressId: 3, type: 'IfcSpace', globalId: 'GUID-3', name: 'SN.11' },
    ]);
    const index = await buildIdentifierIndex([model], CONFIG);

    assert.equal(index.byCode.size, 2);
    const dd = index.byCode.get('DD.01.02');
    assert.ok(dd && dd.length === 1);
    assert.equal(dd[0].expressId, 1);
    assert.equal(dd[0].guid, 'GUID-1');
    assert.equal(dd[0].modelId, 'm1');
    assert.equal(dd[0].sourceKind, 'name');
    assert.equal(dd[0].rawValue, 'dd.01.02');
    assert.ok(index.byCode.get('SN.11'));
  });

  it('keeps every duplicate carrier of the same code', async () => {
    const model = makeModel('m1', [
      { expressId: 1, type: 'IfcWall', globalId: 'A', name: 'DD.01.02' },
      { expressId: 2, type: 'IfcWall', globalId: 'B', name: 'DD.01.02' },
    ]);
    const index = await buildIdentifierIndex([model], CONFIG);
    assert.equal(index.byCode.get('DD.01.02')?.length, 2);
  });

  it('spans multiple models', async () => {
    const index = await buildIdentifierIndex(
      [
        makeModel('arch', [{ expressId: 1, type: 'IfcWall', globalId: 'A', name: 'DD.01.02' }]),
        makeModel('mep', [{ expressId: 7, type: 'IfcDuctSegment', globalId: 'B', name: 'DD.01.02' }]),
      ],
      CONFIG,
    );
    const targets = index.byCode.get('DD.01.02');
    assert.equal(targets?.length, 2);
    assert.deepEqual(targets?.map((t) => t.modelId).sort(), ['arch', 'mep']);
  });

  it('falls through a non-matching source to the next one in order', async () => {
    // objectType is empty in the synthetic store, so the first source yields
    // nothing and the name source must win.
    const model = makeModel('m1', [
      { expressId: 1, type: 'IfcWall', globalId: 'A', name: 'DD.01.02' },
    ]);
    const index = await buildIdentifierIndex(
      [model],
      { ...CONFIG, sources: [{ kind: 'objectType' }, { kind: 'name' }] },
    );
    const hit = index.byCode.get('DD.01.02');
    assert.equal(hit?.length, 1);
    assert.equal(hit?.[0].sourceKind, 'name');
  });

  it('returns an empty index for an invalid pattern', async () => {
    const model = makeModel('m1', [
      { expressId: 1, type: 'IfcWall', globalId: 'A', name: 'DD.01.02' },
    ]);
    const index = await buildIdentifierIndex([model], { ...CONFIG, pattern: '[' });
    assert.equal(index.byCode.size, 0);
  });

  it('skips rows without a GlobalId (not linkable)', async () => {
    const model = makeModel('m1', [{ expressId: 1, type: 'IfcWall', name: 'DD.01.02' }]);
    const index = await buildIdentifierIndex([model], CONFIG);
    assert.equal(index.byCode.size, 0);
  });
});

describe('lookupIdentifier', () => {
  it('normalizes the query before the lookup', async () => {
    const model = makeModel('m1', [
      { expressId: 1, type: 'IfcWall', globalId: 'A', name: 'DD.01.02' },
    ]);
    const index = await buildIdentifierIndex([model], CONFIG);
    assert.equal(lookupIdentifier(index, ' dd-01-02 ').length, 1);
    assert.equal(lookupIdentifier(index, 'ZZ.99').length, 0);
    assert.equal(lookupIdentifier(index, '  ').length, 0);
  });
});
