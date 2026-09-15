#!/usr/bin/env node
/**
 * localfig — drives the Figma DESKTOP APP through a local HTTP bridge
 * and a Figma dev plugin. No Figma cloud API, no account quotas.
 *
 *   MCP client --stdio(JSON-RPC)--> this process --http(127.0.0.1)--> Figma plugin --> Plugin API
 *
 * Zero dependencies: node:http + node:fs only.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Everything that is per-user or generated lives OUTSIDE the package: the package may sit in a
// read-only global install or the npx cache, and the plugin path the user imports must survive updates.
const HOME = process.env.LOCALFIG_HOME || path.join(os.homedir(), '.localfig');
const PORT = Number(process.env.LOCALFIG_PORT || process.env.FIGMA_BRIDGE_PORT || 8765);
const HOST = '127.0.0.1';
const OUT_DIR = process.env.LOCALFIG_OUT || process.env.FIGMA_BRIDGE_OUT || path.join(HOME, 'exports');
const PLUGIN_DIR = path.join(HOME, 'plugin');
const VERSION = '0.4.1';
const POLL_HOLD_MS = 25000;
const DEFAULT_TIMEOUT_MS = 60000;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(PLUGIN_DIR, { recursive: true });

const log = (...a) => process.stderr.write('[localfig] ' + a.join(' ') + '\n');

/* ---------------------------------------------------------------- token --- */
const tokenFile = path.join(HOME, 'token');
let TOKEN = '';
try { TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
if (!/^[0-9a-f]{32}$/.test(TOKEN)) {
  // Pre-0.4 layouts kept the token next to the server; carry it over so an already imported plugin keeps working.
  try { TOKEN = fs.readFileSync(path.join(HERE, '.token'), 'utf8').trim(); } catch {}
  if (!/^[0-9a-f]{32}$/.test(TOKEN)) TOKEN = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
}

// Materialize the plugin into HOME/plugin: manifest + code copied from the package, ui.html baked
// with token + port. That folder is what gets imported into Figma; dev plugins re-read it on each run.
function materializeUi() {
  const src = path.join(HERE, 'plugin');
  const put = (file, data) => {
    const dst = path.join(PLUGIN_DIR, file);
    let prev = '';
    try { prev = fs.readFileSync(dst, 'utf8'); } catch {}
    if (prev !== data) fs.writeFileSync(dst, data);
  };
  try {
    for (const f of ['manifest.json', 'code.js']) put(f, fs.readFileSync(path.join(src, f), 'utf8'));
    put('ui.html', fs.readFileSync(path.join(src, 'ui.template.html'), 'utf8')
      .split('__TOKEN__').join(TOKEN)
      .split('__PORT__').join(String(PORT)));
  } catch (e) { log('plugin files missing: ' + e.message); }
}

/* ---------------------------------------------------------------- setup --- */
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// How MCP clients launch localfig. From an npm/npx install that is the package, never a cache path;
// on Windows npx goes through cmd /c because most clients spawn servers without a shell.
function launchSpec() {
  if (/node_modules/.test(HERE)) {
    return IS_WIN ? { command: 'cmd', args: ['/c', 'npx', '-y', 'localfig'] } : { command: 'npx', args: ['-y', 'localfig'] };
  }
  return { command: 'node', args: [path.join(HERE, 'server.mjs')] };
}

function clientDirs() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const macSupport = path.join(home, 'Library', 'Application Support');
  const vscodeUser = IS_WIN ? path.join(appData, 'Code', 'User') : IS_MAC ? path.join(macSupport, 'Code', 'User') : path.join(xdg, 'Code', 'User');
  return { home, appData, xdg, macSupport, vscodeUser };
}

const plainEntry = (s) => ({ command: s.command, args: s.args });

// Every MCP client setup knows. dir = the folder whose existence means the client is installed,
// file = its user-level MCP config inside that folder, key = where servers live in that file.
// locate(d), when present, returns the config file itself, or null when the client is not installed.
const CLIENTS = [
  { id: 'claude-code', name: 'Claude Code', kind: 'claude-cli' },
  { id: 'claude-desktop', name: 'Claude Desktop', kind: 'json', key: 'mcpServers', file: 'claude_desktop_config.json',
    dir: (d) => (IS_WIN ? path.join(d.appData, 'Claude') : IS_MAC ? path.join(d.macSupport, 'Claude') : path.join(d.xdg, 'Claude')) },
  { id: 'cursor', name: 'Cursor', kind: 'json', key: 'mcpServers', file: 'mcp.json', dir: (d) => path.join(d.home, '.cursor') },
  { id: 'windsurf', name: 'Windsurf', kind: 'json', key: 'mcpServers', file: 'mcp_config.json', dir: (d) => path.join(d.home, '.codeium', 'windsurf') },
  { id: 'vscode', name: 'VS Code', kind: 'json', key: 'servers', file: 'mcp.json', dir: (d) => d.vscodeUser,
    entry: (s) => ({ type: 'stdio', command: s.command, args: s.args }) },
  // Cline (extension and CLI) reads ~/.cline/data/settings/cline_mcp_settings.json; older extension builds
  // used VS Code's globalStorage. The ~/.cline/mcp.json in Cline's docs is wrong (cline/cline#11671).
  { id: 'cline', name: 'Cline', kind: 'json', key: 'mcpServers', locate: (d) => {
    if (process.env.CLINE_MCP_SETTINGS_PATH) return process.env.CLINE_MCP_SETTINGS_PATH;
    const data = process.env.CLINE_DATA_DIR || path.join(d.home, '.cline', 'data');
    if (fs.existsSync(data)) return path.join(data, 'settings', 'cline_mcp_settings.json');
    const legacy = path.join(d.vscodeUser, 'globalStorage', 'saoudrizwan.claude-dev', 'settings');
    return fs.existsSync(legacy) ? path.join(legacy, 'cline_mcp_settings.json') : null;
  } },
  { id: 'gemini', name: 'Gemini CLI', kind: 'json', key: 'mcpServers', file: 'settings.json', dir: (d) => path.join(d.home, '.gemini') },
  { id: 'codex', name: 'Codex', kind: 'toml', file: 'config.toml', dir: (d) => path.join(d.home, '.codex') },
  { id: 'opencode', name: 'opencode', kind: 'json', key: 'mcp', file: 'opencode.json', dir: (d) => path.join(d.xdg, 'opencode'),
    entry: (s) => ({ type: 'local', command: [s.command].concat(s.args), enabled: true }) },
  { id: 'zed', name: 'Zed', kind: 'json', key: 'context_servers', file: 'settings.json',
    dir: (d) => (IS_WIN ? path.join(d.appData, 'Zed') : path.join(d.xdg, 'zed')) },
  { id: 'lmstudio', name: 'LM Studio', kind: 'json', key: 'mcpServers', file: 'mcp.json', dir: (d) => path.join(d.home, '.lmstudio') },
];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameEntry = (current, entry) => isObj(current) && Object.keys(entry).every((k) => JSON.stringify(current[k]) === JSON.stringify(entry[k]));
const countOf = (s, ch) => s.split(ch).length - 1;

function onPath(bin) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const f = path.join(dir, bin + ext);
      try { if (fs.statSync(f).isFile()) return f; } catch {}
    }
  }
  return null;
}

function runBin(file, args) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    const q = (a) => (/[\s"&|<>^()]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a);
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + [file].concat(args).map(q).join(' ') + '"'], { encoding: 'utf8', windowsVerbatimArguments: true });
  }
  return spawnSync(file, args, { encoding: 'utf8' });
}

// Removes // and /* */ comments outside strings plus trailing commas. Only used to tell "JSON with
// comments" apart from "broken JSON": files with comments are reported, never rewritten.
function withoutComments(txt) {
  let out = '';
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < txt.length && txt[j] !== '"') j += txt[j] === '\\' ? 2 : 1;
      out += txt.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '/' && txt[i + 1] === '/') { while (i < txt.length && txt[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && txt[i + 1] === '*') { const e = txt.indexOf('*/', i + 2); i = e < 0 ? txt.length : e + 1; continue; }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function writeWithBackup(file, text, existed) {
  let backup = null;
  if (existed) { backup = file + '.localfig.bak'; fs.copyFileSync(file, backup); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return backup;
}

function registerJson(file, key, entry, dryRun) {
  const existed = fs.existsSync(file);
  let obj = {};
  if (existed) {
    const txt = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    if (txt.trim()) {
      try { obj = JSON.parse(txt); } catch {
        let commented = false;
        try { JSON.parse(withoutComments(txt)); commented = true; } catch {}
        return { status: 'skipped', note: commented ? 'this file has comments, so setup does not rewrite it; paste the entry shown below' : 'this file is not valid JSON; left untouched' };
      }
    }
    if (!isObj(obj)) return { status: 'skipped', note: 'unexpected file layout; left untouched' };
  }
  if (obj[key] !== undefined && !isObj(obj[key])) return { status: 'skipped', note: '"' + key + '" is not an object; left untouched' };
  const current = isObj(obj[key]) ? obj[key].localfig : undefined;
  if (sameEntry(current, entry)) return { status: 'up to date' };
  if (dryRun) return { status: current ? 'would update' : 'would add' };
  const servers = isObj(obj[key]) ? obj[key] : (obj[key] = {});
  servers.localfig = Object.assign(isObj(current) ? current : {}, entry); // keeps env and any other field the user set
  return { status: current ? 'updated' : 'added', backup: writeWithBackup(file, JSON.stringify(obj, null, 2) + '\n', existed) };
}

// Codex keeps MCP servers in TOML tables: [mcp_servers.localfig] with command / args.
function registerToml(file, spec, dryRun) {
  const existed = fs.existsSync(file);
  const txt = existed ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '') : '';
  const eol = txt.includes('\r\n') ? '\r\n' : '\n';
  const want = ['command = ' + JSON.stringify(spec.command), 'args = [' + spec.args.map((a) => JSON.stringify(a)).join(', ') + ']'];
  const rows = txt.split(/\r?\n/);
  const head = rows.findIndex((l) => /^\s*\[\s*mcp_servers\s*\.\s*(?:"localfig"|'localfig'|localfig)\s*\]\s*(?:#.*)?$/.test(l));
  if (head < 0) {
    // an inline or dotted definition would collide with a new table, so leave those files alone
    if (/^\s*mcp_servers\s*[.=]/m.test(txt) || /^\s*localfig\s*[.=]/m.test(txt)) {
      return { status: 'skipped', note: 'mcp_servers or localfig is defined inline in this file; left untouched' };
    }
    if (dryRun) return { status: 'would add' };
    const sep = !txt ? '' : (/\n$/.test(txt) ? '' : eol) + eol;
    return { status: 'added', backup: writeWithBackup(file, txt + sep + '[mcp_servers.localfig]' + eol + want.join(eol) + eol, existed) };
  }
  let end = rows.length;
  for (let i = head + 1; i < rows.length; i++) if (/^\s*\[/.test(rows[i])) { end = i; break; }
  const kept = [], old = [];
  let depth = 0; // open brackets of a multi-line args array being replaced
  for (const row of rows.slice(head + 1, end)) {
    if (depth > 0) { old.push(row.trim()); depth += countOf(row, '[') - countOf(row, ']'); continue; }
    const m = row.match(/^\s*(command|args)\s*=(.*)$/);
    if (m) { old.push(row.trim()); if (m[1] === 'args') depth = countOf(m[2], '[') - countOf(m[2], ']'); continue; }
    kept.push(row);
  }
  if (old.join('\n') === want.join('\n')) return { status: 'up to date' };
  if (dryRun) return { status: 'would update' };
  const next = rows.slice(0, head + 1).concat(want, kept, rows.slice(end));
  return { status: 'updated', backup: writeWithBackup(file, next.join(eol), existed) };
}

// Claude Code owns ~/.claude.json and rewrites it constantly, so it is changed through its CLI only.
function registerClaudeCode(spec, dryRun) {
  const bin = onPath('claude');
  if (!bin) return { status: 'not found' };
  const where = 'claude mcp, user scope';
  let current;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    current = isObj(j.mcpServers) ? j.mcpServers.localfig : undefined;
  } catch {}
  if (sameEntry(current, plainEntry(spec))) return { status: 'up to date', where };
  if (dryRun) return { status: current ? 'would update' : 'would add', where };
  if (current) runBin(bin, ['mcp', 'remove', 'localfig', '--scope', 'user']);
  const args = ['mcp', 'add', '--transport', 'stdio', 'localfig', '--scope', 'user'];
  if (isObj(current) && isObj(current.env)) for (const k of Object.keys(current.env)) args.push('--env', k + '=' + current.env[k]);
  args.push('--', spec.command, ...spec.args);
  const r = runBin(bin, args);
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : ((r.stderr || '') + (r.stdout || '')).trim().split('\n')[0];
    return { status: 'failed', where, note: (why || 'claude mcp add failed') + '. Run: claude mcp add --scope user localfig -- ' + [spec.command].concat(spec.args).join(' ') };
  }
  return { status: current ? 'updated' : 'added', where };
}

async function runSetup({ dryRun, only }) {
  const say = (s) => process.stdout.write(s + '\n');
  const manifest = path.join(PLUGIN_DIR, 'manifest.json');
  const spec = launchSpec();
  let wanted = CLIENTS;
  if (only !== null && only !== undefined) {
    const ids = String(only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = ids.filter((id) => !CLIENTS.some((c) => c.id === id));
    if (!ids.length || unknown.length) {
      say('Unknown client: ' + (unknown.join(', ') || '(none given)') + '. Known clients: ' + CLIENTS.map((c) => c.id).join(', '));
      return 2;
    }
    wanted = CLIENTS.filter((c) => ids.includes(c.id));
  }
  if (!dryRun) materializeUi();
  const dirs = clientDirs();
  say('localfig ' + VERSION + ' setup' + (dryRun ? ' (dry run: nothing is written or executed)' : ''));
  say('  secret:   ' + tokenFile);
  say('  plugin:   ' + PLUGIN_DIR + '  (token and port baked in)');
  say('  exports:  ' + OUT_DIR);
  say('');
  say('1. Register localfig with the MCP clients on this machine');
  say('   launch command: ' + [spec.command].concat(spec.args).join(' '));
  const pad = ' '.repeat(33);
  const missing = [];
  let changed = 0, failed = 0;
  for (const c of wanted) {
    let res;
    try {
      if (c.kind === 'claude-cli') res = registerClaudeCode(spec, dryRun);
      else {
        const file = c.locate ? c.locate(dirs) : (fs.existsSync(c.dir(dirs)) ? path.join(c.dir(dirs), c.file) : null);
        if (!file) res = { status: 'not found' };
        else {
          res = c.kind === 'toml' ? registerToml(file, spec, dryRun) : registerJson(file, c.key, (c.entry || plainEntry)(spec), dryRun);
          res.where = file;
        }
      }
    } catch (e) {
      res = { status: 'failed', note: e.message };
    }
    if (res.status === 'not found') { missing.push(c.name); continue; }
    if (res.status === 'added' || res.status === 'updated') changed++;
    if (res.status === 'failed') failed++;
    say('   ' + c.name.padEnd(17) + res.status.padEnd(13) + (res.where || ''));
    if (res.note) say(pad + res.note);
    if (res.backup) say(pad + 'backup: ' + res.backup);
  }
  if (missing.length) say('   Not found: ' + missing.join(', '));
  if (changed) say('   Restart any of those apps that is already running so it loads localfig.');
  say('   Any other MCP client: add this to its MCP config');
  say('     ' + JSON.stringify({ mcpServers: { localfig: plainEntry(spec) } }));
  say('');
  say('2. Import the plugin into the Figma DESKTOP app (once):');
  say('     open any design file, then Figma menu (top-left logo) > Plugins > Development > Import plugin from manifest…');
  say('     ' + manifest);
  say('   (or press Ctrl+/ — Cmd+/ on Mac — and type "import plugin from manifest")');
  say('');
  say('3. Every session, from inside the file you want to edit:');
  say('     Ctrl+/ and type "localfig"  —  or Ctrl+Alt+P / Cmd+Opt+P to re-run the last plugin.');
  say('   The panel says "Connected to localfig" once the MCP server is up. Leave it open.');
  return failed ? 1 : 0;
}

function argValue(name) {
  const i = process.argv.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i < 0) return null;
  const a = process.argv[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (process.argv[i + 1] || '');
}
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write([
    'localfig ' + VERSION + ' — the Figma desktop app as an MCP server',
    '',
    '  node server.mjs                    run the MCP server (stdio) + local bridge; what your MCP client launches',
    '  node server.mjs --setup            one-time setup: secret, plugin, and registration in every MCP client found',
    '  node server.mjs --setup --dry-run  show what setup would do, without writing or running anything',
    '  --clients=cursor,vscode            with --setup: only these clients',
    '',
    '  clients: ' + CLIENTS.map((c) => c.id).join(', '),
    '',
    '  env LOCALFIG_HOME  token, plugin and exports (default ~/.localfig)',
    '  env LOCALFIG_PORT  bridge port (default 8765; also change networkAccess in the manifest and re-import)',
    '  env LOCALFIG_OUT   export directory (default ~/.localfig/exports)',
    '',
  ].join('\n'));
  process.exit(0);
}
if (process.argv.includes('--setup')) {
  process.exit(await runSetup({ dryRun: process.argv.includes('--dry-run'), only: argValue('--clients') }));
}

/* --------------------------------------------------------------- bridge --- */
let nextId = 1;
const queue = [];            // commands not yet handed to the plugin
const pending = new Map();   // id -> { resolve, reject, timer }
const assets = new Map();    // assetId -> Buffer (bytes headed INTO Figma)
let waiter = null;           // parked long-poll response
let waiterTimer = null;
let pluginInfo = null;       // last /hello payload
let pluginSeen = 0;          // ms epoch of last plugin contact
let clientMode = false;      // true => another instance owns the port

function flush() {
  if (!waiter || !queue.length) return;
  const res = waiter; const t = waiterTimer;
  waiter = null; waiterTimer = null;
  if (t) clearTimeout(t);
  sendJson(res, 200, queue.shift());
}

function enqueueLocal(kind, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const timer = setTimeout(() => {
      pending.delete(id);
      const i = queue.findIndex((c) => c.id === id);
      if (i >= 0) queue.splice(i, 1);
      reject(new Error(
        pluginSeen
          ? 'Timed out after ' + timeoutMs + 'ms waiting for the Figma plugin.'
          : 'No Figma plugin connected. In Figma: Plugins > Development > localfig (import ' + path.join(PLUGIN_DIR, 'manifest.json') + ' once).'
      ));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    queue.push({ id, kind, payload });
    flush();
  });
}

async function enqueueRemote(kind, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const body = JSON.stringify({ kind, payload, timeoutMs });
  let res;
  try {
    res = await fetch('http://' + HOST + ':' + PORT + '/command?t=' + TOKEN, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
  } catch (e) {
    // The owner we deferred to at startup is gone. Take the port ourselves and serve locally.
    if (await tryBecomeOwner()) return enqueueLocal(kind, payload, timeoutMs);
    throw new Error('Bridge owner on port ' + PORT + ' is unreachable (' + e.message + ') and the port could not be re-bound.');
  }
  const j = await res.json().catch(() => ({ ok: false, error: 'bad response from bridge owner' }));
  if (!j.ok) throw new Error(j.error || 'bridge error');
  return j.result;
}

const enqueue = (kind, payload, timeoutMs) =>
  (clientMode ? enqueueRemote : enqueueLocal)(kind, payload, timeoutMs);

/* ----------------------------------------------------------------- http --- */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
};
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj === undefined ? {} : obj));
  res.writeHead(code, Object.assign({}, CORS, { 'content-type': 'application/json', 'content-length': b.length }));
  res.end(b);
}
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const safeName = (s) => String(s || 'node').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'node';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true, service: 'localfig', version: VERSION,
      pluginConnected: Date.now() - pluginSeen < 40000, plugin: pluginInfo,
    });
  }
  if (url.searchParams.get('t') !== TOKEN) return sendJson(res, 401, { ok: false, error: 'bad token' });

  try {
    if (url.pathname === '/hello' && req.method === 'POST') {
      pluginInfo = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      pluginSeen = Date.now();
      log('plugin connected: ' + (pluginInfo.fileName || '?'));
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/poll' && req.method === 'GET') {
      pluginSeen = Date.now();
      if (queue.length) return sendJson(res, 200, queue.shift());
      if (waiter) {
        const old = waiter; waiter = null;
        if (waiterTimer) clearTimeout(waiterTimer);
        sendJson(old, 200, {});
      }
      waiter = res;
      waiterTimer = setTimeout(() => { waiter = null; waiterTimer = null; sendJson(res, 200, {}); }, POLL_HOLD_MS);
      res.on('close', () => {
        if (waiter === res) { waiter = null; if (waiterTimer) clearTimeout(waiterTimer); }
      });
      return;
    }

    if (url.pathname === '/blob' && req.method === 'POST') {
      pluginSeen = Date.now();
      const bytes = await readBody(req);
      const file = path.join(OUT_DIR, safeName(url.searchParams.get('name')));
      fs.writeFileSync(file, bytes);
      return sendJson(res, 200, { ok: true, path: file, bytes: bytes.length });
    }

    if (url.pathname === '/asset' && req.method === 'GET') {
      const b = assets.get(url.searchParams.get('id'));
      if (!b) return sendJson(res, 404, { ok: false, error: 'unknown asset' });
      res.writeHead(200, Object.assign({}, CORS, {
        'content-type': 'application/octet-stream', 'content-length': b.length,
      }));
      return res.end(b);
    }

    if (url.pathname === '/result' && req.method === 'POST') {
      pluginSeen = Date.now();
      const msg = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const p = pending.get(String(msg.id));
      if (p) {
        pending.delete(String(msg.id));
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'plugin error'));
      }
      return sendJson(res, 200, { ok: true });
    }

    // Used by sibling MCP instances that lost the port race.
    if (url.pathname === '/command' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (body.kind === 'placeImage' && body.payload && body.payload.filePath && body.payload.assetId) {
        try { assets.set(body.payload.assetId, fs.readFileSync(body.payload.filePath)); } catch (e) {
          return sendJson(res, 200, { ok: false, error: 'cannot read ' + body.payload.filePath + ': ' + e.message });
        }
      }
      try {
        const result = await enqueueLocal(body.kind, body.payload, body.timeoutMs);
        return sendJson(res, 200, { ok: true, result });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message });
      }
    }
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message });
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
});

function listenOnce(srv, host) {
  return new Promise((resolve) => {
    const onErr = (e) => { srv.off('listening', onOk); resolve(e); };
    const onOk = () => { srv.off('error', onErr); resolve(null); };
    srv.once('error', onErr);
    srv.once('listening', onOk);
    srv.listen(PORT, host);
  });
}

// Figma rejects raw IPs in networkAccess, so the plugin fetches http://localhost.
// On Windows that resolves to ::1 first, so mirror onto IPv6 loopback (still local-only).
function mirrorV6() {
  const v6 = http.createServer(server.listeners('request')[0]);
  v6.on('error', (err) => log('ipv6 loopback unavailable: ' + err.message));
  v6.listen(PORT, '::1', () => log('bridge also on http://[::1]:' + PORT));
}

let electing = null;
// Client mode + owner unreachable => try to bind the port. Shared promise so concurrent
// tool calls don't race each other into ERR_SERVER_ALREADY_LISTEN.
function tryBecomeOwner() {
  if (!clientMode) return Promise.resolve(true);
  if (!electing) {
    electing = (async () => {
      const e = await listenOnce(server, HOST);
      if (e) { log('re-election: port ' + PORT + ' still taken (' + (e.code || e.message) + ')'); return false; }
      clientMode = false;
      log('re-election: previous owner gone, now serving the bridge on http://' + HOST + ':' + PORT);
      mirrorV6();
      return true;
    })().finally(() => { electing = null; });
  }
  return electing;
}

async function startBridge() {
  materializeUi();
  const e = await listenOnce(server, HOST);
  if (!e) {
    log('bridge on http://' + HOST + ':' + PORT + ' (out: ' + OUT_DIR + ')');
    mirrorV6();
    return;
  }
  if (e.code !== 'EADDRINUSE') { log('http error: ' + e.message); return; }
  // Someone holds the port. Run as client either way: if the holder is a bridge we proxy to
  // it; if it is something else, or it dies later, the first tool call re-elects (above).
  clientMode = true;
  try {
    const r = await fetch('http://' + HOST + ':' + PORT + '/health').then((x) => x.json());
    if (r.service === 'localfig') log('port ' + PORT + ' already served by another localfig; running as client');
    else log('port ' + PORT + ' taken by something else; will retry binding on the first tool call');
  } catch { log('port ' + PORT + ' taken by a non-bridge process; will retry binding on the first tool call'); }
}

/* -------------------------------------------------------- inline images --- */
const INLINE_MAX_BYTES = 2 * 1024 * 1024;
// PNG/JPG exports ride along as MCP image content, so the caller sees the render
// without a second tool call. Larger files fall back to the path in the text block.
function inlineImages(out) {
  const items = [];
  for (const e of (out && out.exported) || []) {
    const ext = path.extname(e.file || '').toLowerCase();
    const mime = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : null;
    if (!mime || !e.path) continue;
    try {
      const size = fs.statSync(e.path).size;
      if (size > INLINE_MAX_BYTES) { items.push({ type: 'text', text: e.file + ': ' + size + ' bytes, over the inline limit — Read the path instead.' }); continue; }
      items.push({ type: 'image', data: fs.readFileSync(e.path).toString('base64'), mimeType: mime });
    } catch (err) {
      items.push({ type: 'text', text: e.file + ': could not inline (' + err.message + ')' });
    }
  }
  return items;
}

/* ---------------------------------------------------------------- tools --- */
const EVAL_DOC = `Run JavaScript against the Figma file where the localfig plugin is open, with the full Figma Plugin API. Use it to create, edit, move or delete nodes, and for anything the other tools do not cover. For reading a design, prefer figma_metadata, figma_find and figma_tokens; for images from disk, use figma_place_image.

Behavior: the code can change or delete anything in the file. Each call is one undo step for the person, and figma_history can undo it within 60 seconds. Returns the JSON-serialized value of your return statement. Return plain data such as ids, names and numbers, because Figma nodes collapse to {id, name, type}.

Code rules:
- The body runs inside an async function, so await and return both work. Globals: figma and helpers.
- Use await figma.getNodeByIdAsync(id); the synchronous getNodeById is unavailable. Switch pages with await figma.setCurrentPageAsync(page).
- Load fonts before changing text, or use helpers.setText.
- resize() resets text auto-resize and auto-layout sizing modes, so set those after resizing, or use helpers.set and helpers.createText, which do it in the right order.
- End with helpers.reveal(nodes) so the person sees what changed.

helpers: setText(node, chars), loadNodeFonts(node), createText({characters, font, fontSize, color, width, lineHeight, letterSpacing, name, parent, x, y}), set(node, props), rgb("#rrggbb"), rgba("#rrggbbaa"), query(root, selector), createAutoLayout(direction, props), reveal(nodes), notify(message), collection(name, modes), token(collection, name, type, value), bind(node, property, variable), importComponent(key), instance(key, parent, props), command(kind, payload).`;

const TOOLS = [
  {
    name: 'figma_status',
    title: 'Figma connection status',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: `Check whether localfig can reach Figma and what the plugin is looking at. Call it first in a session, whenever another tool reports that no plugin is connected or times out, and after the person switches files. Read-only. Returns the bridge state: owner or client, version and export folder. When the Figma plugin is connected it also returns the file name, editor type, current page, all pages, the current selection, the top-level layers of the page with positions and sizes, the signed-in user's name when available, and whether code execution is available for figma_eval. When the plugin is not connected, the result explains how to start it in Figma.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'figma_eval',
    title: 'Run Figma Plugin API code',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: EVAL_DOC,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: `JavaScript body to run. Use return to send JSON-serializable data back, for example: const n = await figma.getNodeByIdAsync("10:59"); return { id: n.id, name: n.name };` },
        timeoutMs: { type: 'integer', minimum: 1000, default: 60000, description: `How long to wait for the code to finish, in milliseconds. Raise it for long batch edits. Default 60000.` },
      },
      required: ['code'], additionalProperties: false,
    },
  },
  {
    name: 'figma_metadata',
    title: 'Read the layer tree',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: `Read the layer tree of a node or of the current page: ids, names, types, positions, sizes and text content. Use it to understand an existing design and to get node ids before editing with figma_eval. To search a large file by name or text, use figma_find instead; for the file's variables and styles, use figma_tokens. Read-only. With styles:true each node also lists its fills, strokes, effects, corner radius, auto-layout, fonts, bound variables, named styles and component properties; css:true adds the CSS Figma generates for each node. Returns {tree, nodeCount, truncated}; reading stops at maxNodes and sets truncated to true.`,
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: `Id of the node to start from, as returned by figma_find or figma_status, for example "10:59". Omit to read the whole current page.` },
        depth: { type: 'integer', minimum: 0, default: 6, description: `How many levels of children to include below the starting node. 0 returns only that node. Default 6.` },
        maxNodes: { type: 'integer', minimum: 1, default: 400, description: `Stop after this many nodes and set truncated to true. Default 400.` },
        styles: { type: 'boolean', default: false, description: `Add visual properties to every node: fills, strokes, effects, opacity, corner radius, auto-layout, fonts, bound variables, named styles and component properties. Default false.` },
        css: { type: 'boolean', default: false, description: `Add the CSS Figma generates for each node, for design-to-code handoff. Default false.` },
      }, additionalProperties: false,
    },
  },
  {
    name: 'figma_export',
    title: 'Export or render nodes',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: `Render nodes to image or data files, to see a design or hand it off. Use PNG to check your work visually: PNG and JPG results up to 2 MB come back inline as images. Use SVG for icons and vector assets, PDF for print, and JSON for the node tree in Figma REST API format, which design-to-code tools read; SVG and JSON up to 200 KB also come back inline as text. For layer structure without rendering, use figma_metadata. Does not change the Figma file. Writes files to the localfig exports folder, replacing files with the same name. Omitting nodeIds exports the current selection. Returns {exported}: one entry per node with its file name, path, size in bytes and, for SVG or JSON, the text.`,
    inputSchema: {
      type: 'object',
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' }, description: `Ids of the nodes to export, for example ["10:59"]. Omit to export the nodes selected in Figma; the call fails if nothing is selected.` },
        format: { type: 'string', enum: ['PNG', 'JPG', 'SVG', 'PDF', 'JSON'], default: 'PNG', description: `PNG or JPG for images, SVG for vectors, PDF for print, JSON for the node tree in Figma REST API format. Default PNG.` },
        scale: { type: 'number', exclusiveMinimum: 0, default: 1, description: `PNG and JPG only. Size multiplier: 1 is actual size, 2 is double resolution, 0.5 is a quick preview. Default 1.` },
        inline: { type: 'boolean', default: true, description: `Return PNG and JPG results as images in the response. Set false for large batches when only the files are needed. Default true.` },
        contentsOnly: { type: 'boolean', default: true, description: `Export only this node, ignoring other layers that overlap it. Default true.` },
        useAbsoluteBounds: { type: 'boolean', default: false, description: `Use the node's full dimensions even where it is cropped or surrounded by empty space, for example to export text layers without cropping. Default false.` },
      }, additionalProperties: false,
    },
  },
  {
    name: 'figma_tokens',
    title: 'Read design tokens and styles',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: `List the design system defined in the open file: every local variable collection with its modes and each variable's value per mode, plus local paint, text and effect styles. Use it before generating code from a design or building new screens, so you reuse existing tokens instead of hard-coding colors and sizes. Variables from team libraries are not included; use figma_library for those. To see which token a specific node uses, call figma_metadata with styles:true. Read-only. Colors are hex strings and aliases appear as {variable name}. Returns {collections, styles, counts}.`,
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: `Only return collections whose name contains this text, case-insensitive, for example "Brand". Omit for all collections.` },
        includeStyles: { type: 'boolean', default: true, description: `Include local paint, text and effect styles. Default true.` },
        maxVariables: { type: 'integer', minimum: 1, default: 2000, description: `Stop after this many variables in total; the collection being read when the limit is reached is marked truncated. Default 2000.` },
      }, additionalProperties: false,
    },
  },
  {
    name: 'figma_find',
    title: 'Find nodes',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: `Search the file for nodes by type, layer name or text content. Use it to locate things in a large file before reading them with figma_metadata or editing them with figma_eval. To browse one known frame, use figma_metadata instead. Read-only. Filters combine, so a node must match every filter given; with no filters, every node is listed up to the limit. Searching all pages first loads every page, which is slower on big files. Returns {hits, scanned, pages, truncated}. Each hit has id, name, type, page, position and size, plus the first 120 characters for text nodes.`,
    inputSchema: {
      type: 'object',
      properties: {
        types: { type: 'array', items: { type: 'string' }, description: `Node types to include, in capitals, for example ["TEXT"] or ["FRAME", "INSTANCE", "COMPONENT"]. Omit to include every type.` },
        name: { type: 'string', description: `Regular expression matched against layer names, case-insensitive, for example "button" or "^Card".` },
        text: { type: 'string', description: `Regular expression matched against the text of TEXT nodes, case-insensitive. When set, other node types never match.` },
        scope: { type: 'string', enum: ['current', 'all'], default: 'current', description: `"current" searches the page open in Figma; "all" loads and searches every page, which is slower. Default current.` },
        limit: { type: 'integer', minimum: 1, default: 200, description: `Maximum number of hits to return; truncated is true when the limit was reached. Default 200.` },
      }, additionalProperties: false,
    },
  },
  {
    name: 'figma_changes',
    title: 'Recent changes in the file',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: `Report what changed in the file since your last check: nodes created, deleted or edited, with the properties that changed. Use it before editing a design the person may have touched, so you do not overwrite their work, and pass the returned seq as since on the next call. Edits made by localfig's own tools are hidden unless includePlugin is true. They are recognized by timing, so an edit the person makes within two seconds of a tool call can be misattributed. Only pages the plugin has seen are tracked, and the buffer keeps the last 1000 changes. Read-only. Returns {seq, total, returned, summary, changes}, where summary groups the listed changes per node.`,
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', minimum: 0, description: `The seq value returned by your previous call; only newer changes are returned. Omit to get everything still in the buffer.` },
        includePlugin: { type: 'boolean', default: false, description: `Also include edits made by localfig's own tools. Default false.` },
        limit: { type: 'integer', minimum: 1, default: 200, description: `Maximum number of changes to list, keeping the newest. The summary covers only the listed changes. Default 200.` },
      }, additionalProperties: false,
    },
  },
  {
    name: 'figma_history',
    title: 'Save a version or undo',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: `Save a restore point, or undo localfig's most recent edit. action "snapshot" saves a named version to the file's version history, which the person can restore from Figma; use it before large or risky changes. action "undo" reverts every edit made by the most recent figma_eval, figma_place_image or figma_library import, but only within 60 seconds of that call; after that, the person can still press Ctrl+Z in Figma, where each tool call is one undo step. Snapshot adds a version and changes nothing else; undo modifies the file. Returns {ok, action}, plus the title and version id for a snapshot.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['snapshot', 'undo'], description: `"snapshot" saves a named version of the file; "undo" reverts the last editing tool call if it ran within the last 60 seconds.` },
        title: { type: 'string', description: `Snapshot only. Name for the version, for example "Before redesign". Default "localfig" followed by the current date and time.` },
        description: { type: 'string', description: `Snapshot only. A longer note stored with the version.` },
      }, required: ['action'], additionalProperties: false,
    },
  },
  {
    name: 'figma_library',
    title: 'Use team library items',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: `Use components, styles and variables from the team libraries enabled for this file. action "collections" lists the library variable collections available; "variables" lists the variables in one collection; "import" copies one component, component set, style or variable into this file by its key and, for a component, can also place an instance. Use it to build with the team's design system instead of recreating parts. Component keys of existing instances come from figma_metadata with styles:true. Listing is read-only; import adds items to the file and counts as one undo step. Needs the teamlibrary permission, which the localfig plugin requests. Returns the list for collections and variables, or {id, name, kind} plus instanceId for an import.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['collections', 'variables', 'import'], description: `"collections" lists library variable collections; "variables" lists the variables in one collection and needs collectionKey; "import" brings one item into the file and needs key.` },
        collectionKey: { type: 'string', description: `For action "variables": the key of a collection, taken from the collections result.` },
        key: { type: 'string', description: `For action "import": the library key of the component, component set, style or variable to import.` },
        kind: { type: 'string', enum: ['component', 'componentSet', 'style', 'variable'], default: 'component', description: `For action "import": what the key refers to. Default component.` },
        instance: { type: 'boolean', default: false, description: `When importing a component: also place an instance of it in the file. Default false.` },
        parentId: { type: 'string', description: `For a placed instance: id of the frame or page that receives it. Default is the current page.` },
        x: { type: 'number', description: `For a placed instance: horizontal position in pixels, relative to its parent.` },
        y: { type: 'number', description: `For a placed instance: vertical position in pixels, relative to its parent.` },
      }, required: ['action'], additionalProperties: false,
    },
  },
  {
    name: 'figma_place_image',
    title: 'Place an image',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: `Fill a node with a local image file, such as a photo or an illustration. Use it instead of figma_eval whenever the image comes from disk. The node must support fills, like a rectangle, ellipse or frame, and its existing fills are replaced by the image. Any format a browser can read works, including PNG, JPG, WebP, GIF, BMP and AVIF; images larger than maxSide are scaled down first, and formats Figma cannot read are converted to PNG. Counts as one undo step. Returns the image and node sizes, plus a prepared object describing any resizing or conversion.`,
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: `Absolute path of the image file on this computer, for example "C:/Users/me/Pictures/photo.jpg" or "/Users/me/photo.png".` },
        nodeId: { type: 'string', description: `Id of the node that receives the image, for example "10:59". It must support fills, such as a rectangle, ellipse or frame.` },
        scaleMode: { type: 'string', enum: ['FILL', 'FIT', 'CROP', 'TILE'], default: 'FILL', description: `FILL covers the whole node and crops the overflow, FIT shows the whole image inside the node, CROP positions it with a crop transform, TILE repeats it. Default FILL.` },
        maxSide: { type: 'integer', minimum: 1, maximum: 4096, default: 4096, description: `Largest allowed width or height in pixels; larger images are scaled down first. Default 4096, which is also Figma's limit.` },
      },
      required: ['filePath', 'nodeId'], additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'figma_status': {
      // Built after enqueue(): a re-election inside it can flip client -> owner.
      const health = () => ({
        bridge: 'http://' + HOST + ':' + PORT,
        mode: clientMode ? 'client' : 'owner',
        home: HOME, pluginManifest: path.join(PLUGIN_DIR, 'manifest.json'),
        outDir: OUT_DIR, version: VERSION,
      });
      try {
        const r = await enqueue('status', {}, 10000);
        return Object.assign(health(), { pluginConnected: true }, r);
      } catch (e) {
        return Object.assign(health(), { pluginConnected: false, error: e.message });
      }
    }
    case 'figma_eval':
      return enqueue('eval', { code: args.code }, args.timeoutMs || DEFAULT_TIMEOUT_MS);
    case 'figma_metadata':
      return enqueue('metadata', {
        nodeId: args.nodeId,
        depth: args.depth === undefined ? 6 : args.depth,
        maxNodes: args.maxNodes === undefined ? 400 : args.maxNodes,
        styles: !!args.styles,
        css: !!args.css,
      });
    case 'figma_find':
      return enqueue('find', { types: args.types, name: args.name, text: args.text, scope: args.scope, limit: args.limit }, 120000);
    case 'figma_changes':
      return enqueue('changes', { since: args.since, includePlugin: args.includePlugin, limit: args.limit }, 10000);
    case 'figma_history':
      return enqueue('history', { action: args.action, title: args.title, description: args.description }, 60000);
    case 'figma_library':
      return enqueue('library', { action: args.action, collectionKey: args.collectionKey, key: args.key, kind: args.kind, instance: args.instance, parentId: args.parentId, x: args.x, y: args.y }, 120000);
    case 'figma_tokens':
      return enqueue('tokens', { collection: args.collection, includeStyles: args.includeStyles, maxVariables: args.maxVariables }, 60000);
    case 'figma_export':
      return enqueue('export', {
        nodeIds: args.nodeIds,
        format: (args.format || 'PNG').toUpperCase(),
        scale: args.scale === undefined ? 1 : args.scale,
        contentsOnly: args.contentsOnly,
        useAbsoluteBounds: args.useAbsoluteBounds,
      }, 120000);
    case 'figma_place_image': {
      const bytes = fs.readFileSync(args.filePath);
      const assetId = crypto.randomBytes(8).toString('hex');
      assets.set(assetId, bytes);
      try {
        return await enqueue('placeImage', {
          assetId,
          nodeId: args.nodeId,
          scaleMode: args.scaleMode || 'FILL',
          maxSide: args.maxSide || 4096,
          sizeBytes: bytes.length,
          name: path.basename(args.filePath),
          filePath: path.resolve(args.filePath), // lets a bridge owner in another process read it
        }, 120000);
      } finally {
        setTimeout(() => assets.delete(assetId), 120000);
      }
    }
    default:
      throw new Error('unknown tool: ' + name);
  }
}

/* ------------------------------------------------------------ mcp/stdio --- */
const write = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'localfig', version: VERSION },
          instructions: 'Drives the local Figma desktop app via a dev plugin. Run "localfig" in Figma (Plugins > Development) and keep it open; every tool acts on that file. No cloud quota applies.',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping': return ok(id, {});
      case 'tools/list': return ok(id, { tools: TOOLS });
      case 'resources/list': return ok(id, { resources: [] });
      case 'prompts/list': return ok(id, { prompts: [] });
      case 'tools/call': {
        const toolName = params && params.name;
        const toolArgs = (params && params.arguments) || {};
        const out = await callTool(toolName, toolArgs);
        const content = [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }];
        if (toolName === 'figma_export' && toolArgs.inline !== false) content.push(...inlineImages(out));
        return ok(id, { content });
      }
      default:
        if (isNotification) return;
        return err(id, -32601, 'method not found: ' + method);
    }
  } catch (e) {
    if (isNotification) return;
    return ok(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { err(null, -32700, 'parse error'); continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

await startBridge();
