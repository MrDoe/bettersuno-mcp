# bettersuno-mcp

> MCP server for [BetterSuno](https://github.com/MrDoe/SunoNotifications) — exposes Suno API features to AI agents via the [Model Context Protocol](https://modelcontextprotocol.io).

## Prerequisites

- **Node.js 18+**
- The **BetterSuno browser extension** installed and loaded on an open `suno.com` tab

  > The MCP server **requires** the extension at runtime. The extension provides the Clerk auth token, solves Turnstile captchas, relays playback to the Suno tab, and surfaces the prompt library. Without the extension running, the MCP server cannot authenticate.

## Install

```bash
# Run directly via npx
npx bettersuno-mcp

# Or install globally
npm install -g bettersuno-mcp
```

## Usage

1. Have the BetterSuno extension loaded in a Chrome or Firefox browser with at least one open `suno.com` tab.
2. Start the MCP server:

```bash
npx bettersuno-mcp
```

The server listens on `ws://127.0.0.1:9423` for the extension to connect and push its auth token, then accepts MCP stdio connections from AI tools.

### Register in your AI tool

**opencode** (`~/.opencode/opencode.json`):
```json
{
  "mcpServers": {
    "bettersuno": {
      "command": ["npx", "bettersuno-mcp"]
    }
  }
}
```

**Claude Code** (`~/.claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "bettersuno": {
      "command": "npx",
      "args": ["bettersuno-mcp"]
    }
  }
}
```

**Cursor**:
```
node /path/to/bettersuno-mcp/src/index.js
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `MCP_WS_PORT` | `9423` | WebSocket port the MCP server listens on for the extension connection |
| `MCP_API_BASE_URL` | `https://studio-api.prod.suno.com` | Suno API base URL |
| `MCP_ALLOW_COMMENTS` | `false` | Set to `true` to enable comment tools (which expose other users' content) |
| `MCP_WS_TIMEOUT` | `60000` | Max time to wait for the extension to connect before timing out |

## Architecture

```
┌─────────────────────────────────────────┐
│  AI Tool (opencoe/Claude/Cursor)        │
│  └─ MCP stdio ──► bettersuno-mcp (this) │
│                                          │
│  bettersuno-mcp                          │
│  ├─ 59 tools / 12 modules                │
│  ├─ suno-client.js — HTTP to Suno API    │
│  └─ ws-bridge.js — WS server on :9423   │
└──────────────┬──────────────────────────┘
               │ WebSocket (127.0.0.1:9423)
     ┌─────────▼─────────────────────────┐
     │  BetterSuno Extension             │
     │  ├─ pushes Clerk auth token       │
     │  ├─ solves Turnstile captchas     │
     │  ├─ relays playback to suno tab   │
     │  └─ surfaces prompt library (IDB) │
     └───────────────────────────────────┘
```

## API Documentation

See [API.md](./API.md) for full tool reference, parameters, and examples.

### Tool categories

| Module | Tools |
|---|---|
| Generation | `create_song`, `inspire_song`, `cover_song`, `extend_song`, `remaster_song`, `make_stems`, `get_recommended_styles`, `upsample_tags`, `mashup_song` |
| Library | `list_library`, `get_song`, `get_songs_by_ids`, `search_songs`, `search_users`, `get_profile`, `get_current_user`, `get_user_session` |
| Downloads | `get_song_urls`, `download_song`, `download_lyrics`, `download_cover_image` |
| Personas | `create_persona`, `list_personas`, `get_persona`, `list_followed_personas`, `list_loved_personas`, `toggle_love_persona` |
| Uploads | `upload_audio`, `upload_image`, `upload_video` |
| Playlists | `list_playlists`, `create_playlist`, `get_playlist`, `get_playlist_songs`, `search_playlists`, `add_to_playlist`, `remove_from_playlist`, `reorder_playlist`, `delete_playlist`, `update_playlist_metadata` |
| Workspaces | `list_projects`, `get_project`, `get_project_clips` |
| Metadata | `delete_song`, `trash_song`, `set_visibility`, `like_song`, `update_song_metadata`, `generate_video`, `create_custom_model` |
| Playback | `play_song`, `stop_playback` |
| Comments | `get_song_comments`, `post_song_comment`, `update_comment_reaction` |
| Feed | `explore_feed` |
| Prompts | `get_prompts`, `save_prompt`, `delete_prompt` |

### Key semantics

- **Ownership gate**: download/metadata/delete tools throw for songs you don't own. `cover`/`extend`/`mashup` allow remixing other artists' songs only when `metadata.can_remix` is enabled.
- **Playback**: works for any song (including other users' public playlists). Relays via WS → extension → suno tab player.
- **Comments**: opt-in (`MCP_ALLOW_COMMENTS=true`).
- **Prompts**: stored in the extension's IndexedDB; relayed via WS.
- **Search**: uses `POST /api/search/` (GET variants return 405).

## Testing

```bash
npm test
```

The test suite uses a mock Suno API server (no real Suno account needed) and validates the full MCP stdio protocol, tool registration, payload construction, and error handling for every tool.

## Development

```bash
git clone git@github.com:MrDoe/bettersuno-mcp.git
cd bettersuno-mcp
npm install
npm start
```

## Related

- [BetterSuno Extension](https://github.com/MrDoe/SunoNotifications) — the browser companion extension (required at runtime)
- [Model Context Protocol](https://modelcontextprotocol.io) — the protocol this server implements
- [Suno](https://suno.com) — the AI music generation platform
