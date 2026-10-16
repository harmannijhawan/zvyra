# ZVYRA

Windows-first personal AI agent: a persistent Dynamic Island with an animated companion, a full desktop app, and a SWARM-backed agent runtime.

Website: https://zvyra.org · [Windows downloads](https://github.com/harmannijhawan/zvyra/releases/tag/v0.1.0-windows) · [macOS builds](https://github.com/harmannijhawan/zvyra/actions/workflows/build-mac.yml)

This repository includes the Electron desktop app (`src/`), backend (`backend/`), embedded SWARM runtime (`SWARM/`), Vite website (`website/`), and Capacitor iOS preview source (`ios-app/`). Generated dependencies, local data, credentials, and build output are excluded from Git; installers are distributed through Releases.

## Website deployment

Import this repository into Vercel and set **Root Directory** to `website`, framework to **Vite**, and Node.js to **24.x**. The website uses GitHub Releases for downloads. Run `npm --prefix website ci` and `npm --prefix website run build` locally.

## Platform releases

- Windows: `npm ci`, `npm --prefix backend ci`, then `npm run dist` produces `release/ZVYRA-Setup-0.1.0.exe`.
- macOS: the `Build and release macOS` workflow builds native Apple Silicon and Intel DMG/ZIP packages. Push a tag ending in `-macos` to publish a preview release. Builds are unsigned and not notarized.
- iOS: `ios-app/` currently runs the UI against an in-memory preview adapter. It is not a full desktop runtime or a signed iPhone installer. Build on macOS using Xcode and an Apple Developer account to distribute via TestFlight or the App Store.

This repository is built by two collaborators against one typed contract — see **[docs/CONTRACT.md](docs/CONTRACT.md)** for file ownership, transport and rules.

- **UI / window shell (Kiro):** `src/renderer/**`, `src/main/shell/**`, `src/main/mock/**`
- **Backend (Astra):** `backend/**`, `SWARM/**`, `src/main/backend/**` — notes in `docs/ZVYRA-INTEGRATION-CONTRACT.md`
- **Shared:** `src/shared/**`, `src/preload/**`, `src/main/index.ts`, `src/main/ipc.ts`

## Run it

```powershell
npm install
npm --prefix backend install; npm --prefix backend run build   # builds backend/dist/ui.cjs (Astra)
npm run dev          # Electron + Vite dev server, real backend
npm run dev:mock     # same UI against the clearly-labelled preview adapter
npm run build        # production bundles in out/
npm start            # run the production build
```

If the backend bundle is missing or fails to start, the shell falls back to the preview adapter and shows a persistent “Preview backend” banner with the reason. The preview adapter never touches the OS, reports no models, and labels every simulated reply and task.

## Verify

```powershell
npm run typecheck    # main + preload + renderer (strict)
npm test             # vitest: companion state machine, event reducer, island geometry,
                     # tray icon raster, contract whitelists, preview-backend lifecycle
```

Visual QA (dev only): set `ZVYRA_QA_CAPTURE=<folder>` (optional `ZVYRA_QA_ROUTES=home,chat,...`) and run `node_modules\electron\dist\electron.exe . [--mock-backend]`. The shell captures each route and every island mode to PNG, then quits. With `--mock-backend` it also drives one simulated task through planning → approval.

## Using ZVYRA

- **Dynamic Island** — always-on-top pill. Drag by the Z mark. Click the companion to expand, the waveform to push-to-talk, `—` for the mini island, `×` to hide (ZVYRA keeps running in the tray). Esc collapses.
- **Tray** — open, show/hide island, wake word toggle, stop all tasks, settings, **Quit ZVYRA**.
- **Global shortcuts** (Settings → Keyboard shortcuts): `Ctrl+Alt+Space` push-to-talk, `Ctrl+Alt+Z` toggle island, `Ctrl+Alt+O` open ZVYRA, `Ctrl+Alt+Backspace` emergency stop.
- **In-app:** `Ctrl+1…9` sections, `Ctrl+,` settings.

## Setup you provide

- **SWARM provider key** — Settings → SWARM & models → choose a provider, paste the key, **Test connection**, then **Discover** models.
- **Windows speech** — the backend uses local Windows System.Speech; install a desktop speech language and allow microphone access (Settings → Voice shows readiness).
- **Calls** — only available when the backend exposes a provider (Settings → Notifications & calls).
