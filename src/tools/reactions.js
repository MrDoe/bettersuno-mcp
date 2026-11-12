import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

async function setSaved(collectionType, id, save) {
  const path = `/api/playlist/v2/${encodeURIComponent(id)}/save`;
  const result = save
    ? await sunoClient.POST(path, { body: {} })
    : await sunoClient.DELETE(path);
  if (!result.ok) throw new Error(result.error || `Failed to ${save ? 'save' : 'unsave'} ${collectionType}`);
  return result.data;
}

async function setPinned(collectionType, id, pin) {
  const path = `/api/playlist/v2/${encodeURIComponent(id)}/pin`;
  const result = pin
    ? await sunoClient.POST(path, { body: {} })
    : await sunoClient.DELETE(path);
  if (!result.ok) throw new Error(result.error || `Failed to ${pin ? 'pin' : 'unpin'} ${collectionType}`);
  return result.data;
}

export function registerReactionTools(server, allTools) {
  const tools = [
    tool('like_album', 'Save a public album by another user to your library, or remove it. Suno rejects saving your own albums (use pin_album for those).', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
        like: { type: 'boolean', description: 'True to save/like, false to remove/unsave', default: true },
      },
      required: ['album_id'],
    }, async (args) => {
      const like = args.like !== false;
      const data = await setSaved('album', args.album_id, like);
      return { content: [{ type: 'text', text: JSON.stringify({ album_id: args.album_id, liked: like, ...data }, null, 2) }] };
    }),

    tool('like_playlist', 'Save a public playlist by another user to your library, or remove it. Suno rejects saving your own playlists (use pin_playlist for those).', {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'Playlist ID' },
        like: { type: 'boolean', description: 'True to save/like, false to remove/unsave', default: true },
      },
      required: ['playlist_id'],
    }, async (args) => {
      const like = args.like !== false;
      const data = await setSaved('playlist', args.playlist_id, like);
      return { content: [{ type: 'text', text: JSON.stringify({ playlist_id: args.playlist_id, liked: like, ...data }, null, 2) }] };
    }),

    tool('pin_album', 'Pin an album in your library or unpin it.', {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'Album ID' },
        pin: { type: 'boolean', description: 'True to pin, false to unpin', default: true },
      },
      required: ['album_id'],
    }, async (args) => {
      const pin = args.pin !== false;
      const data = await setPinned('album', args.album_id, pin);
      return { content: [{ type: 'text', text: JSON.stringify({ album_id: args.album_id, pinned: pin, ...data }, null, 2) }] };
    }),

    tool('pin_playlist', 'Pin a playlist in your library or unpin it.', {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'Playlist ID' },
        pin: { type: 'boolean', description: 'True to pin, false to unpin', default: true },
      },
      required: ['playlist_id'],
    }, async (args) => {
      const pin = args.pin !== false;
      const data = await setPinned('playlist', args.playlist_id, pin);
      return { content: [{ type: 'text', text: JSON.stringify({ playlist_id: args.playlist_id, pinned: pin, ...data }, null, 2) }] };
    }),

    tool('set_playlist_visibility', 'Change whether a playlist is public or private.', {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'Playlist ID' },
        is_public: { type: 'boolean', description: 'True for public, false for private' },
      },
      required: ['playlist_id', 'is_public'],
    }, async (args) => {
      const result = await sunoClient.PATCH(`/api/playlist/v2/${encodeURIComponent(args.playlist_id)}`, {
        body: { metadata: { is_public: args.is_public === true } },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update playlist visibility');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
