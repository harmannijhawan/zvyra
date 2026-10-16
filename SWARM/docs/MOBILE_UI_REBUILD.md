# SWARM mobile UI rebuild

The Android entry point now uses a new Compose companion presentation layer in
`app/src/main/java/com/swarm/ai/ui/companion`. The prototype screens are no longer
reachable from the app navigation.

## Experience

- Connection landing page with camera sheet and manual entry, calling the existing pairing implementation.
- Home with live selected-run counts, vector swarm characters, current model and task activity.
- Build with platform selection, prompt templates, real desktop project/run creation, task timeline, pause/resume/cancel, outputs and file names.
- Chat with desktop conversations, persisted desktop history, response polling/stop, individual run-agent conversations, and an explicit Build handoff.
- All eleven desktop identities, including Vision QA, with status, task, activity and model details.
- Settings with existing disconnect/reconnect functions, model information, persisted motion/haptic preferences and existing local inference settings.
- Safe drawing insets, scrollable content, keyboard-aware composers, saved per-tab UI state and short transitions.

No illustrative activity, generated progress or seeded model availability is used in the companion UI. Screenshot test fixtures are confined to androidTest.

## Existing connection preserved

`RemoteClient.kt`, `RemoteTransport.kt`, `Protocol.kt`, `Security.kt`,
`remote/ui/RemoteViewModel.kt` and `remote/ui/QrScanner.kt` were hash-verified
against the pre-change backup and are unchanged. Connection routing and pairing
behavior were deliberately left alone at the user's request.

`CompanionApi.kt` adds application commands over the existing route, certificate
pin and device signature. The desktop adds authenticated `POST /v1/invoke`, using
the same Gateway validation as its existing WebSocket invoke. Additional allowed
application channels are project creation, desktop Chat, and run-chat history/stop.
Remote project creation strips filesystem paths. Provider keys, settings writes,
terminal and arbitrary file operations remain forbidden. Mutations are not retried
automatically if a response is lost.

The workspace desktop main and renderer are rebuilt. Restart the updated workspace
desktop app for the new Build/Chat endpoints. An older packaged desktop needs these
desktop changes packaged too; its existing pairing still works, but it lacks the
new application endpoint.

## Validation and limits

- Android debug APK builds successfully.
- 63 existing Android unit tests pass.
- 36 desktop bridge, authentication and companion tests pass.
- Desktop TypeScript checking, main build and renderer build pass.
- Instrumented navigation, manual pairing callback/error, platform/build submission,
  message submission, agent conversation, and disconnect confirmation checks pass
  on normal and compact emulator viewports (approximately 411×914 and 320×640 dp).
- Screenshots are saved under `_screenshots/mobile-rebuild/` for visual inspection.
- Real MainActivity cold launch was checked in the emulator.

The connected-screen instrumentation uses isolated test state. A physical-phone
camera pairing and a model-backed desktop build/chat round trip were not exercised.
This repository contains an Android app, not an iOS target.

The Android 17 x86 emulator also displays a pre-existing native-library 16 KB page
compatibility warning (including the existing TFLite library); it runs the app in
compatibility mode. Dependency/native-library migration is outside this UI rebuild.
