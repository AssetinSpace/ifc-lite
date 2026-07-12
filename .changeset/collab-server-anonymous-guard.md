---
"@ifc-lite/collab-server": minor
---

The reference CLI (`ifc-lite-collab-server`) now refuses to bind a non-loopback host without `COLLAB_TOKEN_SECRET`; acknowledge deliberate anonymous exposure with `COLLAB_ALLOW_ANONYMOUS=1`.

Without a token secret the server runs the anonymous-editor dev default while the bin's default bind is `0.0.0.0` (required by most hosts) — so a deploy that forgot the one env var silently served a world-writable CRDT store: room poisoning plus disk-fill via 100 MB blob PUTs. The bin now exits at startup with a clear message in that configuration. Local development is unaffected (loopback binds stay anonymous-friendly), production deployments with `COLLAB_TOKEN_SECRET` are unaffected, and trusted-network anonymous deployments keep working by setting `COLLAB_ALLOW_ANONYMOUS=1` (a startup warning is printed). Embedders calling `startCollabServer` directly are not affected — the guard is CLI-only.
