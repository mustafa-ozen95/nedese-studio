/**
 * Names of the files and folders inside panel-data, in one place (user request 08.10.2026: "merkezi tanımla"). The
 * English rename moved indirmeler.json and oturumlar.json to these names (migrate.mjs) while the server still opened the
 * old ones, so the download records were not found; every module takes the names from here now.
 */
export const DATA_FILES = {
  settings: 'settings.json',
  database: 'panel.db',
  downloads: 'downloads.json',
  sessions: 'sessions.json',
  chat: 'chat',
  mcp: 'mcp.json',
  skills: 'skills',
  plugins: 'plugins',
  rules: 'rules.md',
  presets: 'chat-presets.json',
  templates: 'prompt-templates.json',
  projects: 'projects.json',
  projectFolder: 'projects',
  migration: 'migration.json',
};

/** Names used before the English rename (migrate.mjs moves them to DATA_FILES). */
export const LEGACY_DATA_FILES = { settings: 'ayar.json', downloads: 'indirmeler.json', sessions: 'oturumlar.json', chat: 'sohbet' };
