/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wire-contract tests for the published embed SDK: the host side of the
 * postMessage protocol is driven end-to-end against hand-rolled DOM stubs
 * (no jsdom) using real @ifc-lite/embed-protocol envelopes for the viewer
 * side, so an incompatible protocol change breaks here, not in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, createResponse, type EmbedMessageEnvelope } from '@ifc-lite/embed-protocol';

import { IFCLiteEmbed, type EmbedOptions } from './index.js';

const ORIGIN = 'https://embed.example';

type MessageListener = (event: { origin: string; source: unknown; data: unknown }) => void;

interface Harness {
  iframe: {
    src: string;
    style: { cssText: string };
    setAttribute: (k: string, v: string) => void;
    remove: () => void;
    contentWindow: { postMessage: ReturnType<typeof vi.fn> };
  };
  container: { appendChild: ReturnType<typeof vi.fn> };
  emit: (data: unknown, origin?: string, source?: unknown) => void;
  sent: () => EmbedMessageEnvelope[];
}

let harness: Harness;
let listeners: MessageListener[];

beforeEach(() => {
  listeners = [];
  const postMessage = vi.fn();
  const iframe = {
    src: '',
    style: { cssText: '' },
    setAttribute: () => {},
    remove: vi.fn(),
    contentWindow: { postMessage },
  };
  harness = {
    iframe,
    container: { appendChild: vi.fn() },
    emit: (data, origin = ORIGIN, source: unknown = iframe.contentWindow) => {
      for (const fn of [...listeners]) fn({ origin, source, data });
    },
    sent: () => postMessage.mock.calls.map((c) => c[0] as EmbedMessageEnvelope),
  };
  vi.stubGlobal('document', { createElement: () => iframe });
  vi.stubGlobal('window', {
    addEventListener: (_: string, fn: MessageListener) => listeners.push(fn),
    removeEventListener: (_: string, fn: MessageListener) => {
      listeners = listeners.filter((l) => l !== fn);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function startEmbed(extra: Partial<EmbedOptions> = {}) {
  return IFCLiteEmbed.create({
    container: harness.container as unknown as HTMLElement,
    origin: ORIGIN,
    ...extra,
  });
}

async function connect(extra: Partial<EmbedOptions> = {}): Promise<IFCLiteEmbed> {
  const pending = startEmbed(extra);
  harness.emit(createEvent('READY', { version: '1.0.0' }));
  harness.emit({ ...createEvent('READY', { version: '1.0.0' }), type: 'INIT_ACK' });
  return pending;
}

describe('handshake', () => {
  it('READY -> INIT (with token) -> INIT_ACK resolves create()', async () => {
    const pending = startEmbed({ token: 's3cret' });
    harness.emit(createEvent('READY', { version: '1.0.0' }));

    const init = harness.sent().find((m) => m.type === 'INIT');
    expect(init?.data).toEqual({ token: 's3cret' });
    expect(init?.source).toBe('ifc-lite-embed');
    // Token travels via postMessage, never in the iframe URL.
    expect(harness.iframe.src).not.toContain('s3cret');

    harness.emit({ ...createEvent('READY', { version: '1.0.0' }), type: 'INIT_ACK' });
    await expect(pending).resolves.toBeInstanceOf(IFCLiteEmbed);
  });
});

describe('request/response correlation', () => {
  it('resolves a command with the viewer response payload', async () => {
    const embed = await connect();
    const result = embed.selectByGuid(['2O2Fr$t4X7Zf8NOew3FLOH']);

    const req = harness.sent().find((m) => m.type === 'SELECT_BY_GUID');
    expect(req?.requestId).toBeTruthy();
    expect(req?.data).toEqual({ guids: ['2O2Fr$t4X7Zf8NOew3FLOH'] });

    harness.emit(createResponse(req!.requestId!, { resolved: [42] }));
    await expect(result).resolves.toEqual({ resolved: [42] });
  });

  it('rejects when the viewer responds with a protocol error', async () => {
    const embed = await connect();
    const result = embed.getProperties(7);
    const req = harness.sent().find((m) => m.type === 'GET_PROPERTIES');

    harness.emit(createResponse(req!.requestId!, undefined, { code: 'NOT_FOUND', message: 'no entity 7' }));
    await expect(result).rejects.toThrow('NOT_FOUND: no entity 7');
  });
});

describe('event dispatch', () => {
  it('forwards viewer events to kebab-case subscribers and supports unsubscribe', async () => {
    const embed = await connect();
    const seen: unknown[] = [];
    const off = embed.on('entity-selected', (d) => seen.push(d));

    harness.emit(createEvent('ENTITY_SELECTED', { id: 1, globalId: 'g' }));
    off();
    harness.emit(createEvent('ENTITY_SELECTED', { id: 2 }));

    expect(seen).toEqual([{ id: 1, globalId: 'g' }]);
  });
});

describe('message filtering', () => {
  it('ignores wrong origin, wrong source window and non-protocol data', async () => {
    const embed = await connect();
    const seen: unknown[] = [];
    embed.on('entity-selected', (d) => seen.push(d));

    harness.emit(createEvent('ENTITY_SELECTED', { id: 1 }), 'https://evil.example');
    harness.emit(createEvent('ENTITY_SELECTED', { id: 2 }), ORIGIN, { other: 'window' });
    harness.emit({ source: 'react-devtools', type: 'ENTITY_SELECTED' });

    expect(seen).toEqual([]);
  });
});

describe('destroy', () => {
  it('rejects pending requests, stops listening and removes the iframe', async () => {
    const embed = await connect();
    const dangling = embed.getModelInfo();
    embed.destroy();

    await expect(dangling).rejects.toThrow('Embed destroyed');
    expect(harness.iframe.remove).toHaveBeenCalled();
    expect(listeners).toEqual([]);
    await expect(embed.getModelInfo()).rejects.toThrow('Embed destroyed');
  });
});
