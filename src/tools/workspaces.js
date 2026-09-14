import { sunoClient } from '../suno-client.js';
import { assertOwned } from '../auth.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

async function assertWorkspaceOwned(projectId) {
  const result = await sunoClient.GET(`/api/project/${encodeURIComponent(projectId)}`);
  if (!result.ok) throw new Error(result.error || 'Failed to fetch workspace');
  if (result.data?.is_owned === false) {
    throw new Error(`Access denied: workspace ${projectId} is not owned by you`);
  }
  return result.data;
}

async function mutateWorkspace(projectId, updateType, metadata) {
  const result = await sunoClient.POST(`/api/project/${encodeURIComponent(projectId)}/clips`, {
    body: { update_type: updateType, metadata },
  });
  if (!result.ok) throw new Error(result.error || `Failed to ${updateType} songs in workspace`);
  return result;
}

const CLIP_IDS_PROP = {
  type: 'array',
  items: { type: 'string' },
  description: 'Array of song clip IDs',
};

export function registerWorkspaceTools(server, allTools) {
  const tools = [
    tool('list_projects', 'List your projects/workspaces', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/project/feed');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch projects');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_project', 'Get project/workspace details', {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
      },
      required: ['project_id'],
    }, async (args) => {
      const result = await sunoClient.GET(`/api/project/${encodeURIComponent(args.project_id)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch project');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_project_clips', 'List clips/songs in a project', {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
      },
      required: ['project_id'],
    }, async (args) => {
      // NOTE: GET /api/project/{id}/clips is not a valid route (405). The
      // project detail endpoint returns the clips in `project_clips`.
      const result = await sunoClient.GET(`/api/project/${encodeURIComponent(args.project_id)}`);
      if (!result.ok) throw new Error(result.error || 'Failed to fetch project clips');
      const data = result.data || {};
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            project_id: args.project_id,
            name: data.name,
            clip_count: data.clip_count ?? (data.project_clips || []).length,
            clips: data.project_clips || [],
          }, null, 2),
        }],
      };
    }),

    tool('create_workspace', 'Create a new workspace (project)', {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workspace name' },
        description: { type: 'string', description: 'Workspace description (optional)' },
      },
      required: ['name'],
    }, async (args) => {
      const name = String(args.name || '').trim().slice(0, 100);
      if (!name) throw new Error('Workspace name is required');
      const result = await sunoClient.POST('/api/project', {
        body: { name, description: args.description || '' },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to create workspace');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('add_songs_to_workspace', 'Add songs to a workspace (they stay in the library)', {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Workspace ID' },
        clip_ids: { ...CLIP_IDS_PROP, description: 'Song clip IDs to add' },
      },
      required: ['project_id', 'clip_ids'],
    }, async (args) => {
      if (!Array.isArray(args.clip_ids) || args.clip_ids.length === 0) {
        throw new Error('Provide at least one clip ID');
      }
      await assertWorkspaceOwned(args.project_id);
      for (const id of args.clip_ids) await assertOwned(id);
      await mutateWorkspace(args.project_id, 'add', { clip_ids: args.clip_ids });
      return { content: [{ type: 'text', text: JSON.stringify({ added: args.clip_ids.length, project_id: args.project_id }, null, 2) }] };
    }),

    tool('remove_songs_from_workspace', 'Remove songs from a workspace (they stay in the library)', {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Workspace ID' },
        clip_ids: { ...CLIP_IDS_PROP, description: 'Song clip IDs to remove' },
      },
      required: ['project_id', 'clip_ids'],
    }, async (args) => {
      if (!Array.isArray(args.clip_ids) || args.clip_ids.length === 0) {
        throw new Error('Provide at least one clip ID');
      }
      await assertWorkspaceOwned(args.project_id);
      for (const id of args.clip_ids) await assertOwned(id);
      await mutateWorkspace(args.project_id, 'remove', { clip_ids: args.clip_ids });
      return { content: [{ type: 'text', text: JSON.stringify({ removed: args.clip_ids.length, project_id: args.project_id }, null, 2) }] };
    }),

    tool('move_songs_to_workspace', 'Move songs into a workspace from the library or another workspace (auto-detects each song\'s current workspace)', {
      type: 'object',
      properties: {
        target_project_id: { type: 'string', description: 'Destination workspace ID' },
        clip_ids: { ...CLIP_IDS_PROP, description: 'Song clip IDs to move' },
        source_project_id: { type: 'string', description: 'Optional source workspace ID (defaults to each clip\'s current project, or the library)' },
      },
      required: ['target_project_id', 'clip_ids'],
    }, async (args) => {
      if (!Array.isArray(args.clip_ids) || args.clip_ids.length === 0) {
        throw new Error('Provide at least one clip ID');
      }
      await assertWorkspaceOwned(args.target_project_id);

      const groups = new Map();
      for (const id of args.clip_ids) {
        const clip = await assertOwned(id);
        const source = args.source_project_id || clip.project?.id || 'default';
        if (!groups.has(source)) groups.set(source, []);
        groups.get(source).push(id);
      }

      const results = [];
      for (const [source, clipIds] of groups) {
        if (source === 'default' || source === args.target_project_id) {
          // From the library (or already there): membership add on the target.
          try {
            await mutateWorkspace(args.target_project_id, 'add', { clip_ids: clipIds });
            results.push({ source, action: 'add', ok: true, clip_ids: clipIds });
          } catch (err) {
            results.push({ source, action: 'add', ok: false, error: err.message, clip_ids: clipIds });
          }
        } else {
          // Between workspaces: move via the source project.
          try {
            await mutateWorkspace(source, 'move', { clip_ids: clipIds, target_project_id: args.target_project_id });
            results.push({ source, action: 'move', ok: true, clip_ids: clipIds });
          } catch (err) {
            results.push({ source, action: 'move', ok: false, error: err.message, clip_ids: clipIds });
          }
        }
      }

      const failed = results.filter(r => !r.ok);
      if (failed.length === results.length) {
        throw new Error(`Failed to move songs: ${failed.map(f => f.error).join('; ')}`);
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            target_project_id: args.target_project_id,
            moved: results.filter(r => r.ok).reduce((n, r) => n + r.clip_ids.length, 0),
            results,
          }, null, 2),
        }],
      };
    }),
  ];

  allTools.push(...tools);
}
