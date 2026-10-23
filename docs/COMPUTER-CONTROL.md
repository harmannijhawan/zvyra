# ZVYRA computer control — 0.3.4

The existing UI, theme, navigation, Dynamic Island and tray are preserved. The implementation uses the existing tool router, provider settings, task records, permissions and runtime events.

## Runtime changes

- `src/main/computer/controller.ts`: actual screenshots, fresh single-use frame tokens, monitor/DPI mapping, semantic target resolution, native clicks and post-action observations. Frames use short tokens (`f1`, `f2`, …), returned at the top level after every action as well as under `observation` for compatibility.
- `src/main/tools/uia.ts`: repaired accessibility traversal, stable runtime IDs, focused/point/target lookup and password redaction. A fresh target is resolved after mouse movement. Native HWND hit testing handles Chromium modal providers that return only a host pane, while refusing other windows covering the target.
- `src/main/tools/pcControl.ts` and `computer/nativeInput.ts`: persistent Windows SendInput executor. Mouse moves use paced smoothstep interpolation of the real OS cursor, typically 140–550 ms. Semantic targets are located through accessibility, then receive physical mouse button events. Cancellation, focus loss or external cursor displacement interrupts movement. Click cleanup no longer emits a duplicate mouse-up.
- `src/main/voice/computerTools.ts`: enabled checks, semantic targeting, sensitive-action approval and fresh screenshots on recoverable failures. Recovery returns `ok:false`; it does not silently replay input.
- `src/main/voice/textAgent.ts`: desktop requests use the existing persistent agent, real screenshot parts, a serialized desktop mission, bounded retries and explicit final verification. Stalled model requests have a 60-second desktop attempt limit and an independent abort guard.
- `src/main/voice/engine.ts`: Live receives screenshots as media rather than data URLs inside JSON tool responses. Direct voice computer calls receive current frames without an extra caption-generation request. Legacy click/type declarations are kept out of new voice sessions. Three computer failures close the voice session and stop queued/native input; successful observations cannot reset the failure counter.
- `src/main/computer/failureBudget.ts`: the same three-failure cutoff is used by the persistent desktop agent. `inputQueue.ts` bounds and serializes actual input; stop discards queued operations and cancels active native work.
- `src/main/desktop/index.ts` and `src/renderer/src/pages/Computer.tsx`: Computer-page tasks route into the existing persistent executor; existing events, task views, permission cards and stop controls remain connected.
- Existing SWARM computer/remote execution retains its provider integration and uses the shared native drawing/serialization infrastructure.

## Execution loop

Observe an actual desktop screenshot and accessibility controls → plan the next action → validate its current frame, window, topology and input revision → resolve its semantic target or map screenshot pixels to physical desktop coordinates → execute native input → capture again → continue or recover. A successful SendInput call reports input delivery only. Completion requires an explicit visible postcondition; it is not inferred from an accepted click.

Accessibility activation remains available to existing tools. The computer tool now uses accessibility for locating click targets and actual Windows down/up events for their activation, with visible cursor movement. A changed or covered target is rejected instead of clicking its previous location.

## Drawing

Freeform strokes are arrays of arbitrary points, independent of shape templates. Geometry simplification and speed-aware interpolation retain endpoints and corners. A single persistent native request executes a stroke collection, avoiding a process, network connection, screenshot or model call per point. MOVE_NOCOALESCE preserves intermediate mouse positions; Unicode input uses atomic down/up batches. Finally blocks release held buttons on failure, cancellation and focus loss.

Latest complete native run (125 Hz requested, 2400 px/s maximum):

| Path | Elapsed | Samples/s | Cursor endpoint error | Maximum observed deviation |
|---|---:|---:|---:|---:|
| Line | 404 ms | 89 | 0 px | <0.001 px |
| Circle | 987 ms | 96 | 0 px | 0.64 px |
| Spiral | 1400 ms | 97 | 0 px | 0.65 px |
| Irregular | 1053 ms | 96 | 0 px | 0.58 px |
| Separate strokes | 1350 ms | 95 | 0 px | 0.64 px (first stroke) |

Main-process and renderer heartbeats continued. Smooth cursor movement reached its target with zero measured endpoint error; cancellation took 19 ms in the latest complete run. Drawing cancellation plus the test's 50 ms cleanup observation took 75 ms.

There is no valid before/after native freeform speedup baseline. Raw nut-js submission of unpaced points is not comparable to paced, geometry-preserving drawing and is not presented as a speedup.

## Actual verification

- Root regression suite: 242 passed, 8 skipped, excluding the wake-audio fixture file. This includes actual voice-handler tests for the three-failure cutoff and screenshot/media transport.
- Backend suite: 16 passed. Root and backend typechecks passed; production application and backend builds passed.
- Latest complete native desktop run: all 17 checks passed. These cover captured-pixel clicks, double/right clicks, scrolling, Unicode and shortcuts, accessibility lookup, smooth real cursor movement, emergency stop, window management, dialogs, single-use frame rejection, five drawing workloads, focus recovery and active-stroke interruption.
- Installed Brave with a disposable profile: passed. The actual page received 22 trusted mouse moves, exactly one mouse-down, one mouse-up and one click; its visible result changed. Movement took 312 ms. Playwright created the fixture and read assertions; the click came from ZVYRA's Windows input engine.
- Earlier native runs exposed duplicate mouse-up, modal hit-testing and fixture-cleanup failures; these were fixed and the complete native suite rerun successfully. Some interrupted drawing runs were stopped by the cursor-displacement guard; these are not counted as successful runs.
- The long live-model review task did not finish: one run hit its task deadline; other attempts encountered HTTP 429 quota errors or ended without a completion report. The runner now fails if Electron exits without reporting results. No full AI workflow is claimed verified.
- The optional Notepad check failed before input because no visible matching Notepad window appeared. It does not establish that Notepad editing works in this environment.
- A previous unrestricted root run had five wake-audio timeouts. Those tests are excluded from the regression command below and remain an unrelated unresolved check.

Artifacts: `.publish-proof/computer/native-final-results.json`, `real-browser-result.json`, `real-browser-click.png`, native drawing captures and local check logs. Desktop captures can contain private screen content; the artifacts are local and ignored by Git.

## Limits

Real hardware tested: one 1920×1080 monitor at 100% scaling. Mixed DPI, crop mapping and negative monitor offsets have synthetic coverage, not physical multi-monitor verification. Arbitrary applications, secure desktops, elevated windows, custom accessibility providers and application-specific input throughput remain variable. CAPTCHA/MFA and authentication fields require the user. The requested @Computer plugin controls were unavailable in this chat; typing the task into the installed UI using that plugin was not performed.

The development watcher was also restarting a separate `electron.exe .` instance while an installed copy was being updated. It was stopped so the rebuilt installed application can be tested consistently. Provider quota errors remain external execution blockers and must not be reported as completed work.

## Commands

```powershell
# Installed app
& "$env:LOCALAPPDATA\Programs\ZVYRA\ZVYRA.exe"
# Development
npm run dev
# Production package
npm run dist
# Checks
npm run typecheck
npm --prefix backend run typecheck
$env:CI='1'
npx vitest run --exclude tests/voice/wake.audio.test.ts
npm --prefix backend test
# Real desktop input/drawing (uses the mouse and keyboard)
node scripts/computer-check.mjs
# Real browser physical click
$env:ZVYRA_REAL_BROWSER_ONLY='1'
node scripts/computer-check.mjs
Remove-Item Env:ZVYRA_REAL_BROWSER_ONLY
# Optional AI screen task, requires the saved Gemini key and available quota
$env:ZVYRA_LIVE_AGENT='1'
$env:ZVYRA_LIVE_ONLY='1'
$env:ZVYRA_SCREEN_SMOKE='1'
node scripts/computer-check.mjs
```

Live test modes should run separately, with other mouse/keyboard activity paused. Moving the physical mouse during a native stroke intentionally cancels it. The optional full review omits `ZVYRA_SCREEN_SMOKE`; the optional Notepad check uses `ZVYRA_REAL_APP_ONLY=1` instead of other test modes.
