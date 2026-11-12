# BetterSuno MCP Server — API Reference

**121 tools** across 18 modules. All tools require the BetterSuno extension to be running with an active Suno.com tab for authentication.

> Ownership/safety: download, metadata, and delete tools are gated to songs you own (`assertOwned`). Cover/extend/mashup of another artist's song is allowed only when that song's `metadata.can_remix` is `true`. `play_song` works for ANY song (including public songs from other users' playlists) and does not gate ownership. Comments (`get_song_comments`, `post_song_comment`, `update_comment_reaction`) are opt-in — the server must be started with `MCP_ALLOW_COMMENTS=true`.`explore_feed` is read-only public browsing; downloading or saving cover art of those songs is blocked by the ownership gate.

---

## Generation

### `create_song`

Generate a song from custom lyrics and style tags.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lyrics` | string | Yes | Song lyrics with section markers like `[Verse]`, `[Chorus]` |
| `title` | string | No | Song title |
| `tags` | string | No | Style/genre tags (e.g. `"pop, upbeat, synth"`) |
| `negative_tags` | string | No | Styles to avoid |
| `instrumental` | boolean | No | Make instrumental (no vocals) |
| `mv` | string | No | Model version. V6 family: `chirp-hawk` (default), `chirp-hawk-wild`, `chirp-goose`; legacy: `chirp-fenix`, `chirp-crow`, `chirp-bluejay`, `chirp-v4`, `chirp-v3-5` |
| `max_mode` | boolean | No | V6 Max Mode — full-length, highest-quality take (requires plan access) |
| `vocal_gender` | string | No | `"m"` or `"f"` to force the vocal gender; omit to let Suno choose |
| `duration` | number | No | V6 target duration in seconds (10–360); omit for model default/auto |
| `variety` | number | No | V6 Variety (`aug_creativity`) level 0–4: 0=off, 1=normal, 2=high, 3=extra, 4=max |
| `personalize` | boolean | No | V6 Personalize ("My Taste"); defaults Variety to level 1 when `variety` is omitted |
| `personalize_lyrics` | boolean | No | Let Personalize adapt the lyrics (`do_personalize_lyrics`) |
| `personalize_user_uuid` | string | No | Optional target user UUID for Personalize |
| `weirdness` | number | No | Weirdness 0–100 |
| `style_weight` | number | No | Style influence 0–100 |
| `audio_weight` | number | No | Audio influence 0–100 |
| `persona_id` | string | No | Persona ID for voice consistency |
| `persona_model` | string | No | `voice_persona` (Vox/voice, default) or `style_persona`. Controls the Suno `task` sent (`vox` vs `artist_consistency`); the raw field is **not** sent to Suno |

---

### `inspire_song`

Generate a song from a description. Suno auto-writes the lyrics. Now supports all sliders.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `description` | string | Yes | Style/description text (e.g. `"a sad ballad about losing a pet"`) |
| `title` | string | No | Song title |
| `instrumental` | boolean | No | Make instrumental |
| `mv` | string | No | Model version. V6 family: `chirp-hawk` (default), `chirp-hawk-wild`, `chirp-goose`; legacy: `chirp-fenix`, `chirp-crow`, `chirp-bluejay`, `chirp-v4`, `chirp-v3-5` |
| `max_mode` | boolean | No | V6 Max Mode — full-length, highest-quality take (requires plan access) |
| `vocal_gender` | string | No | `"m"` or `"f"` to force the vocal gender; omit to let Suno choose |
| `duration` | number | No | V6 target duration in seconds (10–360); omit for model default/auto |
| `variety` | number | No | V6 Variety (`aug_creativity`) level 0–4: 0=off, 1=normal, 2=high, 3=extra, 4=max |
| `personalize` | boolean | No | V6 Personalize ("My Taste"); defaults Variety to level 1 when `variety` is omitted |
| `personalize_lyrics` | boolean | No | Let Personalize adapt the lyrics (`do_personalize_lyrics`) |
| `personalize_user_uuid` | string | No | Optional target user UUID for Personalize |
| `tags` | string | No | Additional style tags |
| `negative_tags` | string | No | Styles to avoid |
| `weirdness` | number | No | Weirdness 0–100 |
| `style_weight` | number | No | Style influence 0–100 |
| `audio_weight` | number | No | Audio influence 0–100 |
| `persona_id` | string | No | Persona ID for voice consistency |
| `persona_model` | string | No | `voice_persona` (default) or `style_persona`; maps to Suno `task` (`vox` / `artist_consistency`), not sent raw |

---

### `cover_song`

Create a cover version of an existing song. Now supports custom lyrics, all sliders, and voices.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | ID of the song to cover |
| `lyrics` | string | No | New lyrics for the cover (if empty, uses original lyrics) |
| `title` | string | No | Song title for the cover |
| `tags` | string | No | Style tags for the cover |
| `negative_tags` | string | No | Styles to avoid |
| `start_s` | number | No | Start time in seconds |
| `end_s` | number | No | End time in seconds |
| `mv` | string | No | Model version. V6 family: `chirp-hawk` (default), `chirp-hawk-wild`, `chirp-goose`; legacy: `chirp-fenix`, `chirp-crow`, `chirp-bluejay`, `chirp-v4`, `chirp-v3-5` |
| `max_mode` | boolean | No | V6 Max Mode — full-length, highest-quality take (requires plan access) |
| `vocal_gender` | string | No | `"m"` or `"f"` to force the vocal gender; omit to let Suno choose |
| `duration` | number | No | V6 target duration in seconds (10–360); omit for model default/auto |
| `variety` | number | No | V6 Variety (`aug_creativity`) level 0–4: 0=off, 1=normal, 2=high, 3=extra, 4=max |
| `personalize` | boolean | No | V6 Personalize ("My Taste"); defaults Variety to level 1 when `variety` is omitted |
| `personalize_lyrics` | boolean | No | Let Personalize adapt the lyrics (`do_personalize_lyrics`) |
| `personalize_user_uuid` | string | No | Optional target user UUID for Personalize |
| `instrumental` | boolean | No | Make instrumental |
| `weirdness` | number | No | Weirdness 0–100 |
| `style_weight` | number | No | Style influence 0–100 |
| `audio_weight` | number | No | Audio influence 0–100 |
| `persona_id` | string | No | Persona ID for voice consistency |
| `persona_model` | string | No | `voice_persona` (default) or `style_persona`; maps to Suno `task` (`vox_cover` / `artist_cover`), not sent raw |

---

### `extend_song`

Extend a song from a specific point. Now supports all style options and sliders.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | ID of the song to extend |
| `continue_at` | number | Yes | Time in seconds to extend from |
| `lyrics` | string | No | Optional lyrics for the extension |
| `mv` | string | No | Model version. V6 family: `chirp-hawk` (default), `chirp-hawk-wild`, `chirp-goose`; legacy: `chirp-fenix`, `chirp-crow`, `chirp-bluejay`, `chirp-v4`, `chirp-v3-5` |
| `max_mode` | boolean | No | V6 Max Mode — full-length, highest-quality take (requires plan access) |
| `vocal_gender` | string | No | `"m"` or `"f"` to force the vocal gender; omit to let Suno choose |
| `duration` | number | No | V6 target duration in seconds (10–360); omit for model default/auto |
| `variety` | number | No | V6 Variety (`aug_creativity`) level 0–4: 0=off, 1=normal, 2=high, 3=extra, 4=max |
| `personalize` | boolean | No | V6 Personalize ("My Taste"); defaults Variety to level 1 when `variety` is omitted |
| `personalize_lyrics` | boolean | No | Let Personalize adapt the lyrics (`do_personalize_lyrics`) |
| `personalize_user_uuid` | string | No | Optional target user UUID for Personalize |
| `tags` | string | No | Style tags for the extension |
| `negative_tags` | string | No | Styles to avoid |
| `instrumental` | boolean | No | Make instrumental |
| `weirdness` | number | No | Weirdness 0–100 |
| `style_weight` | number | No | Style influence 0–100 |
| `audio_weight` | number | No | Audio influence 0–100 |
| `persona_id` | string | No | Persona ID for voice consistency |
| `persona_model` | string | No | `voice_persona` (default) or `style_persona`; maps to Suno `task` (`vox_extend` / `artist_extend`), not sent raw |

---

### `concat_songs`

Concatenate/replace section of a song. Used internally for add vocals, add instrumental, replace section.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | ID of the source song clip |
| `is_infill` | boolean | No | Whether this is an infill (replace section) operation. Default: `false` |
| `edit_session_id` | string | No | Optional edit session ID for tracking |

---

### `mashup_song`

Blend two or more songs into a mashup.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_ids` | string[] | Yes | Array of 2+ song clip IDs to mash up |
| `title` | string | No | Mashup title |
| `tags` | string | No | Style tags for the mashup |
| `mv` | string | No | Model version. V6 family: `chirp-hawk` (default), `chirp-hawk-wild`, `chirp-goose`; legacy: `chirp-fenix`, `chirp-crow`, `chirp-bluejay`, `chirp-v4`, `chirp-v3-5` |

---

### `remaster_song`

Remaster/upsample a song to higher quality.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | ID of the song to remaster |
| `model_name` | string | No | Target model |
| `tags` | string | No | Style tags to apply |
| `freedom` | number | No | Variation freedom 0.0–1.0 |
| `tone` | number | No | Tone adjustment 0.0–1.0 |
| `clarity` | number | No | Clarity 0.0–1.0 |
| `strength` | number | No | Strength 0.0–1.0 |
| `stereo_width` | number | No | Stereo width 0.0–1.0 |
| `variation_category` | string | No | Variation category |

---

### `make_stems`

Extract stems (vocals, instrumental, drums, bass) from a song.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | ID of the song to extract stems from |

---

### `generate_lyrics`

Generate lyrics from a description using AI.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Description of the lyrics (genre, theme, mood) |
| `title` | string | No | Song title |
| `style` | string | No | Music style/genre for the lyrics |
| `lyrics_model` | string | No | Lyrics model (`default`, `remi-v1`). Default: `default` |

---

### `lyrics_infill`

Infill/generate missing lyrics in a partially written lyric.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lyrics` | string | Yes | Partial lyrics with `[...]` placeholders for sections to infill |
| `style` | string | No | Music style context |
| `lyrics_model` | string | No | Lyrics model. Default: `default` |

---

### `lyrics_mashup`

Mashup two sets of lyrics into one.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lyrics_a` | string | Yes | First set of lyrics |
| `lyrics_b` | string | Yes | Second set of lyrics |

---

### `get_recommended_styles`

Get recommended style tags for the current user. No parameters.

### `upsample_tags`

Expand and enhance style tags with AI suggestions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tags` | string | Yes | Base style tags to expand |

---

## Library

Tools: `list_library`, `get_song`, `get_songs_by_ids`, `search_songs`, `search_by_lyrics`, `search_users`, `get_profile`, `get_current_user`, `get_user_session`, `get_library_stats`.

### `get_library_stats`

Walks `POST /api/feed/v3` (cursor pagination, 50/page, 429-aware through the shared client) and aggregates the library: song counts per model/version, public/private split, and V6 coverage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scope` | string | No | `all` (default), `public`, or `liked` |
| `max_songs` | number | No | Safety cap on songs scanned (default 2500, max 20000); `truncated: true` in the result means more remain |
| `include_songs` | boolean | No | Also return the non-V6 song list (`id`, `title`, `model_name`, `major_model_version`, `created_at`, `is_public`) |

Note: the V6 feed filter key for public songs is `public: "True"` (not `is_public`).

### `search_by_lyrics`

Find the user's own songs whose lyrics (`metadata.prompt`) contain a phrase. Matching is case-, punctuation-, and whitespace-insensitive (`I'm`, `im`, and `I’m` are equivalent).

Candidates come from the BetterSuno extension IndexedDB cache when it is connected: `created_after` / `created_before` narrow the candidate list locally, then full clips are fetched in batches of 100 via `POST /api/feed/v3` with an `ids` filter. Without the extension, the tool paginates `feed/v3` newest-first and uses the date bounds to stop early. Use this instead of `search_songs`, which only searches title/tag metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Lyric phrase to find |
| `created_after` | string | No | Earliest creation date. ISO 8601, `YYYY-MM-DD`, or `YYYY-MM` (month start) |
| `created_before` | string | No | Latest creation date. ISO 8601, `YYYY-MM-DD` (whole day), or `YYYY-MM` (whole month) |
| `source` | string | No | `auto` (default; DB with feed fallback), `db` (require the extension), or `api` (paginate feed) |
| `max_songs` | number | No | Candidate cap (default 2500) |
| `limit` | number | No | Max matches returned (default 100) |
| `include_lyrics` | boolean | No | Include full `metadata.prompt` for each match |

Example: find a lyric recorded in June 2026:

```json
{
  "query": "The dampening field is at maximum, but I'm fighting it",
  "created_after": "2026-06-01",
  "created_before": "2026-06"
}
```

The result reports `source`, `scanned`, `with_lyrics`, `match_count`, `truncated`, and per-match `id`, `title`, `created_at`, `model_name`, `major_model_version`, `excerpt`, and (optionally) `lyrics`.

---

## Downloads

Standard tools plus `download_sample_pack`.

`download_song` handles the V6 media model automatically:
- `format: "m4a"` downloads a plain progressive `media_urls[]` asset when one exists; otherwise it uses the encrypted stream (Suno's license flow: `POST /api/mango/rights` → unwrap key/iv with SHA-256 of the bearer token (AES-256-GCM, AAD = clip id) → AES-256-CTR-decrypt the media). Falls back to the official `/api/download/clip` endpoint.
- `format: "wav"` asks Suno to convert (`POST /api/gen/{clip_id}/convert_wav/`) and polls `GET /api/gen/{clip_id}/wav_file/` for `{wav_file_url}` (legacy `/api/download/clip?format=wav` fallback).
- Presigned S3/CDN URLs never receive the Suno Bearer token (S3 would reject the request with HTTP 400).

### `download_sample_pack`

Download a sample pack for a song (Suno Samples feature).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `output_dir` | string | No | Output directory (defaults to current dir) |

---

## Personas

See also `is_voice_recording` field on `create_persona` — set to `true` to create a Vox/voice clone persona from uploaded audio recordings.

---

## Metadata / Editing

New edit tools:

### `crop_clip`

Crop a clip to a specific time range.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `crop_start_s` | number | Yes | Start time in seconds |
| `crop_end_s` | number | Yes | End time in seconds |
| `title` | string | No | Title for the cropped clip |
| `is_crop_remove` | boolean | No | Remove the selected range instead of keeping it. Default: `false` |

### `fade_clip`

Add fade in/out to a clip.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `fade_in_time` | number | No | Fade in duration in seconds |
| `fade_out_time` | number | No | Fade out duration in seconds |
| `title` | string | No | Title for the faded clip |

### `reverse_clip`

Reverse a clip's audio.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID to reverse |

### `adjust_speed`

Adjust the playback speed of a clip.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `speed_multiplier` | number | No | Speed multiplier (1.0 = normal, 1.5 = faster, 0.75 = slower) |
| `keep_pitch` | boolean | No | Preserve pitch. Default: `false` |

### `set_clip_prompt`

Set/edit the prompt metadata for a clip (title, tags, lyrics, negative tags).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `prompt` | string | No | New prompt text |
| `title` | string | No | New title |
| `tags` | string | No | New style tags |
| `negative_tags` | string | No | New negative style tags |

### `set_clip_configurations`

Set configurations for a clip (display tags, etc.).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clip_id` | string | Yes | Song clip ID |
| `display_tags` | string | No | Display tags for the clip |

---

## Uploads

(Unchanged — `upload_audio`, `upload_image`, `upload_video`)

---

## Workspaces (Projects)

Read: `list_projects`, `get_project`, `get_project_clips`. Writes are ownership-gated (`assertWorkspaceOwned` + `assertOwned` per clip):

### `create_workspace`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Workspace name (truncated to 100 chars) |
| `description` | string | No | Workspace description |

### `add_songs_to_workspace` / `remove_songs_from_workspace`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | Yes | Workspace ID |
| `clip_ids` | string[] | Yes | Song clip IDs (songs stay in the library either way) |

### `move_songs_to_workspace`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target_project_id` | string | Yes | Destination workspace ID |
| `clip_ids` | string[] | Yes | Song clip IDs to move |
| `source_project_id` | string | No | Optional source workspace; defaults to each clip's current project, or the library |

Under the hood: `POST /api/project` creates; `POST /api/project/{id}/clips` with `{update_type:"add"|"remove"|"move", metadata:{clip_ids, target_project_id?}}` mutates (cross-workspace moves target the source project).

---

## Albums

Suno albums are playlist containers (`playlist_type: "album"`) with `album_type` `lp` or `ep`. New albums are created as drafts (`lifecycle_state: "draft"`) and become public through `publish_album`. Reads work for public albums by other users; every mutation is ownership-gated via `assertAlbumOwned`.

Tools: `list_albums`, `get_album`, `search_albums`, `create_album`, `update_album_metadata`, `add_songs_to_album`, `remove_songs_from_album`, `reorder_album_tracks`, `publish_album`, `unpublish_album`, `delete_album`, `restore_album`.

### `list_albums`

Reads `POST /api/unified/feed` with `{feed_id: "library_albums", cursor, page_size}` and maps `album` feed items. Pass `user_id` to read `user_albums` with `target_user_id`. Falls back to `POST /api/search/` with `search_type: "library_album"` and an empty term for your own library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Albums per page (default 50, max 100) |
| `cursor` | string | No | Pagination cursor |
| `user_id` | string | No | User UUID to list that user's public albums |

### `get_album`

Reads `POST /api/unified/feed` with `{feed_id: "album:<id>"}`. The `feed_metadata` object carries `album_type`, `lifecycle_state`, `published_at`, `unpublished_clip_ids`, ownership/capabilities, and stats; `feed.items` carries the tracks. Falls back to `GET /api/playlist/v2/{id}` plus `GET /api/playlist/{id}`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `album_id` | string | Yes | Album ID |
| `include_tracks` | boolean | No | Include tracks (default true) |
| `limit` | number | No | Tracks per page (default 50, max 100) |
| `cursor` | string | No | Pagination cursor |

### `search_albums`

`POST /api/search/` with `search_type: "album"` for public albums or `"library_album"` for your own (including drafts).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Album search query |
| `scope` | string | No | `public` (default) or `library` |
| `limit` | number | No | Max results (default 50, max 100) |

### `create_album`

`POST /api/playlist/create/` with `{name, description?, playlist_type: "album", album_type: "lp"|"ep", source_playlist_id?}`. With `source_playlist_id`, the tracks of an owned playlist are copied into the new album; the source playlist remains intact. The result is a draft; call `publish_album` to publish it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Album name |
| `description` | string | No | Album description |
| `album_type` | string | No | `lp` (default) or `ep` |
| `source_playlist_id` | string | No | Owned playlist whose tracks are copied into the album |

### `update_album_metadata`

`PATCH /api/playlist/v2/{id}` with `{metadata: {name, cover_image_s3_id?}, bio: {description?}, album: {album_type?}}`. The current name is preserved when only other fields are supplied.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `album_id` | string | Yes | Album ID |
| `name` | string | No | New name |
| `description` | string | No | New description |
| `album_type` | string | No | `lp` or `ep` |
| `cover_image_s3_id` | string | No | Existing Suno S3 image ID (`image_...`) |

### `add_songs_to_album` / `remove_songs_from_album`

`POST /api/playlist/v2/{id}/tracks/add` or `/tracks/remove` with `{clip_ids}`. Removal only detaches tracks; songs stay in the library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `album_id` | string | Yes | Album ID |
| `clip_ids` | string[] | Yes | Song clip IDs |

### `reorder_album_tracks`

`POST /api/playlist/v2/{id}/tracks/reorder-by-index` with `{positions: [{clip_id, index}]}`. Provide `clip_id`, or `from_index` to resolve the clip from the v1 playlist listing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `album_id` | string | Yes | Album ID |
| `to_index` | number | Yes | Target 0-based index |
| `clip_id` | string | No | Clip to move |
| `from_index` | number | No | Current 0-based index (alternative to `clip_id`) |

### `publish_album` / `unpublish_album`

- Publish: `POST /api/playlist/v2/{id}/album/publish` with `{use_album_cover}`. Makes the album tracks public.
- Unpublish: `POST /api/playlist/v2/{id}/album/unpublish` with `{unpublish_songs}`. Defaults to keeping individual songs published.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `album_id` | string | Yes | Album ID |
| `use_album_cover` | boolean | No | Publish uses the album cover (publish only, default false) |
| `unpublish_songs` | boolean | No | Also unpublish tracks (unpublish only, default false) |

### `delete_album` / `restore_album`

`POST /api/playlist/v2/{id}/trash` with `{undo: false}` to trash or `{undo: true}` to restore.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `album_id` | string | Yes | Album ID |

---

## Reactions & Visibility

| Tool | Endpoint | Notes |
|------|----------|-------|
| `like_album` | `POST/DELETE /api/playlist/v2/{id}/save` | Save/remove a public album by another user. Saving your own album returns 400 `cannot_save_own`; use `pin_album`. |
| `like_playlist` | `POST/DELETE /api/playlist/v2/{id}/save` | Same behavior for playlists. |
| `pin_album` | `POST/DELETE /api/playlist/v2/{id}/pin` | Pin/unpin an album in your library. |
| `pin_playlist` | `POST/DELETE /api/playlist/v2/{id}/pin` | Pin/unpin a playlist. |
| `set_playlist_visibility` | `PATCH /api/playlist/v2/{id}` | Body `{metadata:{is_public}}`. |

## Covers & Visuals

| Tool | Endpoint | Notes |
|------|----------|-------|
| `get_visual_models` | `GET /api/visual/models` | Visual feature is account/region gated; may return `feature_disabled` (403). |
| `generate_cover_art` | `POST /api/visual/generations` | Resolves an image model automatically; returns a generation ID. Poll with `get_visual_generation`. |
| `get_visual_generation` | `GET /api/visual/generations/{id}` | Returns status and takes. |
| `set_cover` | `PATCH /api/playlist/v2/{id}` | Body `{metadata:{cover_image_s3_id}}`; works for albums and playlists. |
| `download_cover` | `GET /api/playlist/v2/{id}` + CDN image | Saves the cover to disk. Never sends the Suno bearer token to the CDN. |

Note: the 2026-11 test account had visuals disabled (`feature_disabled` 403 on `/api/visual/models`), so cover *generation* is implemented but cannot be exercised until the feature is enabled. Cover *setting* and downloading work.

## Notifications

| Tool | Endpoint | Notes |
|------|----------|-------|
| `list_notifications` | `GET /api/notification/v3?before_datetime_utc=&include_hooks=true` | Returns raw notification text/avatars/actions and `next_before_datetime_utc`. |
| `mark_notifications_read` | `POST /api/notification/v2/read` | Body `{ids:[...]}` or `{all:true, before_datetime_utc}`. |
| `get_notification_badge` | `GET /api/notification/v2/badge-count` | Returns `{badge_count}`. |
| `clear_notification_badge` | `POST /api/notification/v2/clear-badge` | Clears the badge without marking notifications read. |

## Custom Models

| Tool | Endpoint | Notes |
|------|----------|-------|
| `list_custom_models` | `GET /api/billing/info/` | Filters `models` to `chirp-custom:*` / `custom` badge; returns `max_active_custom_models` and `max_custom_model_clips`. |
| `list_custom_model_bases` | `GET /api/custom-model/bases/` | Base models for creating a custom model. |
| `get_pending_custom_models` | `GET /api/custom-model/pending/` | Training status. |
| `rename_custom_model` | `PUT /api/custom-model/edit/` | Body `{id, name}`. |
| `archive_custom_model` | `POST /api/custom-model/archive/` | Body `{id}`. |

## Lyrics Projects & Lyricists

| Tool | Endpoint | Notes |
|------|----------|-------|
| `list_lyricists` | `GET /api/lyricists?limit=&cursor=` | Returns id, name, writing_style, sample_lyrics, favorite flag. |
| `get_lyricist` | `GET /api/lyricists/{id}` | |
| `create_lyricist` | `POST /api/lyricists` | Body `{title, description, samples:[{kind:"text",text}]}`. |
| `update_lyricist` | `PATCH /api/lyricists/{id}` | Partial body; supports `is_favorited`. |
| `delete_lyricist` | `DELETE /api/lyricists/{id}` | |
| `list_lyrics_projects` | `GET /api/lyrics-projects?limit=&sort=updated_at\|created_at&cursor=` | Omits lyrics by default; `include_lyrics:true` adds them. |
| `get_lyrics_project` | `GET /api/lyrics-projects/{id}` | Includes full lyrics. |
| `create_lyrics_project` | `POST /api/lyrics-projects` | Body `{title}` (max 200 chars). |
| `update_lyrics_project` | `PATCH /api/lyrics-projects/{id}` | Body `{title}`. |
| `flush_lyrics_project` | `POST /api/lyrics-projects/{id}/flush` | Body `{lyrics}`. |
| `delete_lyrics_project` | `DELETE /api/lyrics-projects/{id}` | Returns 204. |

## Tool annotations

`tools/list` now includes MCP `title` and `annotations` for every tool (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). The hints are inferred from tool-name prefixes: `get_`/`list_`/`search_`/`download_` are read-only; `delete_`/`trash_`/`remove_`/`unpublish_`/`archive_` are destructive; `create_`/`generate_`/`publish_`/`upload_`/`search_` are open-world. A tool-level `annotations` object overrides the inferred values.

---

## Playlists, Workspaces, Playback, Comments, Feed, Prompts

(Unchanged — see original docs)

---

## Error Handling

All tools return errors as MCP error responses with descriptive messages. Common errors:

| Error | Cause |
|-------|-------|
| `No auth token. Is BetterSuno extension running and connected?` | Extension not loaded, no Suno tab, or WS bridge disconnected |
| `Captcha solve timed out` | Cloudflare Turnstile challenge not solved within 60s |
| `HTTP 401` | Token expired — extension should refresh automatically |
| `HTTP 429` | Rate limited — server retries with exponential backoff |
| `HTTP 422 token_validation_failed` | Captcha check not completed |

## New API Endpoints Used

| Endpoint | Method | Used by |
|----------|--------|---------|
| `/api/generate/concat/v2/` | POST | `concat_songs` |
| `/api/generate/cowrite-lyrics` | POST | `generate_lyrics` |
| `/api/generate/lyrics-infill/` | POST | `lyrics_infill` |
| `/api/generate/lyrics-mashup` | POST | `lyrics_mashup` |
| `/api/edit/crop/{clip_id}/` | POST | `crop_clip` |
| `/api/edit/fade/{clip_id}/` | POST | `fade_clip` |
| `/api/clips/reverse-clip/` | POST | `reverse_clip` |
| `/api/clips/adjust-speed/` | POST | `adjust_speed` |
| `/api/gen/{clip_id}/set_clip_prompt/` | POST | `set_clip_prompt` |
| `/api/gen/{clip_id}/set_configurations/` | POST | `set_clip_configurations` |
| `/api/download/sample-pack/{clip_id}` | GET | `download_sample_pack` |
| `/api/unified/feed` | POST | `list_albums`, `get_album` |
| `/api/playlist/create/` | POST | `create_playlist`, `create_album` |
| `/api/playlist/v2/{playlist_id}` | PATCH | `update_album_metadata` |
| `/api/playlist/v2/{playlist_id}/tracks/add` | POST | `add_to_playlist`, `add_songs_to_album` |
| `/api/playlist/v2/{playlist_id}/tracks/remove` | POST | `remove_from_playlist`, `remove_songs_from_album` |
| `/api/playlist/v2/{playlist_id}/tracks/reorder-by-index` | POST | `reorder_playlist`, `reorder_album_tracks` |
| `/api/playlist/v2/{playlist_id}/album/publish` | POST | `publish_album` |
| `/api/playlist/v2/{playlist_id}/album/unpublish` | POST | `unpublish_album` |
| `/api/playlist/v2/{playlist_id}/trash` | POST | `delete_playlist`, `delete_album`, `restore_album` |
| `/api/playlist/v2/{playlist_id}/save` | POST/DELETE | `like_album`, `like_playlist` |
| `/api/playlist/v2/{playlist_id}/pin` | POST/DELETE | `pin_album`, `pin_playlist` |
| `/api/notification/v3` | GET | `list_notifications` |
| `/api/notification/v2/read` | POST | `mark_notifications_read` |
| `/api/notification/v2/badge-count` | GET | `get_notification_badge` |
| `/api/notification/v2/clear-badge` | POST | `clear_notification_badge` |
| `/api/billing/info/` | GET | `list_custom_models` |
| `/api/custom-model/bases/` | GET | `list_custom_model_bases` |
| `/api/custom-model/pending/` | GET | `get_pending_custom_models` |
| `/api/custom-model/edit/` | PUT | `rename_custom_model` |
| `/api/custom-model/archive/` | POST | `archive_custom_model` |
| `/api/lyricists` | GET/POST | `list_lyricists`, `create_lyricist` |
| `/api/lyricists/{lyricist_id}` | GET/PATCH/DELETE | `get_lyricist`, `update_lyricist`, `delete_lyricist` |
| `/api/lyrics-projects` | GET/POST | `list_lyrics_projects`, `create_lyrics_project` |
| `/api/lyrics-projects/{project_id}` | GET/PATCH/DELETE | `get_lyrics_project`, `update_lyrics_project`, `delete_lyrics_project` |
| `/api/lyrics-projects/{project_id}/flush` | POST | `flush_lyrics_project` |
| `/api/visual/models` | GET | `get_visual_models`, `generate_cover_art` |
| `/api/visual/generations` | POST | `generate_cover_art` |
| `/api/visual/generations/{id}` | GET | `get_visual_generation` |
