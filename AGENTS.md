# bettersuno-mcp — Agent Guide

## Build & Run
- `npm start` or `node src/index.js` — starts the MCP server (stdio).
- `npm test` — runs integration tests against a mock Suno API via Node's built-in test runner (`node --test`).
- No build/lint/typecheck step (pure ESM, no linter or formatter configured).

## Architecture
| File | Role |
|------|------|
| `src/index.js` | Entry point: imports 12 tool modules, starts WS bridge, connects stdio transport. |
| `src/suno-client.js` | HTTP client wrapping `studio-api.prod.suno.com` — GET/POST/PATCH/DELETE with 429 exponential backoff (1s→30s, 5 retries) and 401 pass-through (no auto-refresh, extension re-pushes). |
| `src/ws-bridge.js` | WebSocket server on `127.0.0.1:9423` — receives auth token, captcha tokens, and `extension_request`/`response` round-trips from the BetterSuno extension. |
| `src/auth.js` | Ownership gate — `assertOwned`, `assertCanCover`, `fetchClip` helpers. Caches `_currentUser`. |
| `src/config.js` | Env-based configuration (`MCP_WS_PORT`, `MCP_API_BASE_URL`, `MCP_ALLOW_COMMENTS`, `MCP_WS_TIMEOUT`). |
| `src/tools/*.js` | 12 modules, each exports `register*Tools(server, allTools)` or `register*Tools(allTools)`. |

## Browser dependency
Server **requires** the [BetterSuno extension](https://github.com/MrDoe/SunoNotifications) at runtime:
- Supplies Clerk auth token over WS (`ws://127.0.0.1:9423`).
- Solves Turnstile captchas when Suno requires them.
- Playback commands relay through extension to suno.com tab.
- Prompt library tools read/write the extension's IndexedDB via WS `extension_request`/`response` round-trips.

## Token flow
1. Extension gets Bearer token via `window.Clerk.session.getToken()` from a `suno.com` tab.
2. Extension connects to `ws://127.0.0.1:9423`, receives `{type:"auth_ready"}`, sends `{type:"auth", token}`.
3. Token is cached in memory (no refresh logic in MCP server; extension re-pushes on 401 or alarm).
4. Any WS connection re-push updates the token — no disconnect penalty.

## Generation semantics
- Pre-call `POST /api/c/check` with `{ctype:"generation"}`. If `required:true`, MCP sends `captcha_required` to extension and waits for `captcha_token` response.
- `token:null, token_provider:null` required in generation payload (else 422).
- **`params: {}` required** in `POST /api/generate/v2-web/` bodies (else 500/422 "We couldn't verify your request" / `token_validation_failed`). All generation payloads in `src/tools/generation.js` carry it; `suno-client.generate()` injects `params: payload.params ?? {}` as a safety net. (2026-08: Suno added this field.)
- **Captcha sitekey**: Suno's generation Turnstile sitekey is `NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY_GEN` embedded in a `suno.com/_next/static/chunks/*.js` bundle (pattern `...SITE_KEY_GEN||"0x4AAAA..."`). Do NOT hardcode Cloudflare's test key (`0x4AAA...AAAQAAA`) — Suno rejects those tokens. The extension discovers the real key dynamically; see BetterSuno AGENTS.md.
- Mode switch: `gpt_description_prompt` empty + `prompt` set → Custom mode (lyrics provided). `gpt_description_prompt` set + `prompt` empty → Inspiration mode (auto-lyrics).
- Sliders: `metadata.control_sliders` (`weirdness_constraint`, `style_weight`, `audio_weight`, 0–1) + `metadata.can_control_sliders`. Input 0–100, converted to 0.0–1.0 internally.
- **Core generation tools** (`create_song`, `inspire_song`, `cover_song`, `extend_song`) support `negative_tags`, control sliders, `persona_id` + `persona_model` (`"voice_persona"` for Vox — **default**, `"style_persona"` for style).
- **Persona linkage needs `task`, NOT `persona_model`**: Suno's backend links a clip to its persona (which makes the GUI show the voice chip via the clip's `persona` object) only when the payload carries the right top-level `task`. `persona_model` is a **fictional field** — the suno.com web client never sends it. The server maps `persona_model` → `task`: Vox → `vox`/`vox_cover`/`vox_extend`; style → `artist_consistency`/`artist_cover`/`artist_extend`. (2026-08: verified against the live web bundle + real API responses.)
- **`mashup_song`**: 2+ clip IDs, asserts `can_remix` on each. **`concat_songs`**: no ownership gate, hits `POST /api/generate/concat/v2/`.
- **Lyrics tools**: `generate_lyrics` (cowrite), `lyrics_infill` (placeholders `[...]`), `lyrics_mashup` (blend two lyrics).
- `create_song`/`inspire_song` try WS relay first (`relay_generate`), fall back to direct API. `cover_song`/`extend_song` go direct.

## Key gotchas
- **Comments opt-in**: all comment tools throw unless `MCP_ALLOW_COMMENTS=true`.
- **Search**: uses `POST /api/search/` (GET returns 405). Filters results to only own songs via `/api/user/me`.
- **Prompts**: stored in extension's IndexedDB; accessed via WS `extension_request`/`response` round-trip. Needs extension connected.
- **Downloads**: `download_song` uses `inferAudioExtension` helper to check `Content-Type` and correct file extension when Suno returns a different format than requested.
- **WAV downloads**: Suno does **not** serve WAV by rewriting the CDN URL (`.mp3`→`.wav` returns 403). Real WAV comes from `GET /api/download/clip/{clip_id}?format=wav`, which returns `{status:"processing"}` then `{status:"ready", download_url}` (poll ≈3s, ≤20 tries) — mirrors the suno.com web client. `download_song` uses this for `format:"wav"`; `m4a` still uses the CDN rewrite. The BetterSuno extension's batch download uses the same endpoint for WAV (`resolveSunoDownloadUrl`).
- **Playback** (`play_song`/`stop_playback`): works for ANY song (no ownership gate). MCP→WS→extension→suno tab player.
- **Edit tools** (`crop_clip`, `fade_clip`, `reverse_clip`, `adjust_speed`): only work on owned clips (`assertOwned`).
- **Auth cache**: `getCurrentUser()` caches result in `_currentUser`. Tests that need fresh per-user state per call must account for this.

## Firefox & browser setup
- Firefox runs with `--marionette --remote-debugging-port 9222` pointing at `https://suno.com/create`.
- Marionette is on port 2828 — the `firefox-devtools` MCP (`@mozilla/firefox-devtools-mcp`) connects to existing instances via `--connectExisting --marionettePort 2828`.
- The firefox-devtools MCP is configured in `~/.config/opencode/opencode.json` but **not** in `opencode.jsonc` — only one config is loaded. `opencode.jsonc` takes precedence. Keep MCP configs in sync between both files or consolidate into one.
- The BetterSuno extension runs inside this Firefox tab, connecting to the MCP server's WS bridge on port 9423.
- firefox-devtools MCP tool names are bare (`list_pages`, `take_snapshot`) when called via MCP JSON-RPC directly; opencode prefixes them (`firefox-devtools_list_pages`).
- A convenience wrapper script lives at `./scripts/use-firefox-mcp.mjs` for direct MCP tool calls without restarting opencode.
- **Never spawn a separate firefox-devtools MCP subprocess** (e.g., via `npx @mozilla/firefox-devtools-mcp`) while opencode already has it configured as an MCP server — this creates a second Marionette session and breaks the existing one. Use the `firefox-devtools_*` tools provided by opencode directly.
- The `firefox-devtools_*` tools use a persistent MCP server process managed by opencode. Each custom subprocess spawn creates a new connection, invalidates UIDs from the prior session, and may leave the page in an inconsistent state.

## Upload semantics
- `upload_audio` now defaults to **fast path** (`initialize_clip: false`). Returns after Steps 1–3 (init → S3 → upload-finish) in ~5s. The old slow path (Steps 4–8, up to 135s) is available via `initialize_clip: true` for backward compat.
- `get_upload_status(upload_id)` — single API call to check processing status (pending/processing/passed_audio_processing/complete).
- `initialize_upload_clip(upload_id, title?)` — calls initialize-clip endpoint + feed diff to find the resulting clip (bounded at 5×3s = 15s). Returns `{ clip_id }`.
- **Agent workflow**: `upload_audio` → loop `get_upload_status` until `passed_audio_processing` → `initialize_upload_clip` → use `clip_id` for further operations.

## Single-instance rule (WS bridge)
- Only **one** bettersuno-mcp server can bind `ws://127.0.0.1:9423` at a time. The extension connects to whoever owns the port.
- Every opencode session spawns its own MCP server; a second session's server will hit `EADDRINUSE` and now **exits with an actionable FATAL message** instead of silently serving broken tools.
- If extension tools report "not connected", a stale instance almost certainly owns the port: `pkill -f bettersuno-mcp` (the running session's server is respawned by opencode on next tool use).
- Avoid registering this server in both `opencode.json` and `opencode.jsonc` — one registration per session is enough.

## Lessons from the field
- **firefox-devtools network capture is unreliable for file uploads**: `list_network_requests` often shows 0 requests despite page activity. S3 presigned-POST uploads (multipart form) may not appear as fetch/XHR requests in the observer.
- **Library page layout**: The `+ Audio` button is in the top-right of the Library page next to the heading. The notifications panel can obscure it — it needs to be dismissed or the user needs to click it directly.
- **Browser session is fragile** — each `navigate_page` call triggers a full SPA reload (Clerk auth, Cloudflare Turnstile, Stripe, etc.) which takes ~6s and resets UI state. Navigating to `suno.com/me` loads the Library but the notification panel stays open.
- Google blocks sign-in in Firefox Marionette dev mode, making it impossible to re-authenticate a disrupted session from the terminal.

## Script stem splitting & SFX sourcing
Workflow used for `2138/log_from_year_2138_track_21_level_five_protocol/` (a Suno vocal-stem production). Generalizable to any drama script.

> **Use the `audio-drama-production` skill** for the end-to-end pipeline (split script → source SFX → map personas → generate per-character tracks → extract vocal stems → download WAV). Load it whenever the user asks to turn a drama script into audio. The sections below are the condensed reference; the skill holds the full workflow + recipes.

### Splitting a script into vocal stems
- Each speaker gets one file named by speaker (e.g. `Female_Mara.md`, `AI_CLIO.md`), containing only their lines in script order, cue markers preserved verbatim. **Never alter dialogue text.**
- No stem file for `[MUSIC]` or `[SFX]` cues.
- Verify the split with a script that compares dialogue lines (lines not starting with `[` or `===`) between the original and the concatenation of all stem files — must match exactly (missing=0, extra=0). See the Node one-liner used during the split.

### Sourcing free sound effects (./sfx)
- Match each `[SFX: ...]` cue to a free sound; one file can cover multiple similar cues.
- **Wikimedia Commons** is the best direct-download source: search via `api.php?action=query&generator=search&gsrsearch=<terms>%20filetype:audio&gsrnamespace=6&prop=imageinfo&iiprop=url|size|mime`. Files are freely licensed with direct `upload.wikimedia.org` URLs.
  - **Rate limits**: rapid queries/downloads hit 429. Space API calls ≥3s apart and file downloads ~15–35s apart. A 429 returns a small HTML page that silently saves as a bogus file — always `ffprobe`-verify downloaded files afterward.
- **Archive.org** is a good fallback and doesn't rate-limit: `advancedsearch.php?q=identifier:freesound*<term>*&fl[]=identifier&fl[]=title&rows=...&output=json`, then metadata via `/metadata/<id>` and files at `/download/<id>/<filename>`. The `freesound_community-*` and `zapsplat_*` items are clean single-effect MP3s.
- **Pixabay** (`pixabay.com/sound-effects/search/...`) is Cloudflare-protected: plain curl gets 403/"Just a moment", the CDN returns `AccessDenied`, and detail pages intermittently 503. Browsing works in the `firefox-devtools` MCP session, but result cards embed no direct audio URLs in the DOM, so it's not a reliable automated download source.
- **SoundBible** tag pages carry little useful structure; skip.
- Verify every download with `ffprobe` (duration) and keep the source's original extension (`.ogg`/`.wav`/`.mp3`). Use a descriptive `kebab-case` filename.
- **Never delete downloaded files** — if a fetch produces a bad/stub file (e.g. a 429 error page), fetch the real audio to a *new* filename and leave the stub in place.

### Starting a fresh Marionette browser session
- The existing Firefox instance must be running with `--marionette --remote-debugging-port 9222` for the firefox-devtools MCP (`--connectExisting --marionettePort 2828`) to connect; without those flags the MCP times out.
- To start one without disturbing an existing session: `firefox --new-instance --marionette --remote-debugging-port 9222 --profile <other-profile> about:blank` (use a profile that isn't locked by the running instance).
- Pixabay detail-page navigation via `navigate_page`/JS `.click()` often times out but the search page loads fine; cookie-consent overlay must be dismissed (`Allow All`) before results render.
- FxA/Sync `NS_ERROR_UNKNOWN_HOST` errors in the log are harmless (offline profile).

### Creating an Ardour session from vocal stems
- **`scripts/create-ardour-project.mjs`** builds a new Ardour project from vocal-stem WAVs with a 3D-audio chain cloned from a working template:
  `stem tracks → Ambisonic bus (16ch, SPARTA AmbiRoomSim) → Headphones bus (16ch, SPARTA AmbiBIN) → Master (2ch)`.
- Usage: `node scripts/create-ardour-project.mjs --stems <dir> --name "Level Five Protocol"` (default output = `./<name>/`; use `--out <dir>` to place elsewhere).
- Default `--pattern '( - Vocals|_final)'` keeps only cleaned vocal stems from a stems folder; override with `--pattern <regex>` (e.g. `--pattern '.'` for all audio).
- Mechanics: `ardour8-new_session` (headless) creates a valid base session; template routes for Headphones/Ambisonic/Audio-track are extracted verbatim from `/home/christoph/Ardour/3d audio/3d audio.ardour`, renumbered, and wired (each stem → `Ambisonic/audio_in N`). Stems are split to mono `%L/%R` into `interchange/<name>/audiofiles/`.
- Validation: the generated session is XML-well-formed and Ardour opens/re-saves it without session errors (verify with a brief `timeout 25 ardour -n -O <session>` run; GUI/audio-backend noise is expected).

## Publishing
- `npm run publish:patch` / `npm run publish:minor` — bumps version, creates git tag, pushes tag (triggers GHA publish workflow).
- GHA runner ships npm 10.x with Node 22; workflow upgrades to npm 11.5.1+ for OIDC trusted publisher compatibility.
- CI runs `npm test` on Node 18/20/22 for all PRs and pushes to `main`.
