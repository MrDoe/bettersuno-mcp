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
- Mode switch: `gpt_description_prompt` empty + `prompt` set → Custom mode (lyrics provided). `gpt_description_prompt` set + `prompt` empty → Inspiration mode (auto-lyrics).
- Sliders: `metadata.control_sliders` (`weirdness_constraint`, `style_weight`, `audio_weight`, 0–1) + `metadata.can_control_sliders`. Input 0–100, converted to 0.0–1.0 internally.
- **Core generation tools** (`create_song`, `inspire_song`, `cover_song`, `extend_song`) support `negative_tags`, control sliders, `persona_id` + `persona_model` (`"voice_persona"` for Vox, `"style_persona"` for style).
- **`mashup_song`**: 2+ clip IDs, asserts `can_remix` on each. **`concat_songs`**: no ownership gate, hits `POST /api/generate/concat/v2/`.
- **Lyrics tools**: `generate_lyrics` (cowrite), `lyrics_infill` (placeholders `[...]`), `lyrics_mashup` (blend two lyrics).
- `create_song`/`inspire_song` try WS relay first (`relay_generate`), fall back to direct API. `cover_song`/`extend_song` go direct.

## Key gotchas
- **Comments opt-in**: all comment tools throw unless `MCP_ALLOW_COMMENTS=true`.
- **Search**: uses `POST /api/search/` (GET returns 405). Filters results to only own songs via `/api/user/me`.
- **Prompts**: stored in extension's IndexedDB; accessed via WS `extension_request`/`response` round-trip. Needs extension connected.
- **Downloads**: `download_song` uses `inferAudioExtension` helper to check `Content-Type` and correct file extension when Suno returns a different format than requested.
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

## Lessons from the field
- **firefox-devtools network capture is unreliable for file uploads**: `list_network_requests` often shows 0 requests despite page activity. S3 presigned-POST uploads (multipart form) may not appear as fetch/XHR requests in the observer.
- **Library page layout**: The `+ Audio` button is in the top-right of the Library page next to the heading. The notifications panel can obscure it — it needs to be dismissed or the user needs to click it directly.
- **Browser session is fragile** — each `navigate_page` call triggers a full SPA reload (Clerk auth, Cloudflare Turnstile, Stripe, etc.) which takes ~6s and resets UI state. Navigating to `suno.com/me` loads the Library but the notification panel stays open.
- Google blocks sign-in in Firefox Marionette dev mode, making it impossible to re-authenticate a disrupted session from the terminal.

## Publishing
- `npm run publish:patch` / `npm run publish:minor` — bumps version, creates git tag, pushes tag (triggers GHA publish workflow).
- GHA runner ships npm 10.x with Node 22; workflow upgrades to npm 11.5.1+ for OIDC trusted publisher compatibility.
- CI runs `npm test` on Node 18/20/22 for all PRs and pushes to `main`.
