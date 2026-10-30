import { sunoClient } from './suno-client.js';
import { getToken } from './ws-bridge.js';

let _currentUser = null;
let _currentUserToken = undefined;

export async function getCurrentUser({ refresh = false } = {}) {
  const token = getToken();
  // The extension pushes a fresh token on every (re)connect, and the Suno
  // account behind it can change (user logs out and back in as someone else).
  // Never serve a user cached under a different token — after an account
  // switch every ownership check would fail against the stale identity.
  // (No token + warm cache: keep serving the cache. Every real API call needs
  // a token anyway, and this preserves offline introspection.)
  if (!refresh && _currentUser && (token === null || token === _currentUserToken)) {
    return _currentUser;
  }
  const result = await sunoClient.GET('/api/user/me');
  if (!result.ok) throw new Error(result.error || 'Failed to fetch current user');
  const d = result.data || {};
  _currentUser = {
    user_id: d.user_id || d.id || d.userId || null,
    handle: d.handle || d.username || d.user_handle || null,
  };
  _currentUserToken = token;
  if (!_currentUser.user_id) {
    throw new Error('Could not determine current user id from /api/user/me');
  }
  return _currentUser;
}

export async function fetchClip(clipId) {
  const result = await sunoClient.GET(`/api/clip/${encodeURIComponent(clipId)}`);
  if (!result.ok) throw new Error(result.error || 'Song not found');
  return result.data;
}

function clipOwnerId(clip) {
  if (!clip || typeof clip !== 'object') return null;
  return clip.user_id || clip.owner_user_id || clip.user?.id || clip.metadata?.user_id || null;
}

// Throws unless the clip belongs to the current user.
export async function assertOwned(clipId) {
  const clip = await fetchClip(clipId);
  if (!ownershipDenied(clip, await getCurrentUser())) return clip;
  // The cached user may predate an account switch (or a token rotation that
  // landed between our calls). Refresh once before denying.
  if (!ownershipDenied(clip, await getCurrentUser({ refresh: true }))) return clip;
  throw new Error(
    `Access denied: song ${clipId} is not in your library ` +
    `(owned by @${clip.handle || clipOwnerId(clip) || 'unknown'}).`
  );
}

function ownershipDenied(clip, me) {
  const owner = clipOwnerId(clip);
  return !owner || (me.user_id && owner !== me.user_id);
}

function isOwnClip(clip, me) {
  const owner = clipOwnerId(clip);
  return Boolean(me.user_id && owner === me.user_id);
}

// Covering/remixing your own songs is always allowed.
// Covering/remixing another artist's song is only allowed when that
// song's metadata.can_remix flag is enabled by its owner.
export async function assertCanCover(clipId) {
  const clip = await fetchClip(clipId);
  const me = await getCurrentUser();
  if (isOwnClip(clip, me)) return clip;
  // As in assertOwned: the cached user may predate an account switch.
  // Refresh once so your own songs are recognised before falling back to
  // the can_remix check for other artists' songs.
  if (isOwnClip(clip, await getCurrentUser({ refresh: true }))) return clip;
  const canRemix = clip.metadata?.can_remix === true;
  if (!canRemix) {
    throw new Error(
      `Cover/remix denied: "${clip.title || clipId}" by @${clip.handle || clipOwnerId(clip) || 'unknown'} ` +
      `does not allow remixing (metadata.can_remix is not enabled).`
    );
  }
  return clip;
}
