# ZVYRA backend integration contract

Status: implementation in progress, 2026-10-15. Backend owns `backend/` and the preserved `SWARM/` source snapshot. Opus owns renderer, root package, Electron windows and visual design. Do not use SWARM's original main/preload or register its broad IPC surface.

The real SWARM source is copied from `D:\SWARM---ai` (root desktop 1.0.6). `SWARM/electron`, `SWARM/shared`, dependencies, tests, build scripts and resources preserve that implementation. User databases, credentials, environment files, installed dependencies, builds, backups and alternate website/Android copies are excluded. Source will be hash-manifested. The original folder is not modified.

## Electron integration

Backend exports `startBackend({dataDirectory, publish})` from `backend/src/index.ts`; call after Electron app ready, once per process. It returns `{invoke, close}`. `backend/src/ipc.ts` registers a single validated channel for explicitly trusted BrowserWindows. Preload uses `backend/src/preload.ts` to expose `window.zvyraBackend`, with `invoke(operation, input)` and `on(listener)` returning an unsubscribe function. No arbitrary channel, shell or filesystem bridge is exposed. Use bundled sandbox-compatible preload.

Authoritative operation schemas and TypeScript requests/responses: `backend/src/contract.ts` and `backend/src/service.ts`. Every call returns `{ok:true,data}` or `{ok:false,error:{code,message,retryable}}`. Events use `{version:1,sequence,at,topic,payload}`. On mount subscribe then retrieve snapshots; event sequence gaps require reloading snapshots. Stream events are ephemeral; execution logs and records are persisted by SWARM.

## Existing SWARM behavior

Models/discovery/probes use `electron/providers/registry.ts`; all model requests use `electron/router/router.ts` through chat or orchestration. Returned model IDs are authoritative. Manual pinning is a preference with SWARM fallback, not a guarantee. `routing.maxFallbacks=0` disables model switching but SWARM can retry transient failures once. Custom fallback ordering and per-agent preferences use existing settings. Free mode is enforced by this source. Registered BYOK providers: google, groq, mistral, huggingface, nvidia, openrouter; managed account support exists upstream but is not enabled by this integration. Ollama is not registered.

Tasks are actual SWARM runs and DAG tasks, not a second execution engine. Preserve native run/task statuses from `SWARM/shared/types.ts`; approvals are separate records. Pause prevents new work but in-flight actions may finish. Cancel is a request until the terminal status event arrives. Crash recovery marks interrupted work and requires explicit resume. No fake progress percentages. Run snapshots include real assignments, tasks, gates and summaries.

Credentials are written using SWARM safeStorage (Windows DPAPI); no plaintext fallback. Existing environment variables are preserved: GEMINI_API_KEY/GOOGLE_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, HF_TOKEN/HUGGINGFACE_API_KEY, NVIDIA_API_KEY/NGC_API_KEY, OPENROUTER_API_KEY. The application process must inherit them. Missing credentials produce configuration errors, not healthy status.

## Ownership handoff

The backend does not create another renderer, tray, or Dynamic Island. Opus should keep one main-process backend alive while windows hide, forward events to both windows, and call close on actual quit. Dynamic Island and main window use the same bridge. Windows must have contextIsolation:true, nodeIntegration:false, sandbox:true. Only local, explicitly trusted top-level frames may invoke the backend. Remote pages and webviews are never trusted.

Further setup, verified results and limitations will be recorded in `backend/README.md`.
