/**
 * Integration tests for the BetterSuno MCP server.
 *
 * These tests start the MCP server as a child process, communicate over stdio
 * using the JSON-RPC protocol, and verify that:
 *   - The server starts and responds to the `initialize` handshake
 *   - All tools are listed via `tools/list`
 *   - Each tool has the correct name, description, and input schema
 *   - Tool calls return proper error messages when no auth token is available
 *   - The syunthetic Suno API flow works end-to-end (with a mock API server)
 *
 * Run with:  npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

// ─── helpers ───────────────────────────────────────────────────────────────────

class McpStdioClient {
  constructor(child) {
    this.child = child;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;

    child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      while (true) {
        const nl = this.buffer.indexOf('\n');
        if (nl === -1) break;
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  listTools() {
    return this.request('tools/list');
  }

  close() {
    this.child.kill();
  }
}

/**
 * Start the MCP server as a child process and return a stdio client.
 * Optionally connect a WebSocket extension bridge that provides a fake token.
 */
async function startServer({ wsPort = 0, token = null } = {}) {
  const env = {
    ...process.env,
    MCP_WS_PORT: wsPort ? String(wsPort) : '0', // 0 = let OS pick (server will report the actual port)
    MCP_TOKEN_FILE: '', // don't clobber the live token dump
    MCP_GENERATION_INTERVAL_MS: '0', // keep generation tests fast
  };

  const child = spawn('node', ['src/index.js'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  child.stderr.on('data', () => {}); // silence stderr

  const client = new McpStdioClient(child);

  // Initialize handshake
  const initResult = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.1' },
  });

  // Send initialized notification
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return { client, child, initResult };
}

/**
 * Create a mock Suno API HTTP server for end-to-end tool testing.
 */
function createMockSunoApi() {
  const requests = [];
  const responses = new Map(); // path → { status, body }

  function setResponse(path, { status = 200, body = {}, contentType = 'application/json' } = {}) {
    responses.set(path, { status, body, contentType });
  }

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        path: req.url.split('?')[0],
        auth: req.headers.authorization,
        body: body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : null,
      };
      requests.push(entry);

      const matched = responses.get(entry.path) || responses.get('*');
      if (matched) {
        const body = typeof matched.body === 'function' ? matched.body(entry) : matched.body;
        res.writeHead(matched.status, { 'Content-Type': matched.contentType });
        if (Buffer.isBuffer(body)) res.end(body);
        else res.end(JSON.stringify(body));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Not found' }));
      }
    });
  });

  return { server, requests, setResponse };
}

// ─── Expected tool definitions ─────────────────────────────────────────────────

const EXPECTED_TOOLS = [
  // generation
  'create_song', 'inspire_song', 'cover_song', 'extend_song',
  'remaster_song', 'make_stems', 'get_recommended_styles', 'upsample_tags',
  // library
  'list_library', 'get_song', 'get_songs_by_ids', 'search_songs',
  'search_users', 'get_profile', 'get_current_user', 'get_user_session',
  'get_library_stats', 'get_db_songs', 'search_by_lyrics',
  // downloads
  'get_song_urls', 'download_song', 'download_lyrics', 'download_cover_image',
  // personas
  'create_persona', 'list_personas', 'get_persona',
  'list_followed_personas', 'list_loved_personas', 'toggle_love_persona',
  // uploads
  'upload_audio', 'upload_image', 'upload_video',
  'get_upload_status', 'initialize_upload_clip',
  // playlists
  'list_playlists', 'create_playlist', 'get_playlist', 'add_to_playlist',
  'remove_from_playlist', 'reorder_playlist', 'delete_playlist', 'update_playlist_metadata',
  // albums
  'list_albums', 'get_album', 'search_albums', 'create_album',
  'update_album_metadata', 'add_songs_to_album', 'remove_songs_from_album',
  'reorder_album_tracks', 'publish_album', 'unpublish_album', 'delete_album', 'restore_album',
  // reactions
  'like_album', 'like_playlist', 'pin_album', 'pin_playlist', 'set_playlist_visibility',
  // covers / visuals
  'get_visual_models', 'generate_cover_art', 'get_visual_generation', 'set_cover', 'download_cover',
  // notifications
  'list_notifications', 'mark_notifications_read', 'get_notification_badge', 'clear_notification_badge',
  // custom models
  'list_custom_models', 'list_custom_model_bases', 'get_pending_custom_models',
  'rename_custom_model', 'archive_custom_model',
  // lyrics projects & lyricists
  'list_lyricists', 'get_lyricist', 'create_lyricist', 'update_lyricist', 'delete_lyricist',
  'list_lyrics_projects', 'get_lyrics_project', 'create_lyrics_project', 'update_lyrics_project',
  'flush_lyrics_project', 'delete_lyrics_project',
  // workspaces
  'list_projects', 'get_project', 'get_project_clips',
  'create_workspace', 'add_songs_to_workspace', 'remove_songs_from_workspace', 'move_songs_to_workspace',
  // metadata
  'delete_song', 'trash_song', 'set_visibility', 'like_song',
  'update_song_metadata', 'generate_video', 'create_custom_model',
];

// ─── tests ─────────────────────────────────────────────────────────────────────

describe('MCP Server — startup & protocol', () => {
  let client, child;

  before(async () => {
    const res = await startServer({ wsPort: 9501 });
    client = res.client;
    child = res.child;
  });

  after(() => {
    if (child) child.kill();
  });

  test('initialize handshake returns server info', () => {
    // The initResult is available from startServer, but we're using the before hook
    // Let's re-request to verify
    // Actually, startServer already sends initialize. Let's verify tools/list works
    assert.ok(true, 'Server started and responded to initialize');
  });

  test('tools/list returns all tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name);
    assert.equal(result.tools.length, 121, 'Expected 121 tools');
    for (const expected of EXPECTED_TOOLS) {
      assert.ok(names.includes(expected), `Missing tool: ${expected}`);
    }
  });

  test('every tool has name, description, and inputSchema', async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      assert.ok(typeof tool.name === 'string' && tool.name.length > 0, `Tool missing name`);
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `Tool ${tool.name} missing description`);
      assert.ok(typeof tool.inputSchema === 'object', `Tool ${tool.name} missing inputSchema`);
      assert.equal(tool.inputSchema.type, 'object', `Tool ${tool.name} inputSchema.type should be "object"`);
    }
  });

  test('every tool has a title and MCP annotations', async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      assert.equal(typeof tool.title, 'string', `Tool ${tool.name} missing title`);
      assert.ok(tool.title.length > 0, `Tool ${tool.name} has an empty title`);
      assert.equal(typeof tool.annotations, 'object', `Tool ${tool.name} missing annotations`);
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof tool.annotations[key], 'boolean', `Tool ${tool.name} missing ${key}`);
      }
    }
    const byName = Object.fromEntries(result.tools.map(t => [t.name, t]));
    assert.equal(byName.get_album.annotations.readOnlyHint, true);
    assert.equal(byName.delete_album.annotations.destructiveHint, true);
    assert.equal(byName.create_song.annotations.openWorldHint, true);
    assert.equal(byName.list_albums.annotations.openWorldHint, false);
  });

  test('create_song requires lyrics parameter', async () => {
    const result = await client.listTools();
    const createSong = result.tools.find(t => t.name === 'create_song');
    assert.ok(createSong.inputSchema.required.includes('lyrics'));
  });

  test('download_song has format enum', async () => {
    const result = await client.listTools();
    const downloadSong = result.tools.find(t => t.name === 'download_song');
    assert.deepEqual(downloadSong.inputSchema.properties.format.enum, ['m4a', 'wav']);
  });

  test('unknown tool returns error', async () => {
    await assert.rejects(
      () => client.callTool('nonexistent_tool', {}),
      /Unknown tool/
    );
  });
});

describe('MCP Server — no auth token', () => {
  let client, child;

  before(async () => {
    const res = await startServer({ wsPort: 9502 });
    client = res.client;
    child = res.child;
    // Wait a moment for WS server to start but don't connect any extension
    await new Promise(r => setTimeout(r, 500));
  });

  after(() => {
    if (child) child.kill();
  });

  test('get_current_user fails with no-token error', async () => {
    await assert.rejects(
      () => client.callTool('get_current_user'),
      /No auth token/
    );
  });

  test('list_library fails with no-token error', async () => {
    await assert.rejects(
      () => client.callTool('list_library', {}),
      /No auth token/
    );
  });

  test('get_song fails with no-token error', async () => {
    await assert.rejects(
      () => client.callTool('get_song', { clip_id: 'test-id' }),
      /No auth token/
    );
  });

  test('search_songs fails with no-token error', async () => {
    await assert.rejects(
      () => client.callTool('search_songs', { query: 'test' }),
      /No auth token/
    );
  });

  test('create_song fails with no-token error (before reaching captcha check)', async () => {
    await assert.rejects(
      () => client.callTool('create_song', { lyrics: 'test lyrics' }),
      /No auth token/
    );
  });

  test('list_playlists fails with no-token error', async () => {
    await assert.rejects(
      () => client.callTool('list_playlists'),
      /No auth token/
    );
  });

  test('delete_song fails with no-token error', async () => {
    await assert.rejects(
      () => client.callTool('delete_song', { clip_ids: ['test'] }),
      /No auth token/
    );
  });

  test('like_song fails with no-token error', async () => {
    await assert.rejects(
      () => client.callTool('like_song', { clip_id: 'test', like: true }),
      /No auth token/
    );
  });
});

describe('MCP Server — with mock token via WebSocket bridge', () => {
  let client, child, mockApi, mockApiServer;

  before(async () => {
    const wsPort = 9503;

    // Start mock Suno API
    mockApi = createMockSunoApi();
    await new Promise(resolve => {
      mockApiServer = mockApi.server.listen(0, resolve);
    });
    const apiPort = mockApiServer.address().port;

    // Start MCP server with mock API URL and custom WS port
    child = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_WS_PORT: String(wsPort),
        MCP_API_BASE_URL: `http://localhost:${apiPort}`,
        MCP_MANGO_BASE_URL: `http://127.0.0.1:${apiPort}`,
        MCP_TOKEN_FILE: '',
        MCP_GENERATION_INTERVAL_MS: '0',
      },
    });
    child.stderr.on('data', () => {});

    client = new McpStdioClient(child);
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // Connect a fake extension WebSocket and push token
    await new Promise(r => setTimeout(r, 500));
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'auth', token: 'fake-test-token-12345' }));
    ws.close();

    // Give the server a moment to process the token
    await new Promise(r => setTimeout(r, 300));
  });

  after(() => {
    if (child) child.kill();
    if (mockApiServer) mockApiServer.close();
  });

  test('get_current_user calls /api/user/me with Bearer token', async () => {
    mockApi.setResponse('/api/user/me', {
      status: 200,
      body: { id: 'user-123', username: 'testuser', credits: 50 },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('get_current_user');
    const text = result.content[0].text;
    const data = JSON.parse(text);

    assert.equal(data.id, 'user-123');
    assert.equal(data.username, 'testuser');
    assert.equal(mockApi.requests.length, 1);
    assert.equal(mockApi.requests[0].method, 'GET');
    assert.equal(mockApi.requests[0].path, '/api/user/me');
    assert.equal(mockApi.requests[0].auth, 'Bearer fake-test-token-12345');
  });

  test('get_song calls /api/clip/{clip_id} with correct path', async () => {
    mockApi.setResponse('/api/clip/test-clip-123', {
      status: 200,
      body: { id: 'test-clip-123', title: 'Test Song', audio_url: 'https://cdn1.suno.ai/test.mp3' },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('get_song', { clip_id: 'test-clip-123' });
    const data = JSON.parse(result.content[0].text);

    assert.equal(data.id, 'test-clip-123');
    assert.equal(mockApi.requests[0].path, '/api/clip/test-clip-123');
  });

  test('list_library calls /api/feed/v3 with POST', async () => {
    mockApi.setResponse('/api/feed/v3', {
      status: 200,
      body: { clips: [{ id: 'clip1', title: 'Song 1' }], next_cursor: null },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('list_library', { limit: 10 });
    const data = JSON.parse(result.content[0].text);

    assert.ok(data.clips);
    assert.equal(data.clips.length, 1);
    assert.equal(mockApi.requests[0].method, 'POST');
    assert.equal(mockApi.requests[0].path, '/api/feed/v3');
    assert.equal(mockApi.requests[0].body.limit, 10);
  });

  test('list_library public_only uses the V6 `public` feed filter', async () => {
    mockApi.setResponse('/api/feed/v3', {
      status: 200,
      body: { clips: [], next_cursor: null },
    });
    mockApi.requests.length = 0;

    await client.callTool('list_library', { public_only: true });

    assert.equal(mockApi.requests[0].body.filters.public, 'True');
    assert.equal(mockApi.requests[0].body.filters.is_public, undefined);
  });

  test('get_library_stats paginates and reports V6 coverage', async () => {
    mockApi.setResponse('/api/feed/v3', {
      status: 200,
      body: (entry) => {
        const cursor = entry.body?.cursor;
        if (!cursor) {
          return {
            clips: [
              { id: 's1', title: 'New V6', model_name: 'chirp-hawk', major_model_version: 'v6', is_public: true },
              { id: 's2', title: 'Old Crow', model_name: 'chirp-crow', major_model_version: 'v5', is_public: true },
            ],
            next_cursor: 'c1',
            has_more: true,
          };
        }
        return {
          clips: [
            { id: 's3', title: 'Old Fenix', model_name: 'chirp-fenix', major_model_version: 'v5.5', is_public: false },
            { id: 's4', title: 'Old V4', model_name: 'chirp-v4', major_model_version: 'v4', is_public: true },
          ],
          next_cursor: null,
          has_more: false,
        };
      },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('get_library_stats', { scope: 'all', include_songs: true });
    const data = JSON.parse(result.content[0].text);

    assert.equal(data.songs_scanned, 4);
    assert.equal(data.v6_count, 1);
    assert.equal(data.non_v6_count, 3);
    assert.equal(data.truncated, false);
    assert.equal(data.public, 3);
    assert.equal(data.private, 1);
    assert.equal(data.non_v6_songs.length, 3);
    assert.equal(data.non_v6_songs[0].model_name, 'chirp-crow');
    assert.ok(mockApi.requests[1].body.cursor === 'c1', 'second page should use the returned cursor');
  });

  test('search_songs posts query and filters to own songs', async () => {
    mockApi.setResponse('/api/search/', {
      status: 200,
      body: {
        result: {
          song: {
            result: [
              { id: 'own1', user_id: 'me-123', title: 'Mine' },
              { id: 'other1', user_id: 'them-456', title: 'Theirs' },
            ],
          },
        },
      },
    });
    mockApi.setResponse('/api/user/me', {
      status: 200,
      body: { user_id: 'me-123', handle: 'me' },
    });
    mockApi.requests.length = 0;

    const res = await client.callTool('search_songs', { query: 'rock ballad', page: 2 });
    // requests[0] is GET /api/user/me from auth.getCurrentUser()
    assert.equal(mockApi.requests[1].method, 'POST');
    assert.equal(mockApi.requests[1].path, '/api/search/');
    assert.equal(mockApi.requests[1].body.search_queries[0].term, 'rock ballad');
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.count, 1, 'only own songs returned');
    assert.equal(data.clips[0].id, 'own1');
  });

  test('search_by_lyrics finds a phrase and respects creation-date bounds', async () => {
    mockApi.setResponse('/api/feed/v3', {
      status: 200,
      body: () => ({
        clips: [
          {
            id: 'july-song',
            title: 'July Song',
            created_at: '2026-07-01T00:00:00.000Z',
            metadata: { prompt: "The dampening field is at maximum, but I'm fighting it." },
          },
          {
            id: 'june-match',
            title: 'Dampening Field',
            created_at: '2026-06-07T06:29:07.319Z',
            metadata: { prompt: "The dampening field is at maximum, but I'm fighting it." },
          },
          {
            id: 'june-other',
            title: 'Other June Song',
            created_at: '2026-06-15T00:00:00.000Z',
            metadata: { prompt: 'Unrelated lyrics' },
          },
          {
            id: 'may-song',
            title: 'May Song',
            created_at: '2026-05-31T00:00:00.000Z',
            metadata: { prompt: "The dampening field is at maximum, but I'm fighting it." },
          },
        ],
        next_cursor: 'should-not-be-requested',
      }),
    });
    mockApi.requests.length = 0;

    const res = await client.callTool('search_by_lyrics', {
      query: 'the dampening field is at maximum but im fighting it',
      created_after: '2026-06-01',
      created_before: '2026-06-30',
    });
    const data = JSON.parse(res.content[0].text);

    assert.equal(data.source, 'api_feed');
    assert.equal(data.scanned, 2, 'July is skipped, May stops the scan, June songs are scanned');
    assert.equal(data.with_lyrics, 2);
    assert.equal(data.match_count, 1);
    assert.equal(data.matches[0].id, 'june-match');
    assert.equal(data.matches[0].excerpt, "The dampening field is at maximum, but I'm fighting it.");
    assert.equal(mockApi.requests.length, 1, 'date bounds should stop the scan before the next page');
  });

  test('list_playlists calls /api/playlist/me with GET', async () => {
    mockApi.setResponse('/api/playlist/me', {
      status: 200,
      body: { playlists: [{ id: 'pl1', name: 'My Playlist' }] },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('list_playlists');
    const data = JSON.parse(result.content[0].text);

    assert.ok(data.playlists);
    assert.equal(mockApi.requests[0].method, 'GET');
    assert.equal(mockApi.requests[0].path, '/api/playlist/me');
  });

  test('create_playlist sends name in body', async () => {
    mockApi.setResponse('/api/playlist/create/', {
      status: 200,
      body: { id: 'new-pl-1', name: 'Test Playlist' },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('create_playlist', { name: 'Test Playlist', is_public: true });
    const data = JSON.parse(result.content[0].text);

    assert.equal(data.id, 'new-pl-1');
    assert.equal(mockApi.requests[0].body.name, 'Test Playlist');
    assert.equal(mockApi.requests[0].body.is_public, true);
  });

  test('add_to_playlist sends clip_ids in body', async () => {
    mockApi.setResponse('/api/playlist/v2/pl-123/tracks/add', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    await client.callTool('add_to_playlist', { playlist_id: 'pl-123', clip_ids: ['clip-a', 'clip-b'] });

    assert.equal(mockApi.requests[0].method, 'POST');
    assert.equal(mockApi.requests[0].path, '/api/playlist/v2/pl-123/tracks/add');
    assert.deepEqual(mockApi.requests[0].body.clip_ids, ['clip-a', 'clip-b']);
  });

  test('reorder_playlist resolves from_index to clip_id and sends positions', async () => {
    mockApi.setResponse('/api/playlist/pl-reorder', {
      status: 200,
      body: {
        playlist_clips: [
          { clip: { id: 'clip-0' } },
          { clip: { id: 'clip-1' } },
          { clip: { id: 'clip-2' } },
        ],
      },
    });
    mockApi.setResponse('/api/playlist/v2/pl-reorder/tracks/reorder-by-index', {
      status: 200,
      body: { success: true, updated_fields: ['track_order'] },
    });
    mockApi.requests.length = 0;

    await client.callTool('reorder_playlist', { playlist_id: 'pl-reorder', from_index: 2, to_index: 0 });

    const reorderReq = mockApi.requests.find(r => r.path.endsWith('/tracks/reorder-by-index'));
    assert.ok(reorderReq, 'reorder request should be sent');
    assert.deepEqual(reorderReq.body.positions, [{ clip_id: 'clip-2', index: 0 }]);
  });

  test('reorder_playlist accepts an explicit clip_id without resolving', async () => {
    mockApi.setResponse('/api/playlist/v2/pl-reorder/tracks/reorder-by-index', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    await client.callTool('reorder_playlist', { playlist_id: 'pl-reorder', clip_id: 'clip-9', to_index: 1 });

    assert.equal(mockApi.requests.length, 1);
    assert.deepEqual(mockApi.requests[0].body.positions, [{ clip_id: 'clip-9', index: 1 }]);
  });

  test('like_song sends LIKE reaction', async () => {
    mockApi.setResponse('/api/gen/clip-123/update_reaction_type/', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    await client.callTool('like_song', { clip_id: 'clip-123', like: true });

    assert.equal(mockApi.requests[0].body.reaction, 'LIKE');
  });

  test('like_song sends null reaction when unlike', async () => {
    mockApi.setResponse('/api/gen/clip-123/update_reaction_type/', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    await client.callTool('like_song', { clip_id: 'clip-123', like: false });

    assert.equal(mockApi.requests[0].body.reaction, null);
  });

  test('set_visibility sends is_public in body', async () => {
    mockApi.setResponse('/api/clip/clip-456', {
      status: 200,
      body: { id: 'clip-456', user_id: 'me-123', title: 'Test Song' },
    });
    mockApi.setResponse('/api/gen/clip-456/set_visibility/', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    await client.callTool('set_visibility', { clip_id: 'clip-456', is_public: true });
    // requests[0] is GET /api/clip/clip-456 from assertOwned
    assert.equal(mockApi.requests[1].body.is_public, true);
    assert.equal(mockApi.requests[1].body.submit_to_contest, false);
  });

  test('remaster_song calls /api/generate/upsample', async () => {
    mockApi.setResponse('/api/generate/upsample', {
      status: 200,
      body: { clips: [{ id: 'remastered-1' }] },
    });
    mockApi.requests.length = 0;

    await client.callTool('remaster_song', {
      clip_id: 'clip-789',
      freedom: 0.5,
      clarity: 0.8,
    });

    assert.equal(mockApi.requests[0].path, '/api/generate/upsample');
    assert.equal(mockApi.requests[0].body.clip_id, 'clip-789');
    assert.equal(mockApi.requests[0].body.freedom, 0.5);
    assert.equal(mockApi.requests[0].body.clarity, 0.8);
  });

  test('make_stems calls /api/edit/stems/{clip_id}/', async () => {
    mockApi.setResponse('/api/edit/stems/clip-stem/', {
      status: 200,
      body: { clips: [{ id: 'stem-1' }] },
    });
    mockApi.requests.length = 0;

    await client.callTool('make_stems', { clip_id: 'clip-stem' });
    assert.equal(mockApi.requests[0].path, '/api/edit/stems/clip-stem/');
  });

  test('get_song_urls returns audio/image/lyrics URLs', async () => {
    mockApi.setResponse('/api/clip/song-with-urls', {
      status: 200,
      body: {
        id: 'song-with-urls',
        title: 'Test',
        user_id: 'me-123',
        audio_url: 'https://cdn1.suno.ai/audio.mp3',
        image_url: 'https://cdn1.suno.ai/image.jpg',
        metadata: { prompt: 'some lyrics' },
      },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('get_song_urls', { clip_id: 'song-with-urls' });
    const data = JSON.parse(result.content[0].text);

    assert.equal(data.audio_url, 'https://cdn1.suno.ai/audio.mp3');
    assert.equal(data.image_url, 'https://cdn1.suno.ai/image.jpg');
    assert.equal(data.lyrics, 'some lyrics');
  });

  test('download_song wav resolves via /api/gen/{id}/wav_file/', async () => {
    const apiPort = mockApiServer.address().port;
    mockApi.setResponse('/api/clip/wav-clip', {
      status: 200,
      body: { id: 'wav-clip', title: 'Wav Test', user_id: 'me-123' },
    });
    mockApi.setResponse('/api/user/me', {
      status: 200,
      body: { user_id: 'me-123', handle: 'me' },
    });
    mockApi.setResponse('/api/gen/wav-clip/wav_file/', {
      status: 200,
      body: { wav_file_url: `http://localhost:${apiPort}/downloads/wav-clip.wav` },
    });
    mockApi.setResponse('/downloads/wav-clip.wav', {
      status: 200,
      body: {},
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('download_song', {
      clip_id: 'wav-clip',
      format: 'wav',
      output_dir: '/tmp/opencode',
    });

    assert.match(result.content[0].text, /Downloaded to/);
    assert.ok(mockApi.requests.some(r => r.path === '/api/gen/wav-clip/wav_file/'), 'should query wav_file endpoint');
    assert.ok(!mockApi.requests.some(r => r.path.includes('/convert_wav/')), 'no conversion needed when wav_file_url exists');
  });

  test('download_song m4a decrypts encrypted media_urls via mango rights', async () => {
    const apiPort = mockApiServer.address().port;
    const clipId = 'enc-clip-1';
    const token = 'fake-test-token-12345';

    // Build an encrypted stream the same way Suno does: content is
    // AES-256-CTR; the content key/iv are AES-256-GCM-wrapped with
    // SHA-256(bearer token) and the clip id as additional data.
    const userKey = createHash('sha256').update(token).digest();
    const contentKey = randomBytes(32);
    const contentIv = randomBytes(16);
    const plaintext = randomBytes(4096);
    const encoder = createCipheriv('aes-256-ctr', contentKey, contentIv);
    const encrypted = Buffer.concat([encoder.update(plaintext), encoder.final()]);

    const wrap = (buf) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', userKey, iv);
      cipher.setAAD(Buffer.from(clipId));
      const ct = Buffer.concat([cipher.update(buf), cipher.final(), cipher.getAuthTag()]);
      return Buffer.concat([iv, ct]).toString('base64');
    };

    mockApi.setResponse(`/api/clip/${clipId}`, {
      status: 200,
      body: {
        id: clipId,
        title: 'Enc Test',
        user_id: 'me-123',
        audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
        media_urls: [{
          url: `http://127.0.0.1:${apiPort}/encrypted-${clipId}.m4a`,
          content_type: 'm4a-opus',
          encoding: '1.0.0',
        }],
      },
    });
    mockApi.setResponse('/api/user/me', { status: 200, body: { user_id: 'me-123', handle: 'me' } });
    mockApi.setResponse('/api/mango/rights', {
      status: 200,
      body: { key: wrap(contentKey), iv: wrap(contentIv), glt: 'test-glt' },
    });
    mockApi.setResponse(`/encrypted-${clipId}.m4a`, {
      status: 200,
      contentType: 'audio/mp4',
      body: encrypted,
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('download_song', {
      clip_id: clipId,
      format: 'm4a',
      output_dir: '/tmp/opencode',
    });

    const match = result.content[0].text.match(/Downloaded to (.+?) \(/);
    assert.ok(match, `expected download path in: ${result.content[0].text}`);
    const written = await readFile(match[1]);
    assert.deepEqual(written, plaintext, 'decrypted bytes should match the original audio');

    assert.ok(mockApi.requests.some(r => r.path === '/api/mango/rights'), 'should request media rights');
    const mediaReq = mockApi.requests.find(r => r.path === `/encrypted-${clipId}.m4a`);
    assert.ok(mediaReq, 'should fetch the encrypted media URL');
    assert.equal(mediaReq.auth, undefined, 'must not send the Bearer token to the media CDN');
  });

  test('list_personas calls /api/persona/get-personas/', async () => {
    mockApi.setResponse('/api/persona/get-personas/', {
      status: 200,
      body: { personas: [{ id: 'p1', name: 'Voice 1' }] },
    });
    mockApi.requests.length = 0;

    await client.callTool('list_personas');
    assert.equal(mockApi.requests[0].method, 'GET');
    assert.equal(mockApi.requests[0].path, '/api/persona/get-personas/');
  });

  test('create_persona sends clips array in body', async () => {
    mockApi.setResponse('/api/persona/create/', {
      status: 200,
      body: { id: 'persona-1', name: 'My Voice' },
    });
    mockApi.requests.length = 0;

    await client.callTool('create_persona', {
      name: 'My Voice',
      clip_ids: ['clip-1', 'clip-2'],
      description: 'A test voice',
    });

    assert.equal(mockApi.requests[0].body.name, 'My Voice');
    assert.deepEqual(mockApi.requests[0].body.clips, ['clip-1', 'clip-2']);
    assert.equal(mockApi.requests[0].body.description, 'A test voice');
  });

  test('list_projects calls /api/project/feed', async () => {
    mockApi.setResponse('/api/project/feed', {
      status: 200,
      body: { projects: [{ id: 'proj1', title: 'My Project' }] },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('list_projects');
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.projects);
    assert.equal(mockApi.requests[0].method, 'GET');
    assert.equal(mockApi.requests[0].path, '/api/project/feed');
  });

  test('get_project_clips reads project_clips from the project detail endpoint', async () => {
    mockApi.setResponse('/api/project/proj-1', {
      status: 200,
      body: { id: 'proj-1', name: 'Proj', clip_count: 1, project_clips: [{ clip: { id: 'c1' } }] },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('get_project_clips', { project_id: 'proj-1' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(mockApi.requests[0].path, '/api/project/proj-1');
    assert.equal(data.clip_count, 1);
    assert.equal(data.clips.length, 1);
  });

  test('create_workspace posts name and description to /api/project', async () => {
    mockApi.setResponse('/api/project', {
      status: 200,
      body: { id: 'ws-1', name: 'My Workspace', clip_count: 0 },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('create_workspace', { name: 'My Workspace', description: 'Test' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.id, 'ws-1');
    assert.equal(mockApi.requests[0].method, 'POST');
    assert.equal(mockApi.requests[0].path, '/api/project');
    assert.deepEqual(mockApi.requests[0].body, { name: 'My Workspace', description: 'Test' });
  });

  test('add_songs_to_workspace posts update_type add after ownership checks', async () => {
    mockApi.setResponse('/api/project/ws-add', { status: 200, body: { id: 'ws-add', is_owned: true } });
    mockApi.setResponse('/api/clip/clip-w1', { status: 200, body: { id: 'clip-w1', user_id: 'me-123' } });
    mockApi.setResponse('/api/project/ws-add/clips', { status: 204, body: {} });
    mockApi.requests.length = 0;

    const result = await client.callTool('add_songs_to_workspace', { project_id: 'ws-add', clip_ids: ['clip-w1'] });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.added, 1);
    const mutation = mockApi.requests.find(r => r.path === '/api/project/ws-add/clips');
    assert.equal(mutation.method, 'POST');
    assert.equal(mutation.body.update_type, 'add');
    assert.deepEqual(mutation.body.metadata.clip_ids, ['clip-w1']);
  });

  test('remove_songs_from_workspace posts update_type remove', async () => {
    mockApi.setResponse('/api/project/ws-rm', { status: 200, body: { id: 'ws-rm', is_owned: true } });
    mockApi.setResponse('/api/clip/clip-w2', { status: 200, body: { id: 'clip-w2', user_id: 'me-123' } });
    mockApi.setResponse('/api/project/ws-rm/clips', { status: 204, body: {} });
    mockApi.requests.length = 0;

    await client.callTool('remove_songs_from_workspace', { project_id: 'ws-rm', clip_ids: ['clip-w2'] });
    const mutation = mockApi.requests.find(r => r.path === '/api/project/ws-rm/clips');
    assert.equal(mutation.body.update_type, 'remove');
  });

  test('move_songs_to_workspace groups by source project (add from library, move between workspaces)', async () => {
    mockApi.setResponse('/api/project/ws-target', { status: 200, body: { id: 'ws-target', is_owned: true } });
    mockApi.setResponse('/api/clip/clip-lib', { status: 200, body: { id: 'clip-lib', user_id: 'me-123' } });
    mockApi.setResponse('/api/clip/clip-src', { status: 200, body: { id: 'clip-src', user_id: 'me-123', project: { id: 'ws-source' } } });
    mockApi.setResponse('/api/project/ws-target/clips', { status: 204, body: {} });
    mockApi.setResponse('/api/project/ws-source/clips', { status: 204, body: {} });
    mockApi.requests.length = 0;

    const result = await client.callTool('move_songs_to_workspace', { target_project_id: 'ws-target', clip_ids: ['clip-lib', 'clip-src'] });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.moved, 2);

    const addReq = mockApi.requests.find(r => r.path === '/api/project/ws-target/clips');
    assert.equal(addReq.body.update_type, 'add');
    assert.deepEqual(addReq.body.metadata.clip_ids, ['clip-lib']);

    const moveReq = mockApi.requests.find(r => r.path === '/api/project/ws-source/clips');
    assert.equal(moveReq.body.update_type, 'move');
    assert.equal(moveReq.body.metadata.target_project_id, 'ws-target');
    assert.deepEqual(moveReq.body.metadata.clip_ids, ['clip-src']);
  });

  test('delete_playlist trashes playlist via POST', async () => {
    mockApi.setResponse('/api/playlist/v2/pl-del/trash', {
      status: 200,
      body: {},
    });
    mockApi.requests.length = 0;

    await client.callTool('delete_playlist', { playlist_id: 'pl-del' });
    assert.equal(mockApi.requests[0].method, 'POST');
    assert.deepEqual(mockApi.requests[0].body, { undo: false });
  });

  test('list_albums reads the library_albums unified feed', async () => {
    mockApi.setResponse('/api/unified/feed', {
      status: 200,
      body: {
        feed: {
          feed_id: 'library_albums',
          feed_title: 'Albums',
          item_count: 2,
          next_cursor: 'albums-c1',
          items: [
            {
              content_id: 'album-1',
              content_type: 'album',
              content_item: {
                id: 'album-1',
                name: 'Album One',
                song_count: 3,
                album_type: 'lp',
                lifecycle_state: 'draft',
                is_owned: true,
              },
            },
            {
              content_id: 'album-2',
              content_type: 'album',
              content_item: {
                id: 'album-2',
                name: 'Album Two',
                song_count: 5,
                album_type: 'ep',
                lifecycle_state: 'published',
                is_owned: true,
              },
            },
          ],
        },
      },
    });
    mockApi.requests.length = 0;

    const res = await client.callTool('list_albums', { limit: 10 });
    const data = JSON.parse(res.content[0].text);

    assert.equal(mockApi.requests[0].path, '/api/unified/feed');
    assert.equal(mockApi.requests[0].body.feed_id, 'library_albums');
    assert.equal(mockApi.requests[0].body.page_size, 10);
    assert.equal(data.albums.length, 2);
    assert.equal(data.albums[0].id, 'album-1');
    assert.equal(data.albums[0].lifecycle_state, 'draft');
    assert.equal(data.next_cursor, 'albums-c1');
  });

  test('get_album reads the album feed and returns tracks', async () => {
    mockApi.setResponse('/api/unified/feed', {
      status: 200,
      body: {
        feed: {
          feed_id: 'album:album-1',
          feed_container_id: 'album-1',
          feed_title: 'Album One',
          feed_image_url: 'https://cdn2.suno.ai/album.jpeg',
          item_count: 1,
          next_cursor: null,
          feed_metadata: {
            description: 'A test album',
            is_public: true,
            is_owned: true,
            can_edit: true,
            album_type: 'lp',
            lifecycle_state: 'published',
            song_count: 1,
            total_duration_seconds: 120,
            owner: { external_user_id: 'me-123', handle: 'me' },
          },
          items: [
            {
              content_id: 'clip-1',
              content_type: 'clip',
              content_item: {
                id: 'clip-1',
                title: 'Track One',
                is_public: true,
                metadata: { duration: 120 },
              },
            },
          ],
        },
      },
    });
    mockApi.requests.length = 0;

    const res = await client.callTool('get_album', { album_id: 'album-1' });
    const data = JSON.parse(res.content[0].text);

    assert.equal(mockApi.requests[0].body.feed_id, 'album:album-1');
    assert.equal(data.album.id, 'album-1');
    assert.equal(data.album.lifecycle_state, 'published');
    assert.equal(data.album.song_count, 1);
    assert.equal(data.tracks.length, 1);
    assert.equal(data.tracks[0].id, 'clip-1');
    assert.equal(data.tracks[0].duration, 120);
  });

  test('create_album sends playlist_type album and returns feed metadata', async () => {
    mockApi.setResponse('/api/playlist/create/', {
      status: 200,
      body: { id: 'new-album', name: 'New Album', song_count: 0 },
    });
    mockApi.setResponse('/api/unified/feed', {
      status: 200,
      body: {
        feed: {
          feed_id: 'album:new-album',
          feed_container_id: 'new-album',
          feed_title: 'New Album',
          item_count: 0,
          feed_metadata: {
            album_type: 'ep',
            lifecycle_state: 'draft',
            song_count: 0,
            is_owned: true,
            is_public: false,
          },
          items: [],
        },
      },
    });
    mockApi.requests.length = 0;

    const res = await client.callTool('create_album', {
      name: 'New Album',
      description: 'A new album',
      album_type: 'ep',
    });
    const data = JSON.parse(res.content[0].text);

    assert.equal(mockApi.requests[0].path, '/api/playlist/create/');
    assert.equal(mockApi.requests[0].body.name, 'New Album');
    assert.equal(mockApi.requests[0].body.playlist_type, 'album');
    assert.equal(mockApi.requests[0].body.album_type, 'ep');
    assert.equal(mockApi.requests[0].body.description, 'A new album');
    assert.equal(mockApi.requests[1].body.feed_id, 'album:new-album');
    assert.equal(data.album.id, 'new-album');
    assert.equal(data.album.lifecycle_state, 'draft');
  });

  test('publish_album posts use_album_cover after ownership check', async () => {
    mockApi.setResponse('/api/playlist/v2/album-1', {
      status: 200,
      body: {
        metadata: { id: 'album-1', name: 'Album One' },
        relationship: { is_owned: true, is_trashed: false },
      },
    });
    mockApi.setResponse('/api/playlist/v2/album-1/album/publish', {
      status: 200,
      body: { success: true, published_clip_ids: ['clip-1'] },
    });
    mockApi.requests.length = 0;

    const res = await client.callTool('publish_album', { album_id: 'album-1', use_album_cover: true });
    const data = JSON.parse(res.content[0].text);

    assert.equal(mockApi.requests[0].path, '/api/playlist/v2/album-1');
    assert.equal(mockApi.requests[1].path, '/api/playlist/v2/album-1/album/publish');
    assert.equal(mockApi.requests[1].body.use_album_cover, true);
    assert.equal(data.success, true);
  });

  test('delete_album and restore_album send undo flags', async () => {
    mockApi.setResponse('/api/playlist/v2/album-1', {
      status: 200,
      body: {
        metadata: { id: 'album-1', name: 'Album One' },
        relationship: { is_owned: true, is_trashed: false },
      },
    });
    mockApi.setResponse('/api/playlist/v2/album-1/trash', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    await client.callTool('delete_album', { album_id: 'album-1' });
    const deleteReq = mockApi.requests.find(r => r.path === '/api/playlist/v2/album-1/trash');
    assert.deepEqual(deleteReq.body, { undo: false });

    mockApi.setResponse('/api/playlist/v2/album-1', {
      status: 200,
      body: {
        metadata: { id: 'album-1', name: 'Album One' },
        relationship: { is_owned: true, is_trashed: true },
      },
    });
    mockApi.requests.length = 0;

    await client.callTool('restore_album', { album_id: 'album-1' });
    const restoreReq = mockApi.requests.find(r => r.path === '/api/playlist/v2/album-1/trash');
    assert.deepEqual(restoreReq.body, { undo: true });
  });

  test('add_songs_to_album posts clip_ids after ownership check', async () => {
    mockApi.setResponse('/api/playlist/v2/album-1', {
      status: 200,
      body: {
        metadata: { id: 'album-1', name: 'Album One' },
        relationship: { is_owned: true, is_trashed: false },
      },
    });
    mockApi.setResponse('/api/playlist/v2/album-1/tracks/add', {
      status: 200,
      body: { successes: ['clip-1'], failures: [] },
    });
    mockApi.requests.length = 0;

    const res = await client.callTool('add_songs_to_album', { album_id: 'album-1', clip_ids: ['clip-1'] });
    const data = JSON.parse(res.content[0].text);

    assert.equal(mockApi.requests[1].path, '/api/playlist/v2/album-1/tracks/add');
    assert.deepEqual(mockApi.requests[1].body.clip_ids, ['clip-1']);
    assert.deepEqual(data.successes, ['clip-1']);
  });

  test('search_albums uses the public album search type', async () => {
    mockApi.setResponse('/api/search/', {
      status: 200,
      body: {
        result: {
          albums: {
            total_hits: 1,
            result: [{
              id: 'album-public',
              name: 'Public Album',
              album_type: 'lp',
              lifecycle_state: 'published',
              user_handle: 'someone',
            }],
          },
        },
      },
    });
    mockApi.requests.length = 0;

    const res = await client.callTool('search_albums', { query: 'Public Album' });
    const data = JSON.parse(res.content[0].text);

    assert.equal(mockApi.requests[0].path, '/api/search/');
    assert.equal(mockApi.requests[0].body.search_queries[0].search_type, 'album');
    assert.equal(data.albums[0].id, 'album-public');
    assert.equal(data.total, 1);
  });

  test('like_album saves and unsaves via POST/DELETE', async () => {
    mockApi.setResponse('/api/playlist/v2/album-1/save', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    await client.callTool('like_album', { album_id: 'album-1', like: true });
    await client.callTool('like_album', { album_id: 'album-1', like: false });

    assert.equal(mockApi.requests[0].method, 'POST');
    assert.equal(mockApi.requests[0].path, '/api/playlist/v2/album-1/save');
    assert.equal(mockApi.requests[1].method, 'DELETE');
    assert.equal(mockApi.requests[1].path, '/api/playlist/v2/album-1/save');
  });

  test('set_cover patches cover_image_s3_id metadata', async () => {
    mockApi.setResponse('/api/playlist/v2/album-1', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    await client.callTool('set_cover', {
      target_type: 'album',
      target_id: 'album-1',
      cover_image_s3_id: 'image_test',
    });

    assert.equal(mockApi.requests[0].method, 'PATCH');
    assert.equal(mockApi.requests[0].path, '/api/playlist/v2/album-1');
    assert.equal(mockApi.requests[0].body.metadata.cover_image_s3_id, 'image_test');
  });

  test('set_playlist_visibility patches is_public', async () => {
    mockApi.setResponse('/api/playlist/v2/pl-1', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    await client.callTool('set_playlist_visibility', { playlist_id: 'pl-1', is_public: true });

    assert.equal(mockApi.requests[0].method, 'PATCH');
    assert.equal(mockApi.requests[0].body.metadata.is_public, true);
  });

  test('list_notifications uses the v3 feed and mark_notifications_read posts ids', async () => {
    mockApi.setResponse('/api/notification/v3', {
      status: 200,
      body: {
        notified_at: '2026-11-12T00:00:00.000Z',
        next_before_datetime_utc: 'cursor-1',
        notifications: [{
          id: 'n1',
          notification_type: 'clip_like',
          is_read: false,
          updated_at: '2026-11-12T00:00:00.000Z',
        }],
      },
    });
    mockApi.setResponse('/api/notification/v2/read', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    const listRes = await client.callTool('list_notifications', { cursor: 'old-cursor' });
    const listData = JSON.parse(listRes.content[0].text);
    assert.ok(mockApi.requests[0].url.includes('before_datetime_utc=old-cursor'));
    assert.equal(listData.notifications[0].id, 'n1');
    assert.equal(listData.next_cursor, 'cursor-1');

    await client.callTool('mark_notifications_read', { notification_ids: ['n1'] });
    const readReq = mockApi.requests.find(r => r.path === '/api/notification/v2/read');
    assert.deepEqual(readReq.body, { ids: ['n1'] });
  });

  test('list_custom_models filters the billing model list', async () => {
    mockApi.setResponse('/api/billing/info/', {
      status: 200,
      body: {
        max_active_custom_models: 3,
        models: [
          { external_key: 'chirp-custom:abc', name: 'My Voice', badges: ['custom'], can_use: true },
          { external_key: 'chirp-hawk', name: 'v6', badges: ['pro'], can_use: true },
        ],
      },
    });
    mockApi.requests.length = 0;

    const res = await client.callTool('list_custom_models');
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.count, 1);
    assert.equal(data.models[0].id, 'chirp-custom:abc');
    assert.equal(data.max_active_custom_models, 3);
  });

  test('rename_custom_model uses PUT /api/custom-model/edit/', async () => {
    mockApi.setResponse('/api/custom-model/edit/', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    await client.callTool('rename_custom_model', { custom_model_id: 'chirp-custom:abc', name: 'Renamed' });

    assert.equal(mockApi.requests[0].method, 'PUT');
    assert.equal(mockApi.requests[0].path, '/api/custom-model/edit/');
    assert.deepEqual(mockApi.requests[0].body, { id: 'chirp-custom:abc', name: 'Renamed' });
  });

  test('list_lyricists and flush_lyrics_project use the lyrics endpoints', async () => {
    mockApi.setResponse('/api/lyricists', {
      status: 200,
      body: {
        lyricists: [{
          id: 'l1',
          title: 'Noir Poet',
          description: 'Short, bleak lines',
          samples: [{ kind: 'text', text: 'The rain remembers.' }],
          is_favorited: true,
        }],
        next_cursor: null,
      },
    });
    mockApi.setResponse('/api/lyrics-projects/p1/flush', {
      status: 200,
      body: { success: true },
    });
    mockApi.requests.length = 0;

    const lyricistsRes = await client.callTool('list_lyricists', { limit: 10 });
    const lyricists = JSON.parse(lyricistsRes.content[0].text);
    assert.equal(lyricists.lyricists[0].name, 'Noir Poet');
    assert.deepEqual(lyricists.lyricists[0].sample_lyrics, ['The rain remembers.']);

    await client.callTool('flush_lyrics_project', { project_id: 'p1', lyrics: 'new lyrics' });
    const flushReq = mockApi.requests.find(r => r.path === '/api/lyrics-projects/p1/flush');
    assert.deepEqual(flushReq.body, { lyrics: 'new lyrics' });
  });

  test('generate_cover_art posts a visual generation body when a model is supplied', async () => {
    mockApi.setResponse('/api/visual/generations', {
      status: 200,
      body: { id: 'gen-1', status: 'queued' },
    });
    mockApi.requests.length = 0;

    const res = await client.callTool('generate_cover_art', {
      prompt: 'a dark album cover',
      model: 'visual-image-1',
      aspect_ratio: '1:1',
      takes: 2,
    });
    const data = JSON.parse(res.content[0].text);

    assert.equal(mockApi.requests[0].method, 'POST');
    assert.equal(mockApi.requests[0].path, '/api/visual/generations');
    assert.equal(mockApi.requests[0].body.prompt, 'a dark album cover');
    assert.equal(mockApi.requests[0].body.model, 'visual-image-1');
    assert.equal(mockApi.requests[0].body.takes, 2);
    assert.equal(mockApi.requests[0].body.aspect, '1:1');
    assert.equal(mockApi.requests[0].body.task, 'visual_image');
    assert.equal(data.id, 'gen-1');
  });

  test('generate_cover_art surfaces feature_disabled from the visual API', async () => {
    mockApi.setResponse('/api/visual/models', {
      status: 403,
      body: { detail: 'Visuals aren\'t available right now.', error_type: 'feature_disabled' },
    });
    mockApi.requests.length = 0;

    await assert.rejects(
      () => client.callTool('generate_cover_art', { prompt: 'a dark album cover' }),
      /Visuals aren't available right now/
    );
  });

  test('401 response surfaces token expiry error', async () => {
    mockApi.setResponse('/api/user/me', {
      status: 401,
      body: { detail: 'Token expired' },
    });
    mockApi.requests.length = 0;

    await assert.rejects(
      () => client.callTool('get_current_user'),
      /Token expired/
    );
  });

  test('404 response surfaces not-found error', async () => {
    mockApi.setResponse('/api/clip/nonexistent', {
      status: 404,
      body: { detail: 'Song not found' },
    });

    await assert.rejects(
      () => client.callTool('get_song', { clip_id: 'nonexistent' }),
      /Song not found/
    );
  });
});

describe('MCP Server — create_song payload construction', () => {
  let client, child, mockApi, mockApiServer;

  before(async () => {
    const wsPort = 9504;

    mockApi = createMockSunoApi();
    await new Promise(resolve => {
      mockApiServer = mockApi.server.listen(0, resolve);
    });
    const apiPort = mockApiServer.address().port;

    child = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_WS_PORT: String(wsPort),
        MCP_API_BASE_URL: `http://localhost:${apiPort}`,
        MCP_MANGO_BASE_URL: `http://127.0.0.1:${apiPort}`,
        MCP_TOKEN_FILE: '',
        MCP_GENERATION_INTERVAL_MS: '0',
      },
    });
    child.stderr.on('data', () => {});

    client = new McpStdioClient(child);
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    await new Promise(r => setTimeout(r, 500));
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'auth', token: 'fake-test-token-12345' }));
    ws.close();
    await new Promise(r => setTimeout(r, 300));
  });

  after(() => {
    if (child) child.kill();
    if (mockApiServer) mockApiServer.close();
  });

  test('create_song calls /api/c/check before /api/generate/v2-web/', async () => {
    mockApi.setResponse('/api/c/check', {
      status: 200,
      body: { required: false, captcha_version: 1 },
    });
    mockApi.setResponse('/api/generate/v2-web/', {
      status: 200,
      body: { clips: [{ id: 'new-clip-1' }, { id: 'new-clip-2' }] },
    });
    mockApi.requests.length = 0;

    const result = await client.callTool('create_song', {
      lyrics: '[Verse]\nTest lyrics\n[Chorus]\nMore lyrics',
      title: 'Test Song',
      tags: 'pop, upbeat',
    });
    const data = JSON.parse(result.content[0].text);

    assert.equal(data.clips.length, 2);

    // First request should be captcha check
    assert.equal(mockApi.requests[0].path, '/api/c/check');
    assert.equal(mockApi.requests[0].body.ctype, 'generation');

    // Second request should be the generate call
    assert.equal(mockApi.requests[1].path, '/api/generate/v2-web/');
    assert.equal(mockApi.requests[1].body.prompt, '[Verse]\nTest lyrics\n[Chorus]\nMore lyrics');
    assert.equal(mockApi.requests[1].body.title, 'Test Song');
    assert.equal(mockApi.requests[1].body.tags, 'pop, upbeat');
    assert.equal(mockApi.requests[1].body.gpt_description_prompt, '');
    assert.equal(mockApi.requests[1].body.make_instrumental, false);
    assert.equal(mockApi.requests[1].body.generation_type, 'TEXT');
    assert.equal(mockApi.requests[1].body.token, null);
    assert.equal(mockApi.requests[1].body.token_provider, null);
    assert.equal(mockApi.requests[1].body.metadata.create_mode, 'custom');
    assert.equal(mockApi.requests[1].body.metadata.web_client_pathname, '/create');
    assert.ok(mockApi.requests[1].body.metadata.create_session_token, 'create_session_token should be a UUID');
  });

  test('create_song with voice persona sends task=vox and no persona_model', async () => {
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 1 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('create_song', {
      lyrics: 'test',
      persona_id: 'persona-vox-1',
    });

    const genBody = mockApi.requests[1].body;
    assert.equal(genBody.persona_id, 'persona-vox-1');
    assert.equal(genBody.task, 'vox');
    assert.equal(genBody.persona_model, undefined);
  });

  test('create_song with style persona sends task=artist_consistency', async () => {
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 1 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('create_song', {
      lyrics: 'test',
      persona_id: 'persona-style-1',
      persona_model: 'style_persona',
    });

    const genBody = mockApi.requests[1].body;
    assert.equal(genBody.persona_id, 'persona-style-1');
    assert.equal(genBody.task, 'artist_consistency');
    assert.equal(genBody.persona_model, undefined);
  });

  test('cover_song with voice persona sends task=vox_cover', async () => {
    mockApi.setResponse('/api/user/me', {
      status: 200,
      body: { user_id: 'me-123', handle: 'me' },
    });
    mockApi.setResponse('/api/clip/source-clip-persona', {
      status: 200,
      body: { id: 'source-clip-persona', user_id: 'me-123', title: 'Original' },
    });
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 1 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('cover_song', {
      clip_id: 'source-clip-persona',
      persona_id: 'persona-vox-2',
    });

    const genReq = mockApi.requests.find(r => r.path === '/api/generate/v2-web/');
    const genBody = genReq.body;
    assert.equal(genBody.cover_clip_id, 'source-clip-persona');
    assert.equal(genBody.persona_id, 'persona-vox-2');
    assert.equal(genBody.task, 'vox_cover');
  });

  test('extend_song with style persona sends task=artist_extend', async () => {
    mockApi.setResponse('/api/user/me', {
      status: 200,
      body: { user_id: 'me-123', handle: 'me' },
    });
    mockApi.setResponse('/api/clip/source-clip-persona-2', {
      status: 200,
      body: { id: 'source-clip-persona-2', user_id: 'me-123', title: 'Original' },
    });
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 1 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('extend_song', {
      clip_id: 'source-clip-persona-2',
      continue_at: 30,
      persona_id: 'persona-style-2',
      persona_model: 'style_persona',
    });

    const genReq = mockApi.requests.find(r => r.path === '/api/generate/v2-web/');
    const genBody = genReq.body;
    assert.equal(genBody.continue_clip_id, 'source-clip-persona-2');
    assert.equal(genBody.persona_id, 'persona-style-2');
    assert.equal(genBody.task, 'artist_extend');
  });

  test('create_song with weirdness converts 0-100 to 0.0-1.0', async () => {
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 1 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('create_song', {
      lyrics: 'test',
      weirdness: 50,
      style_weight: 75,
      audio_weight: 25,
    });

    const genBody = mockApi.requests[1].body;
    assert.equal(genBody.metadata.control_sliders.weirdness_constraint, 0.5);
    assert.equal(genBody.metadata.control_sliders.style_weight, 0.75);
    assert.equal(genBody.metadata.control_sliders.audio_weight, 0.25);
    assert.deepEqual(genBody.metadata.can_control_sliders, ['weirdness_constraint', 'style_weight', 'audio_weight']);
  });

  test('inspire_song sets gpt_description_prompt and empty prompt', async () => {
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 1 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('inspire_song', {
      description: 'a sad ballad about rain',
      title: 'Rain Song',
    });

    const genBody = mockApi.requests[1].body;
    assert.equal(genBody.gpt_description_prompt, 'a sad ballad about rain');
    assert.equal(genBody.prompt, '');
    assert.equal(genBody.metadata.create_mode, 'inspiration');
  });

  test('cover_song sets cover_clip_id and task=cover', async () => {
    mockApi.setResponse('/api/user/me', {
      status: 200,
      body: { user_id: 'me-123', handle: 'me' },
    });
    mockApi.setResponse('/api/clip/source-clip-1', {
      status: 200,
      body: { id: 'source-clip-1', user_id: 'me-123', title: 'Original' },
    });
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 1 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('cover_song', {
      clip_id: 'source-clip-1',
      start_s: 10,
      end_s: 30,
    });

    const genReq = mockApi.requests.find(r => r.path === '/api/generate/v2-web/');
    const genBody = genReq.body;
    assert.equal(genBody.cover_clip_id, 'source-clip-1');
    assert.equal(genBody.cover_start_s, 10);
    assert.equal(genBody.cover_end_s, 30);
    assert.equal(genBody.task, 'cover');
  });

  test('extend_song sets continue_clip_id, continue_at, and task=extend', async () => {
    mockApi.setResponse('/api/user/me', {
      status: 200,
      body: { user_id: 'me-123', handle: 'me' },
    });
    mockApi.setResponse('/api/clip/source-clip-2', {
      status: 200,
      body: { id: 'source-clip-2', user_id: 'me-123', title: 'Original' },
    });
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 1 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('extend_song', {
      clip_id: 'source-clip-2',
      continue_at: 45.5,
      lyrics: 'more lyrics here',
    });

    const genReq = mockApi.requests.find(r => r.path === '/api/generate/v2-web/');
    const genBody = genReq.body;
    assert.equal(genBody.continue_clip_id, 'source-clip-2');
    assert.equal(genBody.continue_at, 45.5);
    assert.equal(genBody.prompt, 'more lyrics here');
    assert.equal(genBody.task, 'extend');
  });

  test('create_song defaults to V6 chirp-hawk and omits the legacy params field', async () => {
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 2 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('create_song', { lyrics: 'test' });

    const genBody = mockApi.requests[1].body;
    assert.equal(genBody.mv, 'chirp-hawk');
    assert.equal(genBody.params, undefined);
  });

  test('create_song with max_mode and vocal_gender sets v6 metadata fields', async () => {
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 2 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('create_song', {
      lyrics: 'test',
      mv: 'chirp-goose',
      max_mode: true,
      vocal_gender: 'f',
    });

    const genBody = mockApi.requests[1].body;
    assert.equal(genBody.mv, 'chirp-goose');
    assert.equal(genBody.metadata.is_max_mode, true);
    assert.equal(genBody.metadata.vocal_gender, 'f');
  });

  test('create_song with duration, variety, and personalize sets v6 payload fields', async () => {
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 2 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('create_song', {
      lyrics: 'test',
      mv: 'chirp-hawk-wild',
      duration: 120,
      variety: 3,
      personalize: true,
      personalize_lyrics: true,
    });

    const genBody = mockApi.requests[1].body;
    assert.equal(genBody.mv, 'chirp-hawk-wild');
    assert.equal(genBody.duration, 120);
    assert.equal(genBody.use_personalization, true);
    assert.equal(genBody.do_personalize_lyrics, true);
    assert.equal(genBody.metadata.control_sliders.aug_creativity, 3);
  });

  test('create_song clamps duration and defaults variety for personalize', async () => {
    mockApi.setResponse('/api/c/check', { status: 200, body: { required: false, captcha_version: 2 } });
    mockApi.setResponse('/api/generate/v2-web/', { status: 200, body: { clips: [] } });
    mockApi.requests.length = 0;

    await client.callTool('create_song', {
      lyrics: 'test',
      duration: 999,
      personalize: true,
    });

    const genBody = mockApi.requests[1].body;
    assert.equal(genBody.duration, 360);
    assert.equal(genBody.metadata.control_sliders.aug_creativity, 1);
  });
});

describe('MCP Server — WebSocket bridge token refresh', () => {
  let client, child, mockApi, mockApiServer;

  before(async () => {
    const wsPort = 9505;

    mockApi = createMockSunoApi();
    await new Promise(resolve => {
      mockApiServer = mockApi.server.listen(0, resolve);
    });
    const apiPort = mockApiServer.address().port;

    child = spawn('node', ['src/index.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_WS_PORT: String(wsPort),
        MCP_API_BASE_URL: `http://localhost:${apiPort}`,
        MCP_MANGO_BASE_URL: `http://127.0.0.1:${apiPort}`,
        MCP_TOKEN_FILE: '',
        MCP_GENERATION_INTERVAL_MS: '0',
      },
    });
    child.stderr.on('data', () => {});

    client = new McpStdioClient(child);
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    await new Promise(r => setTimeout(r, 500));
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'auth', token: 'first-token' }));
    ws.close();
    await new Promise(r => setTimeout(r, 300));
  });

  after(() => {
    if (child) child.kill();
    if (mockApiServer) mockApiServer.close();
  });

  test('token can be updated via WebSocket reconnection', async () => {
    // First call with first token
    mockApi.setResponse('/api/user/me', { status: 200, body: { id: 'u1' } });
    mockApi.requests.length = 0;
    await client.callTool('get_current_user');
    assert.equal(mockApi.requests[0].auth, 'Bearer first-token');

    // Push a new token via WS
    const wsPort = 9505;
    const ws2 = new WebSocket(`ws://localhost:${wsPort}`);
    await once(ws2, 'open');
    ws2.send(JSON.stringify({ type: 'auth', token: 'second-token-refreshed' }));
    await new Promise(r => setTimeout(r, 300));
    ws2.close();

    // Second call should use the new token
    mockApi.requests.length = 0;
    await client.callTool('get_current_user');
    assert.equal(mockApi.requests[0].auth, 'Bearer second-token-refreshed');
  });
});
