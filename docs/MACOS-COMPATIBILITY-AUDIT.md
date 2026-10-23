# macOS compatibility audit — 16 October 2026

**Verdict: the current 0.1.0 macOS preview is not feature complete.** Sharing the Windows app's source and successfully packaging a DMG does not establish macOS feature parity.

## Tests performed

- Downloaded the published ZIP app bundles from `v0.1.0-macos` on native Apple Silicon and Intel GitHub macOS runners. These are companion assets from the same build as the DMGs; mounting a DMG and dragging it into Applications was not tested.
- Both apps stayed running for 25 seconds. Screenshots show the onboarding UI and Dynamic Island on both architectures.
- Both packaged `sherpa-onnx-node` and `@nut-tree-fork/libnut-darwin` libraries loaded successfully on both architectures. Loading a library does not prove microphone capture, wake detection, or input injection.
- No `Backend failed to start` or `Running with the preview backend` messages appeared in the collected output. This is not an end-to-end backend or provider test.
- Local type checks passed. Desktop tests: 49 passed. Backend tests: 16 passed. These local tests ran on Windows and do not establish macOS feature parity.
- Reproducible Mac run: https://github.com/harmannijhawan/zvyra/actions/runs/38919380733
- Test workflow: `.github/workflows/audit-macos.yml`; package checks: `scripts/audit-macos-package.py`. Reports and screenshots are attached to the run as `macos-audit-arm64` and `macos-audit-x64` artifacts.

## Feature assessment

| Feature | Result and evidence |
| --- | --- |
| Launch, onboarding and Dynamic Island | Visually verified on both runner architectures. Interaction through the complete onboarding flow was not tested. |
| Chat, models, research and provider connections | Shared implementation; no live provider key was supplied to runners, so responses, streaming and tools remain unverified on macOS. |
| Gemini Live voice conversation | Main desktop layer uses `VoiceEngine` in `src/main/voice/engine.ts` and browser audio capture in `src/renderer/src/voice/voice.ts`. No Windows-only speech dependency in that primary capture path. Actual microphone, playback, interruptions and provider connection were not tested. |
| Local wake word and personal voice training | Native speech module loads on both architectures; main engine uses `WakeSpotter` plus personal sample matching. No spoken audio or training was tested. Status currently reports wake readiness before actual native/audio initialization. |
| Legacy backend local speech recognition | **Incomplete.** `backend/src/speech.darwin.mjs` reports a recognizer during probe, but its `listen` and `wake` modes wait and return a timeout without capturing/transcribing speech. Main desktop Gemini voice uses a separate engine; this does not mean all voice is broken. |
| Terminal and direct `run_command` tool | **Broken on standard macOS.** `src/main/desktop/terminal.ts` always launches `C:\\Windows/.../powershell.exe`. Opening an external terminal also uses `wt.exe`/`cmd.exe`. Desktop tool host routes direct commands through this service. |
| Volume, mute, play/pause, next/previous | **Broken on macOS.** `src/main/tools/media.ts` uses the Windows PowerShell helper, `user32.dll` and Windows COM audio interfaces. Opening a YouTube/Spotify URL is separate and may work with the default handler. |
| Named app/browser launching | **Incomplete.** `src/main/voice/desktopTools.ts` resolves Windows `.exe` paths and Start Menu shortcuts. `src/main/desktop/apps.ts` uses `where.exe`, `Code.exe` and Windows-only add-app filters. `SWARM/electron/computer/service.ts` also uses Windows executable paths for `open_application`. Default file/URL opening uses Electron's portable shell APIs. |
| Foreground window / open-window integration | **Incomplete.** The desktop `WindowsInfo.active()` returns null and `list()` returns an empty array off Windows. The separate nut-js screenshot observation path attempts its own window inventory; that path needs native testing. |
| Screenshot, mouse, keyboard and remote desktop | Native module loads and contains macOS bindings. Actual capture/input, Retina scaling, multiple displays and permission denial/recovery remain unverified. macOS Accessibility and Screen Recording permission are required for the relevant operations. |
| Accessibility element automation | **Windows-only implementation.** `SWARM/electron/computer/windows.ts` rejects other platforms. This is distinct from coordinate-based input through nut-js. |
| Battery reporting | **Incorrect on Mac laptops.** `src/main/tools/system.ts` skips the battery query unless `win32`, then presents null as `no battery (desktop PC)`. CPU, memory, disk and uptime use portable Node APIs. |
| Files, default browser, clipboard | Portable Node/Electron implementation exists. No full CRUD or clipboard round-trip was run on the Mac packages. |
| Website/app builder and agent tasks | Static HTML file-writing/checking path appears portable, but generated projects and live model requests were not exercised. Command-dependent work is affected by the desktop terminal defect. SWARM's separate command runner uses the host shell, but its agent protocol incorrectly instructs agents that the shell is Windows `cmd.exe`. |
| Memory, projects, knowledge and persistence | Shared database/file implementation; startup produced no observed fallback. Persistence CRUD, restart recovery and database migration were not exercised on Mac. |
| Secure key storage | Uses Electron `safeStorage`; the code is not a direct DPAPI-only implementation, despite Windows-oriented labels. Mac Keychain storage/retrieval still needs testing. |
| Camera / visual questions | Browser capture implementation and usage descriptions exist. Real camera permission, preview, capture and AI image responses were not tested. Intel runner warned about missing Continuity Camera usage configuration; physical Continuity Camera support is unverified. |
| Timers, scheduler, notifications and calls | Shared implementations exist. Notification permissions, resume/sleep behavior, scheduler execution, and Calls are now through WhatsApp Desktop. |
| Tray, shortcuts and launch at login | Menu-bar icon and app UI visible in screenshots. Global shortcut behavior was not exercised. Both runner logs reported permission denial while setting a login item; launch at login is not verified on a user Mac. |
| Installation trust | Current builds are unsigned/not notarized previews. A normal download's Gatekeeper/quarantine flow was not tested. |

## Other observations

The Intel runner logged GPU/EGL initialization errors and GPU-process retries, but its screenshot still showed the rendered app. This may be specific to the hosted runner; it is not sufficient evidence of a physical-Mac GPU defect or of graphics reliability.

## Work required before claiming full macOS support

1. Add macOS implementations for terminal execution, app discovery/launching, media controls, battery and foreground-window integration. Make AI tool descriptions and shell prompts platform-aware.
2. Implement or explicitly disable unsupported legacy speech/accessibility paths; report capabilities from actual availability checks.
3. Run permission-aware end-to-end tests on physical Apple Silicon and Intel Macs with a microphone, camera, speakers, a provider key, native desktop input and realistic displays. Exercise denied permissions and recovery, startup/login, suspend/resume, notifications and secure storage.
4. Validate fresh install/update/uninstall from the DMG and sign/notarize production builds.

This audit added repeatable diagnostics. It did not repair or rebuild the published application.
