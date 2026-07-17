/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  EMBED_SOURCE,
  PROTOCOL_VERSION,
  createCommand,
  createEvent,
  createResponse,
  isEmbedMessage,
} from './index.js';

describe('envelope creation', () => {
  it('createCommand stamps source/version and carries requestId + data', () => {
    const msg = createCommand('SELECT_BY_GUID', { guids: ['abc'] }, 'req-1');
    expect(msg).toEqual({
      source: EMBED_SOURCE,
      version: PROTOCOL_VERSION,
      type: 'SELECT_BY_GUID',
      requestId: 'req-1',
      data: { guids: ['abc'] },
    });
  });

  it('createEvent stamps source/version without correlation ids', () => {
    const msg = createEvent('MODEL_LOADED', { entityCount: 1, meshCount: 1, loadTimeMs: 2 });
    expect(msg.source).toBe(EMBED_SOURCE);
    expect(msg.version).toBe(PROTOCOL_VERSION);
    expect(msg.type).toBe('MODEL_LOADED');
    expect(msg.requestId).toBeUndefined();
    expect(msg.responseId).toBeUndefined();
  });

  it('createResponse echoes the requestId as responseId, with data or error', () => {
    const ok = createResponse('req-2', { resolved: [1] });
    expect(ok.type).toBe('RESPONSE');
    expect(ok.responseId).toBe('req-2');
    expect(ok.data).toEqual({ resolved: [1] });
    expect(ok.error).toBeUndefined();

    const err = createResponse('req-3', undefined, { code: 'NOT_FOUND', message: 'nope' });
    expect(err.responseId).toBe('req-3');
    expect(err.error).toEqual({ code: 'NOT_FOUND', message: 'nope' });
  });
});

describe('isEmbedMessage round-trip', () => {
  it('accepts every envelope this package can create', () => {
    expect(isEmbedMessage(createCommand('INIT'))).toBe(true);
    expect(isEmbedMessage(createEvent('READY', { version: '1.0.0' }))).toBe(true);
    expect(isEmbedMessage(createResponse('req-4'))).toBe(true);
  });

  it('rejects unrelated postMessage traffic', () => {
    expect(isEmbedMessage(null)).toBe(false);
    expect(isEmbedMessage(undefined)).toBe(false);
    expect(isEmbedMessage('ifc-lite-embed')).toBe(false);
    expect(isEmbedMessage({})).toBe(false);
    expect(isEmbedMessage({ source: 'react-devtools' })).toBe(false);
    expect(isEmbedMessage({ type: 'READY' })).toBe(false);
  });
});
