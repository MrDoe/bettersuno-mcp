import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyEdits, findNodeAtLocation, getNodeValue, modify, parse, parseTree } = require('jsonc-parser');

export const SERVER_KEY = 'bettersuno-mcp';
export const SERVER_ENTRY = {
  type: 'local',
  command: ['npx', '-y', 'bettersuno-mcp'],
  enabled: true,
};
export const SKIP_VAR = 'BETTERSUNO_MCP_SKIP_SETUP';
export const CONFIG_VAR = 'BETTERSUNO_MCP_CONFIG';

const tag = '[bettersuno-mcp]';

export function manualSnippet() {
  return JSON.stringify({ mcp: { [SERVER_KEY]: SERVER_ENTRY } }, null, 2);
}

function globalConfigDir() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
}

function configCandidates(scope, projectDir) {
  if (scope === 'global') {
    const dir = globalConfigDir();
    return [join(dir, 'opencode.jsonc'), join(dir, 'opencode.json')];
  }
  return [
    join(projectDir, 'opencode.jsonc'),
    join(projectDir, 'opencode.json'),
    join(projectDir, '.opencode', 'opencode.json'),
  ];
}

function pickTarget(scope, projectDir) {
  const existing = configCandidates(scope, projectDir).find((p) => existsSync(p));
  if (existing) return existing;
  const dir = scope === 'global' ? globalConfigDir() : projectDir;
  return join(dir, 'opencode.json');
}

function validate(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    return { ok: false, error: `JSONC error ${errors[0].error} at offset ${errors[0].offset}` };
  }
  return { ok: true, value };
}

function alreadyRegistered(text) {
  if (!text.trim()) return false;
  const tree = parseTree(text);
  if (tree) {
    const mcp = findNodeAtLocation(tree, ['mcp']);
    if (!mcp) return false;
    return JSON.stringify(getNodeValue(mcp) ?? {}).toLowerCase().includes('bettersuno');
  }
  return /bettersuno/i.test(text);
}

function buildConfig(text) {
  if (!text.trim()) {
    return `${JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { [SERVER_KEY]: SERVER_ENTRY },
    }, null, 2)}\n`;
  }
  const existing = validate(text);
  if (!existing.ok) throw new Error(`existing config is not valid JSONC (${existing.error})`);
  const value = existing.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('existing config is not a JSON object');
  }
  const edits = modify(text, ['mcp', SERVER_KEY], SERVER_ENTRY, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  return applyEdits(text, edits);
}

/**
 * Register the bettersuno-mcp server in an opencode config file.
 *
 * Options:
 *   scope:       'auto' (detect from npm env), 'global', or 'project'
 *   configPath:  explicit config file to edit (overrides scope detection)
 *   projectDir:  project root for 'project' / 'auto' scope (default: INIT_CWD or cwd)
 *   packageDir:  package root, used by 'auto' to skip the package's own dev installs
 *   quiet:       suppress console output
 */
export function setupOpencodeConfig(options = {}) {
  const {
    scope = 'auto',
    configPath,
    projectDir = process.env.INIT_CWD || process.cwd(),
    packageDir,
    quiet = false,
  } = options;

  const say = quiet ? () => {} : (msg) => console.log(`${tag} ${msg}`);
  const shout = quiet ? () => {} : (msg) => console.warn(`${tag} ${msg}`);

  try {
    if (scope === 'auto' && (process.env[SKIP_VAR] === '1' || process.env[SKIP_VAR] === 'true')) {
      say(`skipping opencode config update (${SKIP_VAR} set)`);
      return { status: 'skipped', reason: 'skip-env' };
    }

    let resolvedScope = scope === 'project' ? 'project' : 'global';
    const dir = resolve(projectDir);

    if (scope === 'auto') {
      const isGlobal = process.env.npm_config_global === 'true' || process.env.npm_config_location === 'global';
      resolvedScope = isGlobal ? 'global' : 'project';
      if (!isGlobal && packageDir && dir === resolve(packageDir)) {
        say('running inside the package repository — skipping opencode config update');
        return { status: 'skipped', reason: 'package-dir' };
      }
    }

    const target = configPath
      ? resolve(configPath)
      : process.env[CONFIG_VAR]
        ? resolve(process.env[CONFIG_VAR])
        : pickTarget(resolvedScope, dir);

    const text = existsSync(target) ? readFileSync(target, 'utf8') : '';

    if (alreadyRegistered(text)) {
      say(`server already registered in ${target}`);
      return { status: 'exists', path: target };
    }

    const updated = buildConfig(text);
    const check = validate(updated);
    if (!check.ok) {
      shout(`refusing to write invalid config to ${target} (${check.error})`);
      shout(`add this manually:\n${manualSnippet()}`);
      return { status: 'invalid', path: target, error: check.error };
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, updated);
    say(`registered MCP server in ${target}`);
    say('quit and restart opencode to load it');
    return { status: 'registered', path: target };
  } catch (err) {
    shout(`could not update opencode config: ${err.message}`);
    shout(`add this manually:\n${manualSnippet()}`);
    return { status: 'error', error: err.message };
  }
}

export function runSetupCli(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: bettersuno-mcp setup [options]

Registers the bettersuno-mcp server in an opencode config.

Options:
  --global          Write to the global config (default)
                    ~/.config/opencode/opencode.json[c]
  --project         Write to the config in the current directory
                    ./opencode.json[c] or ./.opencode/opencode.json
  --config <path>   Write to a specific config file
  -h, --help        Show this help`);
    return 0;
  }

  const configIndex = args.indexOf('--config');
  if (configIndex >= 0 && !args[configIndex + 1]) {
    console.warn(`${tag} --config requires a path`);
    return 1;
  }

  const result = setupOpencodeConfig({
    scope: args.includes('--project') ? 'project' : 'global',
    configPath: configIndex >= 0 ? args[configIndex + 1] : undefined,
    projectDir: process.cwd(),
  });

  return result.status === 'registered' || result.status === 'exists' ? 0 : 1;
}
