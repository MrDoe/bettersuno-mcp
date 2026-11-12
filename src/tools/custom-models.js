import { sunoClient } from '../suno-client.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

function isCustomModel(model) {
  if (!model || typeof model !== 'object') return false;
  if (Array.isArray(model.badges) && model.badges.includes('custom')) return true;
  return typeof model.external_key === 'string' && model.external_key.startsWith('chirp-custom:');
}

function normalizeCustomModel(model) {
  return {
    id: model.external_key || model.id || null,
    name: model.name || null,
    description: model.description || null,
    major_version: model.major_version ?? null,
    can_use: model.can_use ?? null,
    is_default_model: !!model.is_default_model,
    badges: model.badges || [],
    capabilities: model.capabilities || [],
    features: model.features || [],
  };
}

export function registerCustomModelTools(server, allTools) {
  const tools = [
    tool('list_custom_models', 'List your custom models. Reads the model list from /api/billing/info/ and filters to custom models (chirp-custom:* / custom badge).', {
      type: 'object',
      properties: {
        include_unusable: { type: 'boolean', description: 'Include models with can_use=false', default: false },
      },
    }, async (args) => {
      const result = await sunoClient.GET('/api/billing/info/');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch billing models');
      const data = result.data || {};
      let models = (data.models || []).filter(isCustomModel);
      if (args.include_unusable !== true) models = models.filter((m) => m.can_use !== false);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            models: models.map(normalizeCustomModel),
            count: models.length,
            max_active_custom_models: data.max_active_custom_models ?? null,
            max_custom_model_clips: data.max_custom_model_clips ?? null,
          }, null, 2),
        }],
      };
    }),

    tool('list_custom_model_bases', 'List the base models available for creating a custom model.', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/custom-model/bases/');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch custom model bases');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_pending_custom_models', 'Check whether custom models are currently being trained and list pending models.', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/custom-model/pending/');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch pending custom models');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('rename_custom_model', 'Rename one of your custom models.', {
      type: 'object',
      properties: {
        custom_model_id: { type: 'string', description: 'Custom model ID (chirp-custom:...)' },
        name: { type: 'string', description: 'New model name' },
      },
      required: ['custom_model_id', 'name'],
    }, async (args) => {
      const result = await sunoClient.PUT('/api/custom-model/edit/', {
        body: { id: args.custom_model_id, name: args.name },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to rename custom model');
      return { content: [{ type: 'text', text: JSON.stringify({ renamed: true, ...result.data }, null, 2) }] };
    }),

    tool('archive_custom_model', 'Archive (delete) one of your custom models.', {
      type: 'object',
      properties: {
        custom_model_id: { type: 'string', description: 'Custom model ID (chirp-custom:...)' },
      },
      required: ['custom_model_id'],
    }, async (args) => {
      const result = await sunoClient.POST('/api/custom-model/archive/', {
        body: { id: args.custom_model_id },
      });
      if (!result.ok) throw new Error(result.error || 'Failed to archive custom model');
      return { content: [{ type: 'text', text: JSON.stringify({ archived: true, custom_model_id: args.custom_model_id }, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
