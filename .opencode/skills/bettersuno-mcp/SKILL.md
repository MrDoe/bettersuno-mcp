---
name: bettersuno-mcp
description: Use when working with Suno songs through the bettersuno-mcp MCP server — generating V6 songs (chirp-hawk/chirp-hawk-wild/chirp-goose), duration/variety/personalize/max-mode options, downloading WAV or encrypted m4a, playlists, workspaces, library audits (V6 coverage), or investigating Suno API changes. Triggers on "Suno", "bettersuno", "generate song", "V6", "chirp-", "workspace", "playlist", "download song".
---

# BetterSuno MCP

The `bettersuno-mcp` server (this repository) exposes Suno features as MCP tools. It needs the BetterSuno Firefox extension connected over `ws://127.0.0.1:9423` for auth; tools fail with `No auth token. Is BetterSuno extension running and connected?` when it isn't.

## Operating notes

- **Extension reconnect race**: right after a server start, `No auth token` can be transient (up to ~2 min). Retry, or check `ss -tnp | grep 9423` for an ESTAB before assuming a stale instance.
- **Single instance**: only one server can bind 9423. Killing it mid-session (`pkill -f 'bettersuno[-]mcp'`) makes the `bettersuno-mcp_*` tools disappear from the running session until opencode restarts.
- **Token probe**: the server dumps the extension token to `/tmp/suno_token.txt`; use `node scripts/suno-api.mjs <METHOD> <path> [json|@file]` for raw API calls without MCP round-trips.
- **Tests**: `npm test` in the repo (mocked API + crypto; sets `MCP_TOKEN_FILE=''` so it won't clobber the live token).
- **Safety**: song/playlist/edit/workspace tools are ownership-gated. Never expose billing/payment/account-settings features; workspaces are the approved account-level mutation scope.

## Generation (create_song, inspire_song, cover_song, extend_song)

- Models (`mv`, default `chirp-hawk`): `chirp-hawk` V6, `chirp-hawk-wild` V6-wild, `chirp-goose` V6-mini; legacy `chirp-fenix`/chirp-crow/chirp-bluejay/chirp-auk/chirp-v4/chirp-v3-5.
- V6 options: `max_mode` (max-mode plan), `vocal_gender` (`m`/`f`), `duration` (10–360s), `variety` (0–4 → `aug_creativity`), `personalize` + `personalize_lyrics` (+ optional `personalize_user_uuid`). `personalize` auto-defaults variety to level 1.
- Persona linkage uses `task`, not `persona_model`: Vox → `vox`/`vox_cover`/`vox_extend`; style → `artist_consistency`/`artist_cover`/`artist_extend`.
- `params` is gone (do not re-add); `token:null`/`token_provider:null` required; captcha via `/api/c/check` (1=hCaptcha, 2=Turnstile — extension solves Turnstile only). `create_song`/`inspire_song` try WS relay first, then direct API.
- Verify V6 options landed via `get_song`: `model_badges.songrow.display_name` (`V6`/`V6-WILD`/`V6-MINI`), `metadata.duration`, `metadata.control_sliders.aug_creativity`, `metadata.is_max_mode`.

## Downloads (download_song)

- `m4a`: prefers plain `media_urls[]` entries; V6 entries with `encoding` are AES-encrypted and are decrypted via the license flow (`POST {mango}/api/mango/rights` → AES-256-GCM-unwrap key/iv with SHA-256(token), AAD=clip id → AES-256-CTR-decrypt). Don't send the Bearer header to S3/CDN URLs (400).
- `wav`: `POST /api/gen/{clip_id}/convert_wav/` then poll `GET /api/gen/{clip_id}/wav_file/` for `{wav_file_url}`; legacy `/api/download/clip?format=wav` fallback.
- `get_song_urls` shows `media_urls` and `has_encrypted_media`.

## Library, playlists, workspaces, edits

- `list_library` filters: the public filter is `{public:"True"}` (NOT `is_public`). For audits use `get_library_stats` (`scope`, `max_songs`, `include_songs`) — reports per-model counts and the non-V6 song list.
- `search_songs` (`library_song` search) is server-capped at 250 rows; paginating the library uses feed cursors instead.
- Playlist mutations: `add_to_playlist`/`remove_from_playlist` (v2 tracks), `reorder_playlist` posts `{positions:[{clip_id,index}]}` (resolve `from_index` → clip id from the v1 playlist listing).
- Workspaces: `create_workspace`, `add_songs_to_workspace`, `remove_songs_from_workspace`, `move_songs_to_workspace` (auto-detects source; library→workspace uses `add`, workspace→workspace uses `move`), reads via `list_projects`/`get_project`/`get_project_clips` (clips come from `GET /api/project/{id}` → `project_clips`).
- `crop_clip`/`fade_clip` are async: poll `GET /api/edit/action/{action_clip_id}/` until `complete`.

## Investigating Suno API changes

1. Dump the current surface: `node scripts/dump-suno-api.mjs --out /tmp/suno-api-paths.txt`.
2. Diff after a change: `--diff /tmp/suno-api-paths.txt` (prints added/removed `/api/...` paths).
3. Verify a suspect endpoint live: `node scripts/suno-api.mjs GET /api/user/me` (adds `MCP_MANGO_BASE_URL` for `/api/mango/*` automatically).
4. Cross-check payload shapes against the downloaded web-client chunks and record findings in `AGENTS.md` (Generation semantics / Key gotchas / V6 API changes sections in `~/code/BetterSuno/AGENTS.md`).
