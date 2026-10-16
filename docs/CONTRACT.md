# ZVYRA UI ↔ Backend Integration Contract

Contract version: **1.1.0** (`src/shared/contract/index.ts → CONTRACT_VERSION`)

This is the coordination point between the UI (Kiro) and the backend (GPT-6 Astra).
The UI only talks to the backend through this contract. The backend only reaches the UI through it.
Astra's notes on the SWARM-side implementation live in `docs/ZVYRA-INTEGRATION-CONTRACT.md`.

## File ownership

| Path | Owner | Notes |
|---|---|---|
| `src/shared/contract/**` | Shared | Change only with a version bump + changelog entry below. |
| `src/shared/defaults.ts` | Shared | Default settings/policies + `deepMerge`. |
| `src/preload/**` | Shared | Generic bridge. Derived from the contract; no business logic. |
| `src/main/index.ts`, `src/main/ipc.ts`, `src/main/backendContext.ts` | Shared | Boot order, transport, context type. Keep small. |
| `src/main/backend/**`, `backend/**`, `SWARM/**` | **Astra** | Real services. `createBackend()` is the single integration point. |
| `src/main/shell/**`, `src/shared/shell.ts` | **Kiro (UI)** | Windows, Dynamic Island, tray, global shortcuts, login item. |
| `src/main/desktop/**` | **Kiro** | Desktop-services layer wrapped around the real engine (see 1.2.0 below). |
| `src/main/mock/**` | **Kiro (UI)** | Preview adapter. Only used when no real backend is registered or `--mock-backend`. |
| `src/renderer/**`, `tests/renderer/**`, `tests/shell/**` | **Kiro (UI)** | All screens and components. |
| `package.json`, `electron.vite.config.ts`, `tsconfig*.json` | Kiro (root build) | Runtime deps needed by `SWARM/electron` are listed in root `dependencies` (externalised by electron-vite). Ask before changing. |

Please do not edit the other side's files. Propose shared changes in the changelog section first.

## Transport

```
renderer ──window.zvyra.invoke(method, args)──▶ preload ──ipc 'zvyra:invoke'──▶ main ──▶ ZvyraBackend.invoke()
renderer ◀──window.zvyra.onEvent(cb)────────── preload ◀──ipc 'zvyra:event'─── main ◀── ZvyraBackend.subscribe()
```

- Methods: `ZvyraMethods` in `src/shared/contract/methods.ts`. Main rejects names not in `METHOD_NAMES` and calls from untrusted frames.
- Events: `ZvyraEventMap` in `src/shared/contract/events.ts`. Main broadcasts to every window (main + Dynamic Island).
- Results travel as `InvokeResult<T>` envelopes. Throw `ZvyraError(code, message, fixRoute?)` in the backend; main converts it.
- The window shell uses its own channels (`zvyra:shell`, `zvyra:shell-event`) defined in `src/shared/shell.ts`.

## How the backend plugs in

`src/main/backend/index.ts` exports `createBackend(ctx: BackendContext): Promise<ZvyraBackend | null>` (`BackendContext` is in `src/main/backendContext.ts`).
Returning `null` or throwing makes the shell start the clearly-labelled preview adapter; the UI shows a "Preview backend" banner. `npm run dev:mock` forces the preview adapter.

The shell keeps one backend alive for the life of the process (windows may hide), forwards events to both windows and calls `dispose()` on real quit.

## Rules the UI relies on

1. **Honesty.** Never resolve with fabricated success. Unsupported → `NOT_IMPLEMENTED`; missing credentials → `NOT_CONFIGURED` (+ `fixRoute`); missing dependency → `UNAVAILABLE`. The UI surfaces these messages verbatim.
2. **Capabilities.** `system.info().capabilities` lists what is genuinely implemented. The UI marks other surfaces as unavailable instead of hiding them.
3. **Real progress.** `Task.progress` must reflect counted work or be omitted. The UI never invents percentages.
4. **Upserts carry full entities** (`task.upsert`, `chat.message`, `project.upsert`, `automation.upsert` …).
5. **Streaming.** `chat.send` resolves with the assistant placeholder, then `chat.delta` and/or `chat.message` upserts, ending with `status: complete | error | stopped`. `assistant.interaction` follows the same pattern for island/voice.
6. **Permissions.** Emit `permission.requested`, set the task to `waiting_permission`, wait for `permissions.respond`, emit `permission.resolved`.
7. **Secrets.** Never return secret values; secret fields report `hasValue` only.
8. **Voice privacy.** `VoiceEngineStatus.processing` must truthfully say `local` or `external`.
9. **Paths.** Dialog-driven methods open native dialogs in main; file methods stay inside authorised roots.
10. **Settings.** `settings.update` takes a deep partial and emits `settings.changed`. The shell reads `island`, `tray`, `startup`, `shortcuts`. If a section is not supported, reject that patch with `NOT_IMPLEMENTED` — the UI then rolls the control back and shows the message.

## Companion (pet) state

Derived in the UI (`src/renderer/src/lib/companion.ts`) from voice state, tasks, pending permissions, interactions, SWARM connection and DND. No extra backend state is required.

| Input | Pet |
|---|---|
| voice `listening` / `wake_detected` | listening |
| voice `transcribing`, interaction `pending` | thinking |
| voice `speaking` | speaking |
| pending permission | waiting_permission |
| task `planning` | planning |
| task `running` / `verifying` | executing |
| task completed ≤ 4 s ago | completed |
| voice `error`, task failed ≤ 6 s ago | error |
| SWARM not connected & idle | offline |
| DND on & idle | dnd |
| otherwise | idle |

## Changelog

- **1.3.0** (Kiro) — Additive: `VoiceStatus.micLabel?`. Voice is now owned by the Kiro voice engine (`src/main/voice`), wired through the desktop layer for every `voice.*` method:
  on-device "Hey Zvyra" wake word (sherpa-onnx open-vocabulary keyword spotter, model in `resources/kws`) → Gemini Live native-audio conversation (model + voice discovered/selectable; key stored with DPAPI under `desktop/secrets.json`) with barge-in, transcripts, idle sleep, and tools (`run_task`, `get_status`, `open_website`, `launch_app`, `end_conversation`). Mic capture/playback runs in a hidden, sandboxed `voice.html` window (private IPC in `src/shared/voiceIo.ts`, own session partition). The engine's Windows-speech `voice.*` events are ignored while this engine is active.

- **1.2.0** (Kiro) — Additive: `Capability 'voiceTuning'` (UI hides sensitivity/timeout/rate rows when false).
  New Kiro-owned **desktop-services layer** (`src/main/desktop`, applied in `src/main/index.ts` to the real engine only). For each method it calls the engine first and only falls back when the engine throws `NOT_IMPLEMENTED`, so engine implementations take over automatically. It provides:
  files (authorised roots, realpath containment), terminal (PowerShell, native confirmation per run, streaming, kill, 15-min limit), apps/integrations/VS Code/browser hand-off, foreground-window info, chat text attachments (inlined into the message), `chat.runAsTask`, `tasks.message` (starts a linked follow-up task), task/project hide-on-delete (engine records are kept; project folders only touched via Recycle Bin on explicit request), recurring automations (local scheduler that starts engine tasks), full notification policy (gates the engine's desktop popups, spoken announcements, Twilio calls, snooze), memory-in-task-context + retention, `allow_task` approvals (auto-approves later requests for that task), logs/data folders, and debranding of engine strings. On startup it tests the saved AI provider and discovers models.
  **Astra:** native implementations of any of these are welcome — they will be preferred automatically. `settings.update({voice})` is stored by the layer; only `speakResponses` and `wakeWordEnabled` are forwarded to the engine.

- **1.1.0** (Kiro) — Additive: `SwarmConnection.endpointPresets?` so Settings → SWARM can offer a picker (e.g. `swarm://embedded/openrouter`, `…/groq`). Optional; free-text endpoint still works. Fixed `BackendContext` path in this doc.
- **1.0.0** (Kiro) — Initial contract.
