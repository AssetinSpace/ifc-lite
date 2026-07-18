/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createSyntheticDataStore, IfcParser } from '@ifc-lite/parser';
import { analyzeIdentifierScheme, applySchemeProposal } from './analyze.js';
import { compileIdentifierPattern, DEFAULT_IDENTIFIER_LINK_CONFIG } from './config.js';

describe('analyzeIdentifierScheme', () => {
  it('detects DIRECT occurrence codes printed verbatim in Name', () => {
    const store = createSyntheticDataStore({
      schemaVersion: 'IFC4',
      fileSize: 0,
      entities: [
        { expressId: 1, type: 'IfcDoorType', globalId: 'T1', name: 'DD01.02' },
        { expressId: 2, type: 'IfcDoor', globalId: 'A', name: 'DD01.02.001' },
        { expressId: 3, type: 'IfcDoor', globalId: 'B', name: 'DD01.02.002' },
        { expressId: 4, type: 'IfcDoor', globalId: 'C', name: 'no code here' },
      ],
    });
    const proposal = analyzeIdentifierScheme([{ id: 'm1', ifcDataStore: store }]);
    assert.ok(proposal, 'proposal produced');
    assert.equal(proposal.mode, 'direct');
    assert.equal(proposal.stats.directOccurrences, 2);
    assert.deepEqual(proposal.sources[0], { kind: 'name' });
    const typeRe = compileIdentifierPattern(proposal.typePattern);
    const occRe = compileIdentifierPattern(proposal.occurrencePattern);
    assert.ok(typeRe && typeRe.test('DD01.02'), `type pattern ${proposal.typePattern}`);
    assert.ok(occRe && occRe.test('DD01.02.001'), `occ pattern ${proposal.occurrencePattern}`);
    assert.ok(!occRe.test('DD01.02'), 'occurrence pattern rejects bare type codes');
  });

  it('detects COMPOSED codes (type code in Name + Mark discriminator)', async () => {
    const STEP = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('ProjGuid_____________2',$,'P',$,$,$,$,$,$);
#100=IFCDOOR('DoorGuid_____________2',$,'Family.CC:DD01.02 - Doors:77',$,$,$,$,'77',$,$,$,$,$);
#200=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('03'),$);
#201=IFCPROPERTYSET('PsetGuid_____________2',$,'IFC_Doors',$,(#200));
#300=IFCRELDEFINESBYPROPERTIES('RelGuid______________2',$,$,$,(#100),#201);
ENDSEC;
END-ISO-10303-21;
`;
    const buf = new TextEncoder().encode(STEP);
    const store = await new IfcParser().parseColumnar(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
    const proposal = analyzeIdentifierScheme([{ id: 'm1', ifcDataStore: store }]);
    assert.ok(proposal);
    assert.equal(proposal.stats.discriminatorProp, 'Mark');
    assert.equal(proposal.mode, 'composed');
    assert.deepEqual(proposal.discriminatorSources, [
      { kind: 'pset', psetName: '', propertyName: 'Mark' },
    ]);
  });

  it('returns null when the model carries no identifier-shaped codes', () => {
    const store = createSyntheticDataStore({
      schemaVersion: 'IFC4',
      fileSize: 0,
      entities: [{ expressId: 1, type: 'IfcWall', globalId: 'A', name: 'plain wall' }],
    });
    assert.equal(analyzeIdentifierScheme([{ id: 'm1', ifcDataStore: store }]), null);
  });
});

describe('applySchemeProposal', () => {
  it('applies patterns/sources/mode but keeps enabled and debug', () => {
    const store = createSyntheticDataStore({
      schemaVersion: 'IFC4',
      fileSize: 0,
      entities: [
        { expressId: 1, type: 'IfcDoorType', globalId: 'T1', name: 'DD01.02' },
        { expressId: 2, type: 'IfcDoor', globalId: 'A', name: 'DD01.02.001' },
      ],
    });
    const proposal = analyzeIdentifierScheme([{ id: 'm1', ifcDataStore: store }])!;
    const next = applySchemeProposal(
      { ...DEFAULT_IDENTIFIER_LINK_CONFIG, enabled: true, debug: true },
      proposal,
    );
    assert.equal(next.enabled, true);
    assert.equal(next.debug, true);
    assert.equal(next.pattern, proposal.typePattern);
    assert.equal(next.occurrence.pattern, proposal.occurrencePattern);
    assert.equal(next.occurrence.mode, proposal.mode);
  });
});
