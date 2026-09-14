export const config = {
  wsPort: parseInt(process.env.MCP_WS_PORT || '9423', 10),
  apiBaseUrl: process.env.MCP_API_BASE_URL || 'https://studio-api.prod.suno.com',
  // The media license ("mango") endpoint lives on a different host than the
  // main API (note the hyphen). Overridable for tests.
  mangoBaseUrl: process.env.MCP_MANGO_BASE_URL || 'https://studio-api-prod.suno.com',
  maxRetries: 5,
  initialRetryDelayMs: 1000,
  captchaTimeoutMs: parseInt(process.env.MCP_CAPTCHA_TIMEOUT_MS || '120000', 10),
  // Minimum spacing between generation submissions. Bursty batches make
  // Cloudflare escalate Turnstile to an interactive challenge, so serialise
  // generation calls with a small randomized gap (0 disables, e.g. in tests).
  generationMinIntervalMs: parseInt(process.env.MCP_GENERATION_INTERVAL_MS || '20000', 10),
  tokenRefreshTimeoutMs: 15000,
  // Comments expose other users' content; opt-in only.
  allowComments: process.env.MCP_ALLOW_COMMENTS === 'true',
  // Prompt library lives in the extension's IndexedDB; surfaced via WS relay.
  extensionRequestTimeoutMs: 15000,
  // Debug dump of the latest auth token. Set MCP_TOKEN_FILE='' to disable
  // (tests do this so they don't clobber the live token file).
  tokenFile: process.env.MCP_TOKEN_FILE === undefined ? '/tmp/suno_token.txt' : (process.env.MCP_TOKEN_FILE || null),
};
