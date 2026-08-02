# BetterSuno MCP Server — API Reference

**74 tools** across 12 modules. All tools require the BetterSuno extension to be running with an active Suno.com tab for authentication.

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
| `mv` | string | No | Model version (`chirp-fenix`, `chirp-v4`, `chirp-v3-5`). Default: `chirp-fenix` |
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
| `mv` | string | No | Model version. Default: `chirp-fenix` |
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
| `mv` | string | No | Model version. Default: `chirp-fenix` |
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
| `mv` | string | No | Model version. Default: `chirp-fenix` |
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
| `mv` | string | No | Model version. Default: `chirp-fenix` |

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

(Unchanged — see original 9 tools: `list_library`, `get_song`, `get_songs_by_ids`, `search_songs`, `search_users`, `get_profile`, `get_current_user`, `get_user_session`)

---

## Downloads

Standard tools plus `download_sample_pack`.

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
