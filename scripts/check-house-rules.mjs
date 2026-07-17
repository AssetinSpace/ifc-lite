#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Guard: the AGENTS.md house rules for production TypeScript —
 *   1. no `as any` casts,
 *   2. no `@ts-ignore` / `@ts-nocheck` directives,
 *   3. no silent `catch {}` (empty body without even a comment),
 * were "review conventions, not linted, so self-police" — i.e. nothing
 * enforced them and `pnpm lint` passed trivially. This makes the root
 * `lint` script (and the CI "Lint" job) actually gate them.
 *
 * Scope: production sources under packages/*\/src, apps/*\/src and
 * server/. Test files (*.test.*, *.spec.*, __tests__/) and *.d.ts are
 * exempt for now — tests carry ~135 pre-existing `as any` fixture casts;
 * tighten later with typed fixture builders.
 *
 * Escape hatch: a line containing `house-rules-allow: <reason>` is
 * skipped — use sparingly and justify inline.
 *
 * Run via `pnpm lint` / `node scripts/check-house-rules.mjs`.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_ROOTS = [
  ...listDirs(join(ROOT, 'packages')).map((d) => join(d, 'src')),
  ...listDirs(join(ROOT, 'apps')).map((d) => join(d, 'src')),
  join(ROOT, 'server'),
].filter(existsSync);

const SOURCE_RE = /\.(ts|tsx|mts|cts)$/;
const EXEMPT_RE = /(\.test\.|\.spec\.|\.d\.ts$)|(^|\/)__tests__\//;
const ALLOW_MARKER = 'house-rules-allow:';

function listDirs(parent) {
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .map((name) => join(parent, name))
    .filter((p) => statSync(p).isDirectory());
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (SOURCE_RE.test(name)) yield path;
  }
}

/**
 * Blank out comments and string/template literals (preserving newlines) so
 * code-level checks (`as any`, empty catch) don't trip on prose. Not a full
 * lexer, but handles nesting-free TS well; regex literals are left alone —
 * a false hit there still deserves a `house-rules-allow:` note.
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : '';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i++;
        else if (source[i] === '\n') out += '\n';
        i++;
      }
      i++;
      out += quote === '`' ? '``' : `${quote}${quote}`;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const RULES = [
  {
    name: 'no `as any`',
    hint: 'fix the types or add a .d.ts (AGENTS.md house rules)',
    find(stripped) {
      return matchLines(stripped, /\bas\s+any\b/g);
    },
  },
  {
    name: 'no `@ts-ignore` / `@ts-nocheck`',
    hint: 'use precise types; if unavoidable, @ts-expect-error with a reason',
    find(_stripped, raw) {
      // Directives only work as the start of a comment — prose mentions
      // deeper inside a comment block don't trip this.
      return matchLines(raw, /\/[/*]\s*@ts-(?:ignore|nocheck)\b/g);
    },
  },
  {
    name: 'no silent `catch {}`',
    hint: 'log or rethrow; an explanatory comment inside the block also passes',
    find(_stripped, raw) {
      // Empty = nothing but whitespace in the raw body (a comment-only body
      // is an explained best-effort catch and passes).
      return matchLines(raw, /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g);
    },
  },
];

function matchLines(text, re) {
  const hits = [];
  for (const m of text.matchAll(re)) {
    hits.push(text.slice(0, m.index).split('\n').length);
  }
  return hits;
}

let failures = 0;
for (const root of SOURCE_ROOTS) {
  for (const file of walk(root)) {
    const rel = relative(ROOT, file);
    if (EXEMPT_RE.test(rel)) continue;
    const raw = readFileSync(file, 'utf8');
    const rawLines = raw.split('\n');
    const stripped = stripCommentsAndStrings(raw);
    for (const rule of RULES) {
      for (const line of rule.find(stripped, raw)) {
        if (rawLines[line - 1]?.includes(ALLOW_MARKER)) continue;
        console.error(`${rel}:${line} — ${rule.name} (${rule.hint})`);
        failures++;
      }
    }
  }
}

if (failures > 0) {
  console.error(
    `\nhouse-rules: ${failures} violation(s). ` +
      `If a hit is a justified exception, append \`// ${ALLOW_MARKER} <reason>\` on that line.`
  );
  process.exit(1);
}
console.log('house-rules: production sources clean (as any / @ts-ignore / silent catch).');
