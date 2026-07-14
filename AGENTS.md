# bettersuno-mcp — Agent Guide

## Build & Run
- `npm start` or `node src/index.js` — starts the MCP server (stdio).
- `npm test` — runs integration tests against a mock Suno API.
- No build step needed (pure ESM Node.js).

## Architecture
| File | Role |
|------|------|
| `src/index.js` | Entry point: registers all 59 tools across 12 modules, starts stdio transport. |
| `src/suno-client.js` | HTTP client wrapping Suno's `studio-api.prod.suno.com` — GET/POST helpers with 429 backoff and 401 token refresh. |
| `src/ws-bridge.js` | WebSocket server on `127.0.0.1:9423` — receives auth token, captcha tokens, and extension responses from the BetterSuno extension. |
| `src/auth.js` | Ownership gate — `assertOwned`, `assertCanCover`, `fetchClip` helpers. |
| `src/config.js` | Env-based configuration (port, base URL, timeouts). |
| `src/tools/*.js` | One module per tool category; each exports `register*Tools(allTools)`. |

## Browser dependency
This server **requires** the [BetterSuno browser extension](https://github.com/MrDoe/SunoNotifications) at runtime:
- The extension supplies the Clerk auth token over WS (`ws://127.0.0.1:9423`).
- The extension solves Turnstile captchas when Suno requires them.
- Playback commands relay through the extension to the suno.com tab.
- Prompt library tools read/write the extension's IndexedDB.

## Token flow
1. Extension gets a Bearer token via `window.Clerk.session.getToken()` in a live `suno.com` tab.
2. Extension connects to `ws://127.0.0.1:9423`, waits for `auth_ready`, then sends `{type:"auth", token}`.
3. `ws-bridge.js` stores the token. `suno-client.js` uses it for all API calls.
4. Token cached 45 min, refreshed by extension alarm, re-pushed to WS on refresh.

## Generation semantics
- Pre-call `POST /api/c/check` with `{ctype:"generation"}` — if `required:true`, MCP requests Turnstile solve from extension.
- `token:null, token_provider:null` required in generation payload (else 422).
- Mode switch: `gpt_description_prompt` empty → Custom mode (uses `prompt` lyrics); non-empty → Inspiration mode (auto-lyrics).
- Sliders in `metadata.control_sliders` (`style_weight`, `weirdness_constraint`, `audio_weight`, 0–1) + `metadata.can_control_sliders` array.

## Ownership gate
- `auth.js` `assertOwned`: download/metadata/delete throw for non-owned songs.
- `cover`/`extend`/`mashup` use `assertCanCover` (other artists allowed only if `metadata.can_remix`).
- `like_song` is open (no ownership check).
- `explore_feed`: public read-only; downloading/saving cover art blocked by ownership gate.

## Key gotchas
- **Comments opt-in**: throw unless started with `MCP_ALLOW_COMMENTS=true`.
- **Prompts**: stored in extension's IndexedDB; relayed via WS `extension_request`/`response`. Needs extension connected.
- **Search**: `POST /api/search/` with `search_queries` and `search_type` (song/user/playlist). GET variants return 405.
- **429 retry**: exponential backoff 1s→30s, 5 retries. 401 → token auto-refreshed.
- **Playback**: works for ANY song. MCP→WS→extension→suno tab player.
