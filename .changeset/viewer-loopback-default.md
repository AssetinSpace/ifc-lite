---
"@ifc-lite/viewer-core": minor
"@ifc-lite/cli": minor
---

`ifc-lite view` now binds loopback (127.0.0.1) by default and validates the Host header; expose on a network explicitly with the new `--host` flag.

The viewer server is unauthenticated — `/model.ifc` serves the full model and `/api/command` / `/api/create` drive the live session — yet it previously listened on all interfaces (Node's default), so anyone on a shared LAN could download the model or inject geometry, and a DNS-rebinding page could do the same from a victim's browser (CORS does not stop reads on a rebound origin). The server now defaults to `127.0.0.1` and, on loopback binds, rejects requests whose Host header is not a loopback name (403) to close the rebinding vector. `startViewerServer` gains a `host` option; the CLI gains `--host <addr>` (e.g. `--host 0.0.0.0`) which skips the Host check and prints an exposure warning — network access is a deliberate opt-in, matching the previous behaviour.
