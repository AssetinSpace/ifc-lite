# NEXT_STEPS — nočný audit 2026-07-12

Prioritizované odporúčania z auditu (vetva `claude/overnight-repo-audit-vky8t5`).
Audit cielil na čerstvý AIM iframe bridge (#1, #2) + prierezový sweep (secrets,
server/CLI vstupy, house rules, závislosti). Opravené veci sú v `MORNING_REPORT.md`.
Odhady: S < 1 h, M = 1–4 h, L = deň+.

## Kritické (funkčné)

1. ~~**`bim.viewer.flyTo` je no-op → FOCUS nikdy nepohne kamerou**~~ — **VYRIEŠENÉ**
   (commit v tejto vetve). Zvolená cesta: pridaný kamera callback
   `frameEntities(globalIds)` (Viewport zdieľa bounds-frame logiku s
   `frameSelection`), `flyTo` v adaptéri konvertuje refs→globalId a zavolá ho.
   flyTo tak ostáva čistá kamera-operácia — **nemutuje selekciu**, takže
   neriskuje stale-ref race so `selectedEntityIdsRef` ani echo ENTITY_SELECTED
   naspäť hostovi. Odmietnutá alternatíva „select() nech plní globalId kanál":
   `bim.selection.set` je publikované SDK API (MCP/sandbox/skripty) a AGENTS.md
   ho zámerne drží bez highlightu — menil by som správanie mimo AIM.
   Opravuje aj MCP `viewer_flyto` tool (bol rovnako mŕtvy). Pokryté testami.

## Stredné (bezpečnostné hardening)

2. ~~**`ifc-lite view` server počúva na 0.0.0.0 bez auth**~~ — **VYRIEŠENÉ**
   (commit v tejto vetve, changeset `viewer-loopback-default`, minor
   @ifc-lite/viewer-core + @ifc-lite/cli): default bind `127.0.0.1`; na
   loopback binde sa validuje Host header (403 pre cudzie mená = DNS
   rebinding guard); sieťové vystavenie je explicitný opt-in cez nový
   `--host` flag (preskočí Host check + vypíše varovanie). Pokryté unit
   testami helperov aj integračným testom (skip bez wasm bundlu). Docs
   (cli.md flags tabuľka + HELP) aktualizované, `docs:check-generated` zelený.

3. ~~**collab-server bez `COLLAB_TOKEN_SECRET` = svetu zapisovateľný**~~ —
   **VYRIEŠENÉ** (commit v tejto vetve, changeset `collab-server-anonymous-guard`,
   minor @ifc-lite/collab-server): bin pri non-loopback binde bez secretu
   odmietne štart s jasnou hláškou; vedomé anonymné nasadenie na dôveryhodnej
   sieti = `COLLAB_ALLOW_ANONYMOUS=1` (s varovaním); loopback dev beží bez
   trenia ako doteraz. Guard je čisto CLI záležitosť (`src/startup-guard.ts`
   + testy) — library default `startCollabServer` sa nemení, embedderov sa
   netýka. Docs (guide + README + AGENTS) aktualizované. Zostáva ako nice-to-have:
   celkový disk cap na blob storage (100 MB je len per-blob limit).

4. **AIM bridge trust model = „ver tomu, kto ma embedne"** (M, produktové) —
   origin sa berie z `document.referrer` pri mounte (`AimBridge.tsx`), takže
   ktorákoľvek stránka, čo viewer iframe-ne, je „trusted" a dostáva selection
   GUIDy; pri prázdnom referreri (Referrer-Policy: no-referrer) sa inbound
   origin check preskočí a outbound ide na `'*'`. `e.source === window.parent`
   guard som doplnil (commit 8992e78), zvyšok potrebuje allowlist origin
   (env var, ktorý commit #1 explicitne odmietol) — produktové rozhodnutie.
   Dopad bounded: príkazy sú len focus/filter, GUIDy málo citlivé.

5. **`?models=` autoload bez validácie URL** (S mechanická časť) —
   `ViewerLayout.tsx:96-121` fetchne čokoľvek z query stringu (počet aj veľkosť
   neobmedzené; data:/blob: prejdú). Phishing link = cudzí model pod tvojou
   doménou / OOM tabu. Mechanicky: cap počtu (napr. 8) + len http(s).
   Allowlist storage originov = produktové rozhodnutie (rozbilo by generické
   demá), preto neopravené autonómne.

6. ~~**MODELS_LOADED sa vystrelí po PRVOM z N federovaných modelov**~~ —
   **VYRIEŠENÉ** (commit v tejto vetve). Autoload slučka vo ViewerLayout po
   dokončení VŠETKÝCH URL (aj zlyhaných — host nesmie čakať navždy) dispatchne
   `AUTOLOAD_COMPLETE_EVENT`; AimBridge pri autoloade ohlasuje MODELS_LOADED
   až na tento event, bez autoload parametrov ostáva pôvodný 0→N latch.
   Wire kontrakt sa nemení (stále jedna správa MODELS_LOADED s count) —
   host strana v AIMviewer nepotrebuje zmenu, len signál príde v správny čas.

## Kozmetické

7. **Chat proxy verí `x-forwarded-host`** (S) — `server/chat/chat-handler.ts:273`
   odvodzuje vlastný origin z klientom ovplyvniteľnej hlavičky; `Origin: evil` +
   `X-Forwarded-Host: evil` obíde allowlist. Nízky dopad (curl je aj tak povolený,
   reálna ochrana je per-IP kvóta) — odvodiť own-origin z `config.appUrl`.
8. **`/api/create` validuje len `elements[0].type`** (S) — `packages/viewer/src/server.ts:285`;
   zvyšok poľa + params idú do createHandler nevalidované (localhost tooling).
9. **Comma-split `?models=`** (S) — `ViewerLayout.tsx:99` rozbije URL s literálnou
   čiarkou v query (signed URLs); vyžadovať URL-encoded položky.
10. **Autoload fetch bez AbortController** (S) — `ViewerLayout.tsx:104-122`
    pokračuje vo fetch/parse po unmounte (session token chráni store, len
    zbytočná práca).
11. **`packages/wasm` packaging test lokálne padá bez zbuildovaného wasm** (S) —
    `test/package.test.mjs` je jediný wasm test, ktorý neskipne pri chýbajúcom
    bundli (`pnpm build:wasm:fetch` ho sprístupní). Zvážiť skip so správou ako
    súrodenci — pozor, je to publikovaný balík (changeset otázka).
12. **`as any` v testoch (~135)** (L, postupne) — najhoršie
    `packages/query/test/entity-node.test.ts` (41), `entity-query.test.ts` (22),
    `dataSlice.test.ts` (13). House rule testy nevyníma; riešiť typovanými
    fixture buildermi pri najbližšom dotyku súborov.
13. **AIM bridge fixy z tejto vetvy zrkadliť v AIM repo** (S) — echo suppression
    a payload validácia menia okrajové správanie kontraktu (žiadne ENTITY_SELECTED
    echo na FOCUS; DESELECTED až po prvej selekcii) — host strana s tým už dnes
    počíta, ale pri ďalšom vývoji wrapperu na to nezabudnúť.

## Overené a čisté (bez akcie)

- Secrets: žiadne (dummy `sk-ant-` kľúče sú testy redakcie; PostHog/LLM kľúče
  z env; BYOK len v localStorage).
- Závislosti: nezvykle čerstvé (TS 6, vitest 4, vite 8), `pnpm.overrides`
  pinuje historicky zraniteľné transitívne deps; `exceljs` namiesto `xlsx`.
- Path traversal na `/wasm/*` správne guardovaný; collab-server blob hash
  validácia a constant-time token compare v poriadku.
- AIM bridge: kanonický load path (`useIfcFederation.addModel` → `loadFile`),
  žiadna ad-hoc globalId matematika, žiadne WASM handle leaky, MPL hlavičky OK.
- `TODO(remove-by:)` po termíne: žiadne.
