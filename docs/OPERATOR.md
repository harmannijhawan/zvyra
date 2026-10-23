# ZVYRA operator capabilities

What the agent can do on this PC, how it was verified, and what it cannot do. UI unchanged except the Stay-awake help text/default; new work shows up through the existing Dynamic Island tool cards, approval cards (`PermissionCard`) and Tasks steps.

## Capabilities

| Area | Where | What it does |
|---|---|---|
| Research | `src/main/research/` | Finds the official site (search → search-grounded Gemini when a key exists → Wikidata P856 → direct domain navigation, each confirmed by the page title), reads home/menu/contact/about/product pages, renders JavaScript pages in a hidden sandboxed window, reads public listings and Wikipedia's summary API. Extracts JSON-LD (LocalBusiness/Restaurant/Menu/Product), tel/mailto/WhatsApp links, labelled phones, addresses, hours, menu lines with prices, images, brand colours. Every fact keeps URL + retrieval time + confidence; conflicts are listed; missing fields are listed as unavailable. Honours robots.txt, identifies as `ZVYRA-Research`, reports 401/403/429/CAPTCHA/login walls instead of bypassing them. |
| Images | `research/assets.ts` | Downloads the dossier's images (official first), validates bytes and dimensions, rejects scripted SVG, de-duplicates, writes `assets/CREDITS.json` with source and rights note, captions each photo with vision (so merchandise isn't used as a food hero). Optional Openverse stock, labelled as stock with licence + attribution. |
| Design | `agent/designBrief.ts` | Category-specific direction (17 categories): fonts, contrast-checked colour tokens from brand colours, section plan, imagery/motion rules, conversion goal, content rules for missing data. |
| Website QA | `agent/siteCheck.ts`, `agent/staticServer.ts` | Serves the site on `127.0.0.1`, loads it at 1440px and 390px: console errors, failed requests, broken images and internal links, sideways scroll, tap targets under 24px, low contrast (text over photos is left to the visual review), title/description/viewport/lang/h1, alt text, empty links, unlabeled fields, placeholder content. Full-page screenshots plus an optional vision design review. If the agent stops while issues remain, its reply lists them. `node scripts/site-check.mjs <folder|url>` runs the same checks from a terminal. |
| Screen + desktop | `tools/uia.ts` | Active window, browser address-bar URL, all monitors with scaling, visible controls by accessible name; click/type by name (Invoke/Toggle/Select first, a click at the element's centre only as a fallback), read-back for verification. Per-monitor DPI aware. |
| Browser | `tools/browserAgent.ts` | Visible Edge/Chrome with ZVYRA's own profile. Snapshot with fresh DOM refs, click, type with read-back, scroll, tabs, downloads. Detects login/CAPTCHA/paywall. Never types passwords. Submit/pay/order/send/delete clicks and program downloads need approval. |
| Leads | `desktop/leads.ts` | Local `leads.json`. Duplicates are merged by website, phone or name + location. A contact is only stored with the URL it was verified from. Status pipeline and follow-ups; `do_not_contact` is enforced. Interactions are logged only by the tools that performed them, with a verified flag. |
| WhatsApp / e-mail | `tools/whatsapp.ts` | Opens the chat with a draft through the official `whatsapp://send` link (nothing is sent). Send: approval of the exact recipient + text, then Enter, then a check that the compose box emptied (`sent_verified` / `sent_unverified` / `not_sent`). Call: approval, then WhatsApp's own call button through UI Automation; this reports that the call screen opened, never that someone answered. E-mail opens a `mailto:` draft. |
| WhatsApp by name | `tools/whatsappVision.ts` | “Call/message Manan”: WhatsApp's WinUI window exposes no accessibility tree, so ZVYRA searches the chat list by keyboard, finds the row and the chat header from screenshots (Gemini vision), confirms the header matches the name, asks approval, then clicks the call button / types and sends, and checks the result from a fresh screenshot. |
| Assisted calls | `voice/callAgent.ts` | ZVYRA talks on the WhatsApp call as the user's AI assistant: the other person's voice is captured from system audio (loopback), Gemini Live answers, and its voice plays into the **VB-CABLE** “CABLE Input” device, which WhatsApp uses as its microphone (“CABLE Output”). Introduces itself as an AI assistant, sticks to the approved goal, makes no commitments, hangs up via the end-call button, 10-minute cap, ends after ~75 s with no speech, Stop all ends it. The wake word is paused during the call. The route is checked before dialling (`node scripts/call-audio-check.mjs`). |
| Approvals | `desktop/actionApprovals.ts` | Messages, calls, risky clicks and form submits wait for the user. Each approval is bound to a fingerprint of the exact payload, is never auto-approved (Bypass mode only applies to shell commands), expires after 5 minutes, and Stop all denies it. |
| Agent | `voice/textAgent.ts`, `voice/operatorTools.ts` | `update_plan` shows live plan steps in Tasks; steps that never started finish as "skipped", not "done". Web/app text is returned as `page_text_untrusted` alongside a do-not-follow notice. `control_tasks` lets voice cancel running work. |
| Paths | `desktop/pathPolicy.ts` | Any drive or folder the user names, spaces included. Refused: writes into Windows/Program Files/ProgramData, other users' profiles, a bare drive root. Real fs errors (EPERM, EBUSY, EROFS…) are explained. ZVYRA never creates a `ZVYRA Projects` folder; the legacy folder is used only if it already exists. Otherwise the agent asks where to work. |
| Wake word | `voice/wakeGate.ts`, `voice/engine.ts` | Detection is separate from the wake decision. Wakes need a pause before the phrase. Look-alikes are refused at normal sensitivity. Voice-sample limits are calibrated on the user's own recordings. After repeated false wakes the room counts as noisy and the gate gets stricter. ZVYRA's own echo and repeated wake phrases are ignored. No positive learning from speech that follows a wake. Gemini proactive audio plus an addressee rule keep the session silent for conversations not aimed at it. Stay-awake is off by default and falls back to the idle timeout when proactive audio is unavailable. Server goAway is followed by a resumed session. |

## Verified on this PC (2026-10-18)

- `npm run typecheck` clean; `npx vitest run`: 195 passed, 4 opt-in live suites skipped by default.
- Wake word on real audio: Windows speech renders "Hey Zyra", repeated wakes, the phrase mid-sentence, conversation, a TV-news read, the name alone and a look-alike. These run through the real on-device spotter and the app's gate. Results: the wake fires once, everything else stays silent, at sensitivity 0.6 and 0.8. The user's own 5 samples are all accepted (leave-one-out). Of 3 unlabelled past "false wake" clips, 1 is still accepted on voice alone (see limitations).
- Live research: Swiggy (official site + Wikipedia summary; CAPTCHA pages recorded, not bypassed). Katz's Delicatessen with search engines returning poisoned results: official site found via Wikidata, real phone, 20 menu items with real prices, hours.
- End-to-end through the real app (isolated profile, the user's Gemini key): "research Katz's Delicatessen, build a premium site, test it, draft a WhatsApp message". It researched, downloaded 5 real photos with credits, generated the site, ran 5 QA/fix rounds and drafted the message. Every price on the page matched the dossier. That run exposed QA false positives, a merchandise photo used as the hero, an add-on price read as an item price and an overclaimed "QA complete". All four are fixed and covered by tests.
- UI Automation: foreground window and bounds read live. WhatsApp's WinUI window exposes only caption buttons while it is in the background (see limitations).
- Browser agent: headless run on installed Edge against a local page covering refs, typed read-back, submit gating (denied then approved), password refusal, login detection and navigation.

## Not done / limitations

- **Local models (Ollama) and offline STT/TTS (Whisper/Piper via the bundled `sherpa-onnx-node`)** are not implemented. The agent and voice conversation need a Gemini API key, which is free (Google AI Studio, no payment) but rate-limited: this PC hit 429 quota errors during testing and fell back to lighter models. Wake-word detection is fully local.
- **Keyless web search is unreliable from automated clients.** DuckDuckGo answers with an anti-bot page and Bing returns unrelated results. Research therefore relies on Wikidata, direct domain checks and (with a key) Google-grounded discovery.
- **WhatsApp:** sending and calling depend on WhatsApp exposing its compose box and call button to UI Automation. When it doesn't, sends are reported as `sent_unverified` and calls as "call button not found". Not exercised against a real chat (that would have messaged someone). A number needs a country code unless `ZVYRA_DEFAULT_COUNTRY_CODE` is set.
- **Wake word:** template matching (MFCC + DTW) can't separate every look-alike. Recording voice samples (Settings → Voice) and the noisy-room mode reduce this, and false wakes become negatives. Speaker verification is not implemented.
- Text heuristics for menus, addresses and hours are marked low confidence. Sites that build menus as images or PDFs give no menu.
- No publishing or deployment tool. Calendar integrations are not implemented.
- The Leads screen has no UI yet; leads are managed by asking ZVYRA (`lead_list`, `lead_update`).

## Opt-in live checks

```powershell
$env:ZVYRA_LIVE='1'; $env:ZVYRA_LIVE_NAME='Katz''s Delicatessen'; $env:ZVYRA_LIVE_WHERE='New York'; npx vitest run tests/research/research.live.test.ts
$env:ZVYRA_WAKE_DIR="$env:APPDATA\ZVYRA\desktop\voice"; npx vitest run tests/voice/wake.audio.test.ts
$env:ZVYRA_LIVE_UIA='1'; npx vitest run tests/shell/uia.live.test.ts
$env:ZVYRA_LIVE_BROWSER='1'; npx vitest run tests/shell/browserAgent.live.test.ts
node scripts/site-check.mjs path\to\site
```
