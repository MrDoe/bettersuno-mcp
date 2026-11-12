# bettersuno-mcp — Agent Guide

## Build & Run
- `npm start` or `node src/index.js` — starts the MCP server (stdio).
- `npm test` — runs integration tests against a mock Suno API via Node's built-in test runner (`node --test`).
- No build/lint/typecheck step (pure ESM, no linter or formatter configured).

## Architecture
| File | Role |
|------|------|
| `src/index.js` | Entry point: imports 18 tool modules, starts WS bridge, connects stdio transport. Adds MCP `title`/`annotations` to every tool at list time. Also handles the `bettersuno-mcp setup` subcommand (`src/opencode-setup.js`). |
| `src/opencode-setup.js` | Registers the server in an opencode config (`~/.config/opencode/opencode.json[c]` or project `opencode.json[c]`) via JSONC-preserving edits. Used by `setup` and by the npm postinstall. `BETTERSUNO_MCP_SKIP_SETUP=1` opts out, `BETTERSUNO_MCP_CONFIG` overrides the target path. |
| `scripts/postinstall.mjs` | npm postinstall wrapper around `setupOpencodeConfig` — global installs target `~/.config/opencode`, project installs the `INIT_CWD`, dev installs inside this repo are skipped. |
| `src/suno-client.js` | HTTP client wrapping `studio-api.prod.suno.com` — GET/POST/PATCH/DELETE with 429 exponential backoff (1s→30s, 5 retries) and 401 pass-through (no auto-refresh, extension re-pushes). |
| `src/ws-bridge.js` | WebSocket server on `127.0.0.1:9423` — receives auth token, captcha tokens, and `extension_request`/`response` round-trips from the BetterSuno extension. |
| `src/auth.js` | Ownership gate — `assertOwned`, `assertCanCover`, `fetchClip` helpers. Caches `_currentUser`. |
| `src/config.js` | Env-based configuration (`MCP_WS_PORT`, `MCP_API_BASE_URL`, `MCP_ALLOW_COMMENTS`, `MCP_WS_TIMEOUT`). |
| `src/tools/*.js` | 18 modules, each exports `register*Tools(server, allTools)` or `register*Tools(allTools)`. Includes albums, reactions, covers/visuals, notifications, custom models, and lyrics projects. |

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
- Pre-call `POST /api/c/check` with `{ctype:"generation"}`. If `required:true`, MCP sends `captcha_required` (with `captcha_version`) to the extension and waits for `captcha_token`. `captcha_version` is **1 = hCaptcha, 2 = Turnstile**; the extension only solves Turnstile (clear error for hCaptcha).
- `token:null, token_provider:null` required in generation payload (else 422).
- **`params` is gone (2026-09)**: the V6 web client omits it and generation succeeds without it. Do NOT inject it (`suno-client.generate()` no longer does). (2026-08 it was required; Suno removed that requirement with V6.)
- **Captcha sitekey**: Suno's generation Turnstile sitekey is `NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY_GEN` embedded in a `suno.com/_next/static/chunks/*.js` bundle (pattern `...SITE_KEY_GEN||"0x4AAAA..."`). Do NOT hardcode Cloudflare's test key (`0x4AAA...AAAQAAA`) — Suno rejects those tokens. The extension discovers the real key dynamically; see BetterSuno AGENTS.md.
- Mode switch: `gpt_description_prompt` empty + `prompt` set → Custom mode (lyrics provided). `gpt_description_prompt` set + `prompt` empty → Inspiration mode (auto-lyrics).
- Sliders: `metadata.control_sliders` (`weirdness_constraint`, `style_weight`, `audio_weight`, 0–1) + `metadata.can_control_sliders`. Input 0–100, converted to 0.0–1.0 internally.
- **V6 options** (accepted by `create_song`, `inspire_song`, `cover_song`, `extend_song`):
  - `max_mode` → `metadata.is_max_mode: true` (plan feature `max-mode`).
  - `vocal_gender` (`"m"`/`"f"`) → `metadata.vocal_gender`.
  - `duration` (seconds, clamped 10–360) → top-level `duration`.
  - `variety` (level `0`–`4`: off/normal/high/extra/max) → `metadata.control_sliders.aug_creativity` (V6-only; the web slider's raw state is the level, **not** 0–1). Values outside 0–4 → 400 "creativity slider out of range".
  - `personalize` / `personalize_lyrics` / `personalize_user_uuid` → top-level `use_personalization: true`, `do_personalize_lyrics`, `personalization_user_uuid`. The web UI forces Variety on before Personalize; MCP defaults `aug_creativity` to 1 when personalize is set without `variety`.
- **Core generation tools** (`create_song`, `inspire_song`, `cover_song`, `extend_song`) support `negative_tags`, control sliders, `persona_id` + `persona_model` (`"voice_persona"` for Vox — **default**, `"style_persona"` for style).
- **Persona linkage needs `task`, NOT `persona_model`**: Suno's backend links a clip to its persona (which makes the GUI show the voice chip via the clip's `persona` object) only when the payload carries the right top-level `task`. `persona_model` is a **fictional field** — the suno.com web client never sends it. The server maps `persona_model` → `task`: Vox → `vox`/`vox_cover`/`vox_extend`; style → `artist_consistency`/`artist_cover`/`artist_extend`. (2026-08: verified against the live web bundle + real API responses.)
- **Models**: default `chirp-hawk` (V6). Valid V6 keys: `chirp-hawk`, `chirp-hawk-wild` (v6-wild), `chirp-goose` (v6-mini) — from `GET /api/billing/info/` → `models[].external_key`. Legacy keys (`chirp-fenix`, `chirp-crow`, `chirp-bluejay`, `chirp-auk`, `chirp-v4`, `chirp-v3-5`) still generate but aren't shown in the current web UI.
- **`mashup_song`**: 2+ clip IDs, asserts `can_remix` on each. **`concat_songs`**: no ownership gate, hits `POST /api/generate/concat/v2/`.
- **Lyrics tools**: `generate_lyrics` (cowrite), `lyrics_infill` (placeholders `[...]`), `lyrics_mashup` (blend two lyrics).
- `create_song`/`inspire_song` try WS relay first (`relay_generate`), fall back to direct API. `cover_song`/`extend_song` go direct.

## Key gotchas
- **Turnstile captchas — always ask the user to solve them**: if generation fails with "We couldn't verify your request" or a "Cloudflare Turnstile check could not be solved automatically" error, STOP retrying. The extension first reuses Suno's own Turnstile widget/token and otherwise renders a visible widget in the Suno tab with a "tick the checkbox" hint; ask the user to tick "Verify you are human" there, then retry. Remote-debugged/automated browsers (`navigator.webdriver === true`) can never pass. Generation calls are also deliberately serialised with a randomized gap (`MCP_GENERATION_INTERVAL_MS`, default 20s) to keep Cloudflare from escalating.
- **Comments opt-in**: all comment tools throw unless `MCP_ALLOW_COMMENTS=true`.
- **Search**: uses `POST /api/search/` (GET returns 405). Filters results to only own songs via `/api/user/me`. `library_song` searches are server-capped at 250 rows (`from_index ≥ 250` returns 0 hits even though `total_hits` reports more). `search_type` must be one of the live enum values (`library_song`, `lyrics`, `public_song`, …) — the old `song` value now returns 422. `library_song` only matches title/tag metadata, not lyrics; use the `search_by_lyrics` tool for `metadata.prompt` phrase search (extension-DB candidates + batched `feed/v3` ids lookups, with `created_after`/`created_before` date bounds).
- **Library feed filters**: `/api/feed/v3` filters use the V6 BooleanFilter keys — `liked`, `disliked`, `public`, `fullSong`, `stem`… The public filter is `{public:"True"}`; `{is_public:"True"}` is silently ignored.
- **Prompts**: stored in extension's IndexedDB; accessed via WS `extension_request`/`response` round-trip. Needs extension connected.
- **BetterSuno DB as library source**: `get_db_songs` and `get_library_stats {source:"db"}` read the `songsList` store of the extension's page-side IndexedDB (`BetterSunoicationsDB`) via the WS action `get_db_songs` (MCP → `background.handleMcpExtensionRequest` → suno-tab content script → `loadSongsFromIDB`). No Suno API calls. The cache is populated by the extension's **Fetch Songs** button; records carry `model_name`/`major_model_version`, `play_count` (played/unplayed), `task`, `cover_clip_id` after the 2026-09 metadata extension. `get_db_songs` filters/paginates/sorts server-side (search, model, played, liked, public) and can return per-model/played stats.
  - The extension's MV3 background is an event page: when idle/suspended it is not connected to the WS bridge, and waking it requires extension activity (opening a tab that messages the background). MCP DB tools therefore need the extension recently active.
- **Downloads**: `download_song` uses `inferAudioExtension` helper to check `Content-Type` and correct file extension when Suno returns a different format than requested.
- **Downloads (V6 media model)**: V6 clips have `audio_url: /api/forbidden`; real audio lives in `media_urls[]`.
  - Entries **without** `encoding` are plain progressive files (m4a/mp3) → direct download.
  - Entries **with** `encoding` are AES-encrypted fragmented MP4. `download_song` replicates the web player's license flow (`resolveSunoAudioBytes`): `POST {MCP_MANGO_BASE_URL}/api/mango/rights` → `{key,iv,glt}`, `userKey=SHA-256(bearer token)`, AES-256-GCM-unwrap key/iv (AAD = clip id), then AES-256-CTR-decrypt the stream. `MCP_MANGO_BASE_URL` defaults to `https://studio-api-prod.suno.com` (note the hyphen; different host from the API).
  - **Never send the Suno Bearer header to S3/CDN URLs** — S3 rejects it with HTTP 400 ("only one auth mechanism allowed"). `authHeadersForUrl()` only attaches auth for the API host.
  - WAV: `POST /api/gen/{clip_id}/convert_wav/` (204) then poll `GET /api/gen/{clip_id}/wav_file/` every 5s (≤24 tries) for `{wav_file_url}`; legacy `GET /api/download/clip/{clip_id}?format=wav` (`{ok, download_url}`) is the fallback. `m4a` uses the progressive/decrypt path above.
- **Playlist writes**: reorder now takes `{positions:[{clip_id,index}]}` on `/api/playlist/v2/{id}/tracks/reorder-by-index`; `/api/playlist/v2/{id}` returns metadata only (tracks come from v1 `GET /api/playlist/{id}`). `reorder_playlist` resolves `from_index` → `clip_id` via the v1 listing. Trash requires a JSON body: `{undo:false}` to trash, `{undo:true}` to restore (an empty body returns 422).
- **Albums (verified 2026-11)**: albums are playlist containers. Create with `POST /api/playlist/create/` `{name, description?, playlist_type:"album", album_type:"lp"|"ep", source_playlist_id?}`; `source_playlist_id` copies an owned playlist's tracks and leaves the source intact. Default state is `draft`. Read with `POST /api/unified/feed` `{feed_id:"library_albums"}` or `{feed_id:"album:<id>"}`; the latter's `feed_metadata` carries `album_type`, `lifecycle_state`, `published_at`, `unpublished_clip_ids`, `is_owned`, and `can_edit`, while `feed.items` are the tracks. Fallback search types are `library_album` / `album`. Update metadata with `PATCH /api/playlist/v2/{id}` `{metadata:{name, cover_image_s3_id?}, bio:{description?}, album:{album_type?}}`; add/remove/reorder tracks with the normal playlist v2 track endpoints. Publish/unpublish: `POST /api/playlist/v2/{id}/album/publish` `{use_album_cover}` and `/album/unpublish` `{unpublish_songs}`. Note: `search` album results can report `is_owned:false` for your own albums; rely on the unified feed's `feed_metadata.is_owned` or the v2 `relationship.is_owned`. MCP exposes all of this in `src/tools/albums.js`.
- **Notifications**: list via `GET /api/notification/v3?before_datetime_utc=&include_hooks=true` (cursor is `next_before_datetime_utc`). Mark read via `POST /api/notification/v2/read` with `{ids:[...]}` or `{all:true, before_datetime_utc}`. Badge: `GET /api/notification/v2/badge-count`, clear with `POST /api/notification/v2/clear-badge`.
- **Lyrics projects**: `GET /api/lyrics-projects` returns full lyrics for every project — the list tool omits them by default to avoid huge payloads. Create with `POST /api/lyrics-projects {title}`; save content with `POST /api/lyrics-projects/{id}/flush {lyrics}`; rename with `PATCH {title}`; delete returns 204.
- **Lyricists**: `GET/POST /api/lyricists`, `GET/PATCH/DELETE /api/lyricists/{id}`. Create/update body is `{title, description, samples:[{kind:"text",text}]}`; favorite via `PATCH {is_favorited}`.
- **Custom models**: list by filtering `GET /api/billing/info/` models for `external_key` starting with `chirp-custom:` or a `custom` badge. Bases: `GET /api/custom-model/bases/`; pending: `GET /api/custom-model/pending/`; rename: `PUT /api/custom-model/edit/ {id,name}`; archive: `POST /api/custom-model/archive/ {id}`.
- **Visuals / cover art**: `GET /api/visual/models`, `POST /api/visual/generations`, `GET /api/visual/generations/{id}`. The feature is account/region-gated: the 2026-11 account gets `403 feature_disabled` ("Visuals aren't available right now."). Cover *setting* works without visuals via `PATCH /api/playlist/v2/{id} {metadata:{cover_image_s3_id}}`; cover downloads fetch the CDN URL without the Suno bearer token.
- **MCP tool annotations**: `src/index.js` adds `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` to every tool at `tools/list` time using name-prefix heuristics. Add a tool-level `annotations` object to override a specific tool.
- **Async edits**: `crop_clip`/`fade_clip` wait on `GET /api/edit/action/{action_clip_id}/` until `complete` before returning the resulting clip id.
- **Playback** (`play_song`/`stop_playback`): works for ANY song (no ownership gate). MCP→WS→extension→suno tab player.
- **Edit tools** (`crop_clip`, `fade_clip`, `reverse_clip`, `adjust_speed`): only work on owned clips (`assertOwned`).
- **Extension reconnect race**: right after the WS bridge starts, `No auth token` can be transient — the extension's MV3 background worker redials 10s after a disconnect, or when its 2-min `ensureOffscreenAlive` alarm wakes it if already suspended. Retry for up to ~2 min (or check `ss -tnp | grep 9423` for an ESTAB) before assuming a stale instance.
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
- If extension tools **persistently** report "not connected" (past the ~2 min reconnect window above), a stale instance almost certainly owns the port: `pkill -f bettersuno-mcp`.
  - **Caution**: `pkill -f bettersuno-mcp` also matches the invoking shell (the pattern appears in its command line) — quote it as `pkill -f 'bettersuno[-]mcp'`.
  - In practice opencode does **not** re-register a killed MCP server's tools mid-session; after killing it the `bettersuno-mcp_*` tools disappear until the session/MCP is restarted. Prefer letting the owner of the stale process handle it.
- `MCP_TOKEN_FILE` controls the debug token dump (`/tmp/suno_token.txt` by default, still written after auth). Tests set it to empty so they don't clobber the live token.
- Avoid registering this server in both `opencode.json` and `opencode.jsonc` — one registration per session is enough.

## Dev tooling (scripts/)
- **`scripts/suno-api.mjs`** — authenticated API probe. Reuses the token dump the server writes after extension auth:
  `node scripts/suno-api.mjs GET /api/user/me`, `node scripts/suno-api.mjs POST /api/search/ '{"..."}'`, `@file` bodies supported. Env: `SUNO_TOKEN`, `MCP_TOKEN_FILE`, `MCP_API_BASE_URL`, `MCP_MANGO_BASE_URL` (`/api/mango/*` automatically targets the mango host).
- **`scripts/dump-suno-api.mjs`** — dumps the web client's current `/api` surface for diffs: fetches `suno.com`, follows `/_next/static` chunk imports, extracts quoted `/api/...` paths. `--out <file>` saves a baseline, `--diff <baseline>` prints added/removed paths (use after a Suno API change; browser-based dump in BetterSuno AGENTS.md may see a few more dynamically-loaded chunks).
- **Workspace API (verified 2026-09)**: `POST /api/project` `{name, description}` creates a workspace; `POST /api/project/{id}/clips` with `{update_type:"add"|"remove"|"move"|"pinned", metadata:{clip_ids, target_project_id?, pinned?}}` mutates membership (204; cross-workspace moves target the *source* project with `target_project_id`). Reads: `list_projects`/`get_project`/`get_project_clips`. MCP exposes create + membership mutations; billing/account settings stay out.

## Safety constraints
- **Never expose billing, payment, subscription, or account/profile-settings features as MCP tools.** Billing endpoints (`/api/billing/*`), plan changes, tax/payment methods, account settings, collaborator/invite management, etc. stay out of the tool surface.
- **Workspaces are an approved mutation scope** (`create_workspace`, `add_songs_to_workspace`, `remove_songs_from_workspace`, `move_songs_to_workspace`) alongside the existing song/playlist/edit tools. Workspace membership operations require ownership (`assertWorkspaceOwned` + `assertOwned` per clip).
- **Albums are an approved mutation scope** (`create_album`, `update_album_metadata`, `add_songs_to_album`, `remove_songs_from_album`, `reorder_album_tracks`, `publish_album`, `unpublish_album`, `delete_album`, `restore_album`). Album mutations require ownership (`assertAlbumOwned`). Publishing/unpublishing is a visibility change; document it in the tool description and keep `unpublish_songs` default false.
- For manual/one-off account mutations use `scripts/suno-api.mjs` interactively; that script is a dev tool, not an MCP feature.

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

<!-- BEGIN opencode-rag -->
## Code Navigation

ALWAYS use OpenCodeRAG tools before reading or editing:
- **Search first** — `search_semantic(query)` instead of grep/glob
- **Skeleton before read** — `get_file_skeleton(filePath)` then read specific lines
- **Usages before edit** — `find_usages(symbolName)` before modifying any symbol
- **Images via describe** — `describe_image(filePath, systemPrompt?)` — never read raw bytes
- **Recall quirks** — `recall_quirks(query)` when you hit a known pitfall
- **Add quirks** — `add_quirk(content)` when you discover a non-obvious fact
- **Fix quirks** — `update_quirk(id, ...)` / `delete_quirk(id)` when a stored quirk is outdated or wrong

If no results, run `opencode-rag index`.

### Decision model (`make_decision`)

- Classify, route, or score short text with the local tev1 model (`state` + 1-64 questions).
- Question types: `choice` (options map to descriptions), `noul` (true/false probability), `score` (ordered rubric levels, lowest first).
- Keep `state` short (~2k-token context); add a `none` option when no listed option may fit.
- Never use it as the only check for a high-stakes decision.
- With `decision.routeBeforeAsking` enabled: route option choices through `make_decision` before asking the user; ask the user only when the model is undecided (low confidence) or the choice is preference-based.

### Decision tree — ALWAYS follow this order
1. User mentions code behavior/architecture → `search_semantic(query)`
2. User mentions a file path → `get_file_skeleton(filePath)` THEN `read` on specific lines
3. User mentions a function/class/variable to edit → `find_usages(symbolName)` THEN `search_semantic` THEN `edit`
4. User asks a code question → `search_semantic` to gather context before answering
5. User asks about an image or visual asset → `describe_image(filePath)` (optionally pass `systemPrompt` to focus on specific features) to retrieve its generated description, then optionally `search_semantic` for related code
6. You encounter an error or need to recall a known pitfall → `recall_quirks(query)`
7. You discover a non-obvious fact or workaround → `add_quirk(content)` to persist it for future sessions
8. A recalled quirk is outdated or wrong → `update_quirk(id, ...)` to fix it, or `delete_quirk(id)` if it no longer applies

### Proactive triggers — you MUST call these tools when
- User asks about code behavior, architecture, or implementation details
- User asks to edit, refactor, or fix code — call `find_usages` first
- User references files or functions you haven't read yet
- User says "find", "search", "look up", "where is", "how does"
- User refers to an image, screenshot, diagram, or visual asset
- Before answering ANY code-related question, retrieve context first
- Before reading ANY file, call `get_file_skeleton` to orient first

### Anti-patterns — NEVER do these
- Reading full files without calling `get_file_skeleton` first (wastes tokens)
- Editing a function without calling `find_usages` first (breaks call sites)
- Answering code questions without calling `search_semantic` first (you guess at behavior)
- Using `grep`/`glob` when `search_semantic` would find the answer faster
- Treating image files as text — use `describe_image` instead of reading raw bytes
- Using `npx opencode-rag quirk` shell commands instead of the built-in quirk tools (`add_quirk` / `recall_quirks` / `update_quirk` / `delete_quirk`) (the tools are faster, already loaded in-process, and go through the trust monitor)

### MANDATORY quirk capture rules — you MUST call `add_quirk` when
- A build, test, or type-check command fails and you resolve it
- You discover an undocumented library constraint, peer dep, or workaround
- You learn an environment-specific requirement (OS, tool version, etc.)
- You make a design decision that future sessions should remember
- You resolve a gotcha that cost more than one attempt

### MANDATORY quirk hygiene — you MUST call `update_quirk` or `delete_quirk` when
- A stored quirk is outdated, wrong, or has been fixed — update it or delete it instead of adding a contradicting duplicate
- NEVER finish a coding session without adding quirks for resolved errors.
<!-- END opencode-rag -->

<!-- opencode-crosstalk:begin -->
## OpenCode Crosstalk

Other OpenCode sessions in this workspace are reachable through the
`opencode-crosstalk` plugin: `crosstalk_status`, `crosstalk_peers`,
`crosstalk_send`, `crosstalk_inbox`, `crosstalk_claim`, `crosstalk_wait`.
Talk to each other, but keep working — only stop for coordination that prevents
a real collision.

- **Declare once, then keep moving.** `crosstalk_status` sets your role and goal;
  `crosstalk_peers` shows active sessions and their leases. Work that does not
  overlap theirs needs no coordination.
- **Talk before you collide.** If you need something a peer holds, `crosstalk_send`
  a short ask and continue elsewhere; replies are injected into live turns (use
  `crosstalk_inbox` to catch up). Never force a claim.
- **Lease what you are editing now.** `crosstalk_claim` takes an exclusive expiring
  lease on exact paths — no globs (`resources`, `note`, `ttlSeconds`). `renew` if the
  work runs long, `release` when done; a refusal names the holder.
- **Identity is automatic** — never pass a "who am I". Blocking calls are capped by
  `maxWaitMs` and may return early; that is normal.

Installed globally (`npm run setup` in `/home/christoph/code/opencode-crosstalk`);
`opencode api get /api/plugin` shows `opencode.crosstalk` active. Disable per
workspace with `"plugins": ["-opencode.crosstalk"]`; no permission rule is required.
<!-- opencode-crosstalk:end -->
