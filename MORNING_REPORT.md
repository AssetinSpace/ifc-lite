# MORNING_REPORT — nočný audit ifc-lite, 2026-07-12

Vetva: `claude/overnight-repo-audit-vky8t5` (z tipu `main`, 2574d03).
**Nič nie je zmergované do main, nič nie je nasadené** — všetko čaká na tvoje review.
Sesterský report je v repe AIMviewer (auditovali sa oba naraz).

## Rozsah auditu

Repo má ~2 365 zdrojových súborov a silné CI gaty (typecheck, testy, wasm-type-sync,
API-surface, determinism…), takže plošný re-audit všetkého by bol duplikát CI.
Audit preto cielil na:

1. **Čerstvý AIM iframe bridge** (commity #1 `87662f5`, #2 `2574d03`) — hĺbkovo,
   vrátane všetkých modulov, ktoré volá (adaptéry SDK, selection slice, autoload).
2. **Prierezový sweep**: secrets, vstupná validácia server/CLI/collab-server,
   house-rule porušenia (`as any`, silent catch), staleness závislostí, mŕtvy kód.
3. Dokumentácia (`AGENTS.md` root + per-package) ako zdroj pravdy.

Baseline: `pnpm typecheck` ✅; `pnpm test` malo 1 environmentálny fail
(packaging test `packages/wasm` vyžaduje zbuildovaný bundle — po
`pnpm build:wasm:fetch` zelený); fixtures stiahnuté, `pnpm test:wasm-contract` ✅.

## Čo sa našlo (súhrn)

**Feature-breaking v AIM bridge:** `flyTo` je no-op (FOCUS nikdy nepohne kamerou —
claim commitu #2 je nedosiahnuteľný) a `resetColors(refs)` ignoroval refs (každé
obnovenie focus setu zmazalo VŠETKY farby vrátane aktívneho filtra). Oba pramenia
z toho, že bridge bol písaný proti deklarovanému SDK API, ktoré lokálny adaptér
nehonoroval.

**Bezpečnostné (stredné):** `ifc-lite view` server bindne 0.0.0.0 bez auth
(DNS-rebinding / LAN exfiltrácia modelu); collab-server bez `COLLAB_TOKEN_SECRET`
je defaultne svetu zapisovateľný; AIM bridge trust-on-first-embed + degradácia
na `'*'` pri prázdnom referreri; `?models=` autoload bez validácie.

**Čisté (overené):** žiadne secrets, závislosti nezvykle čerstvé s dobrými
overrides, path traversal guardy v poriadku, kanonický load path dodržaný,
žiadne WASM handle leaky v bridge, žiadne `TODO(remove-by:)` po termíne.

## Čo je opravené (commity, chronologicky)

| Commit | Čo a prečo |
|---|---|
| `5390f82` | **fix: `resetColors(refs)` ignoroval refs** — adaptér teraz drží autoritatívnu mapu aplikovaných farieb (pendingColorUpdates je one-shot kanál, scene replace-only): partial reset funguje podľa SDK kontraktu a colorize akumuluje aj cross-tick. + testy `viewer-adapter.colors.test.ts`. |
| `8992e78` | **fix: AIM bridge hardening** — payload validácia (`guids: string[]`; malformed FOCUS už nehádže TypeError), `e.source === window.parent` guard, FOCUS echo sa nevracia hostovi ako ENTITY_SELECTED (riziko slučky), DESELECTED až po prvej selekcii, MODELS_LOADED latch sa resetne pri models.size 0. + testy. |
| `d0da573` | chore: odstránené posledné 2 `as any` v produkčnom viewer kóde (performance.memory typ, Cesium SkyBox.show). |
| `203a00f` | **fix: `?models=`/`?model=` autoload** — len http(s) (žiadne data:/blob:/javascript:), cap 16 modelov, zahodené položky sa logujú; čistá funkcia `parseAutoloadUrls` + testy. |

Všetky zmeny sú v `apps/viewer` (nepublikovaný app) — **žiadny changeset nie je
potrebný**, verejné API balíkov nedotknuté. Generované artefakty nedotknuté.

## Verifikácia

- `pnpm typecheck` ✅ · `pnpm --filter viewer test` ✅ 1686 testov
- plná `pnpm test` (69 turbo úloh) ✅ · `pnpm test:wasm-contract` (reálny wasm) ✅
- Rust časť sa nemenila (cargo testy nespúšťané — žiadny dotknutý kód)

## Čo čaká na tvoje rozhodnutie (a prečo som to nerobil)

Plný zoznam s odhadmi v `NEXT_STEPS.md`; top položky:

1. **`flyTo` no-op** — dve možné cesty (sync globalId kanála v selection-adapteri
   vs. flyTo cez `cameraCallbacks.frameSelection`), obe menia správanie SDK
   selectu alebo kamery pre ďalších konzumentov. Kľúčové pre AIM UX.
2. **MODELS_LOADED po prvom z N modelov** — deep-link focus na VZT prvok sa
   stratí; oprava mení wire kontrakt (koordinovať s AIM host stranou).
3. **`ifc-lite view` bind 127.0.0.1 + `--host` flag** — zmena CLI surface
   (changeset) a správania publikovaného balíka.
4. **collab-server: odmietnuť non-loopback bind bez secretu** — zmena runtime
   defaultu publikovaného balíka.
5. **AIM bridge origin allowlist** — commit #1 ju explicitne odmietol; treba
   produktové rozhodnutie (env var na viewer strane).

Poznámka: AIM bridge opravy menia okrajové správanie kontraktu (žiadne echo na
FOCUS, DESELECTED až po selekcii) — pri ďalšom vývoji host wrappera v AIMviewer
s tým počítať (zaznamenané aj v NEXT_STEPS oboch repo).
