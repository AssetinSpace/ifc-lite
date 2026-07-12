/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAllowedRequestHost,
  isLoopbackBind,
  resolvePackageDirFromModuleUrl,
  resolveWasmAssetPath,
  startViewerServer,
} from '../src/server.js';

/** startViewerServer reads the wasm runtime, which is gitignored — skip when absent. */
const wasmBuilt = existsSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wasm', 'pkg', 'ifc-lite.js'),
);

/** GET via raw node:http so the Host header can be spoofed (fetch forbids it). */
function rawGet(port: number, hostHeader: string, path = '/api/status'): Promise<number> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, headers: { Host: hostHeader } },
      (r) => {
        r.resume();
        res(r.statusCode ?? 0);
      },
    );
    req.on('error', rej);
    req.end();
  });
}

describe('resolvePackageDirFromModuleUrl', () => {
  it('decodes Windows file URLs without duplicating the drive prefix', () => {
    const dir = resolvePackageDirFromModuleUrl(
      'file:///C:/Users/Luis%20Felipe/AppData/Roaming/npm/node_modules/@ifc-lite/wasm/pkg/ifc-lite.js',
    );

    assert.match(dir, /Luis Felipe/);
    assert.doesNotMatch(dir, /%20/);
    assert.equal(dir.match(/C:/g)?.length ?? 0, 1);
    assert.match(dir.replaceAll('\\', '/'), /\/node_modules\/@ifc-lite\/wasm$/);
  });

  it('resolves POSIX file URLs to the package root', () => {
    const dir = resolvePackageDirFromModuleUrl(
      'file:///Users/test/node_modules/@ifc-lite/wasm/pkg/ifc-lite.js',
    );

    assert.equal(dir, '/Users/test/node_modules/@ifc-lite/wasm');
  });
});

describe('isLoopbackBind', () => {
  it('classifies loopback vs network binds', () => {
    assert.equal(isLoopbackBind('127.0.0.1'), true);
    assert.equal(isLoopbackBind('localhost'), true);
    assert.equal(isLoopbackBind('::1'), true);
    assert.equal(isLoopbackBind('127.0.0.53'), true);
    assert.equal(isLoopbackBind('0.0.0.0'), false);
    assert.equal(isLoopbackBind('192.168.1.10'), false);
  });
});

describe('isAllowedRequestHost (DNS-rebinding guard, audit 2026-07-12)', () => {
  it('accepts loopback Host headers on a loopback bind (with and without port)', () => {
    assert.equal(isAllowedRequestHost('localhost:3456', '127.0.0.1'), true);
    assert.equal(isAllowedRequestHost('127.0.0.1:3456', '127.0.0.1'), true);
    assert.equal(isAllowedRequestHost('localhost', '127.0.0.1'), true);
    assert.equal(isAllowedRequestHost('[::1]:3456', '127.0.0.1'), true);
  });

  it('rejects foreign Host headers on a loopback bind (rebinding vector)', () => {
    // evil.example DNS-rebound to 127.0.0.1: connection is local, Host is not.
    assert.equal(isAllowedRequestHost('evil.example', '127.0.0.1'), false);
    assert.equal(isAllowedRequestHost('evil.example:3456', '127.0.0.1'), false);
    assert.equal(isAllowedRequestHost(undefined, '127.0.0.1'), false);
  });

  it('skips the check on a deliberate non-loopback bind (--host opt-in)', () => {
    assert.equal(isAllowedRequestHost('workstation.lan:3456', '0.0.0.0'), true);
    assert.equal(isAllowedRequestHost('anything', '192.168.1.10'), true);
  });
});

describe('resolveWasmAssetPath', () => {
  it('resolves snippet asset requests inside the wasm pkg directory', () => {
    const assetPath = resolveWasmAssetPath(
      '/Users/test/node_modules/@ifc-lite/wasm',
      '/wasm/snippets/ifc-lite-wasm-abc123/src/helper.js',
    );

    assert.equal(
      assetPath,
      '/Users/test/node_modules/@ifc-lite/wasm/pkg/snippets/ifc-lite-wasm-abc123/src/helper.js',
    );
  });

  it('rejects path traversal outside the wasm pkg directory', () => {
    const assetPath = resolveWasmAssetPath(
      '/Users/test/node_modules/@ifc-lite/wasm',
      '/wasm/snippets/../../package.json',
    );

    assert.equal(assetPath, null);
  });
});

describe('startViewerServer network posture (audit 2026-07-12)', { skip: !wasmBuilt && 'wasm runtime not built — run `pnpm build:wasm:fetch` first' }, () => {
  it('binds loopback by default and rejects spoofed Host headers with 403', async () => {
    let boundPort = 0;
    const viewer = await startViewerServer({
      filePath: null,
      fileName: 'empty',
      port: 0,
      onReady: (port) => { boundPort = port; },
    });
    try {
      assert.ok(boundPort > 0);
      assert.equal(await rawGet(boundPort, `localhost:${boundPort}`), 200);
      assert.equal(await rawGet(boundPort, `127.0.0.1:${boundPort}`), 200);
      // DNS-rebinding: local connection, foreign Host header.
      assert.equal(await rawGet(boundPort, 'evil.example'), 403);
    } finally {
      viewer.close();
    }
  });
});
