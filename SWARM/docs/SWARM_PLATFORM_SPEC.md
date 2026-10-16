# SWARM cross-platform spec (BYOK onboarding, routing, design tokens)

This is the shared contract for Windows desktop (Electron, repo root), web (`swarm-ai-website-design`, Next.js) and Android (`app/`, Kotlin/Compose). Each platform implements it natively. Do not copy layouts across platforms; keep terminology, states and tokens identical.

## 1. Provider catalog

| id | Display name | Key page (open externally) | API base | Auth header | Auth check (no spend) | Discovery |
|---|---|---|---|---|---|---|
| `google` | Google AI Studio | https://aistudio.google.com/apikey | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key: KEY` | `GET /models?pageSize=200` | same; keep models whose `supportedGenerationMethods` include `generateContent`; chat via `POST /openai/chat/completions` (Bearer KEY) |
| `groq` | Groq | https://console.groq.com/keys | `https://api.groq.com/openai/v1` | `Authorization: Bearer KEY` | `GET /models` | same; drop `active:false`, whisper/tts/guard models |
| `mistral` | Mistral AI | https://console.mistral.ai/ | `https://api.mistral.ai/v1` | Bearer | `GET /models` | same; keep `capabilities.completion_chat` |
| `huggingface` | Hugging Face | https://huggingface.co/settings/tokens | `https://router.huggingface.co/v1` | Bearer | `GET https://huggingface.co/api/whoami-v2` | `GET /models` |
| `nvidia` | NVIDIA NIM | https://build.nvidia.com/ | `https://integrate.api.nvidia.com/v1` | Bearer | none public (models list is public) → usability chat is the auth proof | `GET /models` |
| `openrouter` | OpenRouter | https://openrouter.ai/keys | `https://openrouter.ai/api/v1` | Bearer | `GET /key` (returns limit/usage; `is_free_tier` when present) | `GET /models` (public); free when `pricing.prompt` and `pricing.completion` are `"0"`; skip `openrouter/auto` |

Rules:
- Key-page URLs are a hard-coded allowlist. Never open a URL derived from user input for this purpose.
- Key format hints are soft warnings only (never block saving): google `AIza…`, groq `gsk_…`, huggingface `hf_…`, nvidia `nvapi-…`, openrouter `sk-or-…`, mistral (no fixed prefix). Format checks never prove authentication.
- Hugging Face fine-grained tokens need the "Make calls to Inference Providers" permission. Explain this on auth/permission failures; never ask for write scopes.
- Free-tier claims: only OpenRouter exposes per-model price data. Everything else is `unknown` unless the provider API reports it. Display "Provider advertises a free tier — limits apply" only as provider notes, never as a guarantee. Never invent prices, context windows or capabilities: show context/tool support only when returned by the provider API.

## 2. Connection status vocabulary (identical labels on all platforms)

| code | Label | When |
|---|---|---|
| `not_connected` | Not connected | no key stored |
| `needs_configuration` | Needs configuration | key stored but never tested, or test inputs missing |
| `checking` | Checking connection | test in progress |
| `connected` | Connected | auth check passed AND at least one tiny chat request succeeded |
| `auth_failed` | Authentication failed | 401/403, or 400 with `API_KEY_INVALID` / "API key not valid" (Gemini), or HF whoami 401 |
| `rate_limited` | Rate limited | 429, or quota exhaustion (`insufficient_quota`, `limit: 0`, 402) — show Retry-After when known |
| `no_models` | No compatible models available | auth ok but discovery returned zero chat models, or every usability probe returned not_found/unsupported |
| `network_error` | Network error | DNS/TLS/timeout/5xx — "Check your connection and retry" |

Never show `connected` because a key was entered or because an endpoint responded. `connected` requires a successful completion.

## 3. Connection test algorithm

1. Auth check (table above). Map failures with the classification in §2. Stop on auth failure.
2. Discovery. Zero chat models → `no_models`.
3. Usability probe: one chat completion, `messages=[{role:"user",content:"Reply with OK."}]`, `max_tokens: 8`, `temperature: 0`, no project data, 20 s timeout. Candidate order: free models first (OpenRouter `:free`), then names containing `flash|mini|small|instant|8b|lite`, then others. Try at most 3 candidates; move to the next only on `not_found`/`unsupported`/`bad_request`. Stop immediately on auth/rate-limit/quota.
4. Result: `{ status, models: n, usableModel, latencyMs, checkedAt, message }`. The UI tells the user that the test sends one tiny request (about 10 tokens) which may count toward provider quota.
5. Errors shown to users never contain the key or raw upstream bodies; truncate provider messages to 200 chars and strip anything key-shaped.

## 4. Credential storage

| Platform | Store | Notes |
|---|---|---|
| Windows | Electron `safeStorage` (DPAPI, per Windows user) → `secrets` table in `%APPDATA%/SWARM/swarm.db` | keys never cross IPC to the renderer; renderer only receives `••••last4` |
| Web | AES-256-GCM per owner (`lib/server/user-credentials.ts`), master key `SWARM_ENCRYPTION_KEY` (32 bytes base64) server-side only; AAD = `[owner, provider]` | the client never receives a stored key; the hint (last 4) is stored at write time beside the ciphertext |
| Android | Android Keystore AES-256-GCM key (non-exportable), ciphertext in private SharedPreferences, `allowBackup=false` | hint stored separately |

All platforms: replace, remove (disconnect) and re-test actions; no logging of keys; registered secrets are redacted from logs.

## 5. Onboarding flow (6 steps)

1. Welcome — real SWARM logo, headline "Meet Your New AI Development Partner.", one-paragraph description, step indicator, primary "Get Started", secondary "Configure Later" (enters a limited workspace that clearly says no model is configured).
2. Choose providers — 6 cards (name, short description, status label, Connect/Configure, Get API Key). Multi-select; none required.
3. Connect provider — instructions, "Open key page" (external browser), password field with show/hide, paste, clear, soft format hint, Test Connection, Save, Back (keeps progress).
4. Test all — per-provider result rows with Retry.
5. Intelligence configuration — `recommended` | `best_coding` | `fast` | `free_first` | `custom`. Show discovered models with provider, id, context (only if reported), free status (`free` / `paid` / `unknown`).
6. Finish — summary (connected providers, primary model or "Automatic", fallbacks, gaps) and "Launch Swarm". Persist completion; Settings → Providers → "Run setup again".

Copy used verbatim on every platform:
- Headline: "Meet Your New AI Development Partner."
- Description: "Swarm plans, edits, runs and verifies real software projects using the AI providers you choose. Your keys stay on this device (or in your encrypted account vault on the web)."
- Test note: "Testing sends one tiny request (about 10 tokens). It may count toward your provider quota."

## 6. Routing contract

- Profiles: `recommended` (quality-weighted, any provider), `best_coding` (coding capability first), `fast` (lowest measured latency), `free_first` (only models with verified `free`/`free_tier`/`local` status; if none, ask before using unknown-price models), `custom` (user-ordered primary + fallbacks).
- Roles: `planner`, `coder`, `fast` (classification), `reviewer`, `summarizer`. Each role can pin a model; unset roles use the profile.
- Fallback: ordered list. Transient (`rate_limit` with short Retry-After, `timeout`, `server`, `network`) → one bounded retry with backoff (≤ 2 s, jitter) then next model; `auth`/`quota` → skip the whole provider for this request and mark it; `bad_request`/`context` → do not replay the same request on the same model. Hard cap: `maxFallbacks` (default 6). Surface every downgrade to the user ("Switched from X to Y because X was rate limited"). Never attribute output to a model that did not produce it.

## 7. Design tokens (dark default)

| token | value | use |
|---|---|---|
| bg | `#0B0F15` | app background |
| panel | `#0F141B` | sidebars, cards |
| raised | `#151B24` | inputs, popovers |
| sunken | `#0D1218` | code, terminal |
| hover | `#1A222D` | hover/pressed |
| line | `#1E2631` | borders |
| line-strong | `#2B3542` | focused borders |
| fg | `#E9EEF5` | primary text |
| fg-2 | `#A3AEBD` | secondary text |
| fg-3 | `#6F7B8C` | tertiary text (not for body copy) |
| accent | `#4D9FFF` | primary action, focus, selection |
| accent-fg | `#06101F` | text on accent |
| accent-soft | `#11243D` | selected background |
| ok / ok-soft | `#3CCF80` / `#10261B` | connected |
| warn / warn-soft | `#E7A73C` / `#2A2112` | rate limited, needs configuration |
| err / err-soft | `#F26A6A` / `#2D1719` | auth failed, errors |
| info | `#6AADFF` | checking |

Light theme (desktop/web only) keeps the existing light tokens. Typography: Inter (web/desktop), system Roboto/Inter on Android; mono Cascadia/JetBrains. Radii 6/10/14/18. Spacing 4-pt grid. Motion 120–200 ms ease-out, honour reduced-motion. Focus ring: 2 px accent at 35% alpha.
