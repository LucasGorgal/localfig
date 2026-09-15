/**
 * End-to-end test: spawns server.mjs, speaks MCP over stdio, and impersonates the
 * Figma plugin over HTTP. Verifies the full round-trip without needing Figma open.
 *   node test-e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799; // not the real bridge port, so this never disturbs a live session
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_HOME = path.join(os.tmpdir(), 'localfig-test-' + process.pid); // isolated token / plugin / exports
let TOKEN = '';

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')); }
};

let srv2 = null;
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
  env: { ...process.env, LOCALFIG_PORT: String(PORT), LOCALFIG_HOME: TEST_HOME },
  stdio: ['pipe', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => process.stderr.write('    [server] ' + d));

const replies = new Map();
let rbuf = '';
srv.stdout.on('data', (d) => {
  rbuf += d.toString();
  let i;
  while ((i = rbuf.indexOf('\n')) >= 0) {
    const line = rbuf.slice(0, i).trim(); rbuf = rbuf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const r = replies.get(msg.id);
    if (r) { replies.delete(msg.id); r(msg); }
  }
});

let rpcId = 1;
function rpc(method, params) {
  const id = rpcId++;
  return new Promise((resolve) => {
    replies.set(id, resolve);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (res) => res?.result?.content?.[0]?.text ?? '';
const jsonOf = (res) => { try { return JSON.parse(textOf(res)); } catch { return null; } };

/** Fake plugin: poll for one command, run `handler`, post the result back. */
async function actAsPlugin(handler) {
  const res = await fetch(`${BASE}/poll?t=${TOKEN}`);
  const cmd = await res.json();
  if (!cmd.id) return null;
  if (cmd.payload?.assetId) {
    const ab = await fetch(`${BASE}/asset?t=${TOKEN}&id=${cmd.payload.assetId}`).then((r) => r.arrayBuffer());
    cmd.payload.bytes = new Uint8Array(ab);
  }
  const out = await handler(cmd);
  if (out.blobs) {
    out.result.exported = [];
    for (const b of out.blobs) {
      const r = await fetch(`${BASE}/blob?t=${TOKEN}&name=${encodeURIComponent(b.name)}`, {
        method: 'POST', body: new Blob([b.bytes]),
      }).then((x) => x.json());
      out.result.exported.push({ file: b.name, path: r.path, bytes: r.bytes });
    }
    delete out.blobs;
  }
  await fetch(`${BASE}/result?t=${TOKEN}`, {
    method: 'POST', body: JSON.stringify({ id: cmd.id, ok: true, result: out.result }),
  });
  return cmd;
}

try {
  await sleep(700);

  TOKEN = fs.readFileSync(path.join(TEST_HOME, 'token'), 'utf8').trim();

  console.log('\n1. bridge http');
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check('/health identifies the service', health.service === 'localfig', JSON.stringify(health));
  check('/health reports no plugin yet', health.pluginConnected === false);
  const bad = await fetch(`${BASE}/poll?t=wrong`);
  check('bad token is rejected', bad.status === 401);

  console.log('\n2. mcp handshake');
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  check('initialize returns serverInfo', init.result?.serverInfo?.name === 'localfig');
  check('advertises tools capability', !!init.result?.capabilities?.tools);
  const list = await rpc('tools/list');
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  check('tools/list has all 10 tools',
    JSON.stringify(names) === JSON.stringify(['figma_changes', 'figma_eval', 'figma_export', 'figma_find', 'figma_history', 'figma_library', 'figma_metadata', 'figma_place_image', 'figma_status', 'figma_tokens']),
    JSON.stringify(names));
  check('every tool has an inputSchema', (list.result?.tools || []).every((t) => t.inputSchema?.type === 'object'));

  console.log('\n3. status with no plugin connected');
  const st = await rpc('tools/call', { name: 'figma_status', arguments: {} });
  const stJson = jsonOf(st);
  check('status degrades gracefully', stJson?.pluginConnected === false, textOf(st).slice(0, 120));
  check('status explains how to connect', /Plugins > Development/.test(stJson?.error || ''));

  console.log('\n4. figma_eval round-trip');
  const evalCall = rpc('tools/call', { name: 'figma_eval', arguments: { code: 'return figma.root.name;' } });
  const gotCmd = await actAsPlugin(async (cmd) => ({ result: { echoedCode: cmd.payload.code, value: 'Untitled' } }));
  check('plugin received kind=eval', gotCmd?.kind === 'eval');
  check('plugin received the code verbatim', gotCmd?.payload?.code === 'return figma.root.name;');
  const evalJson = jsonOf(await evalCall);
  check('result reaches the MCP caller', evalJson?.value === 'Untitled', JSON.stringify(evalJson));

  console.log('\n5. figma_export writes real files');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // PNG magic + IHDR start
  const exportCall = rpc('tools/call', { name: 'figma_export', arguments: { nodeIds: ['10:59'], scale: 0.5 } });
  await actAsPlugin(async () => ({ result: {}, blobs: [{ name: 'Ad_7_Stories_10-59.png', bytes: png }] }));
  const exp = jsonOf(await exportCall);
  const outPath = exp?.exported?.[0]?.path;
  check('export returns a file path', !!outPath, JSON.stringify(exp));
  check('file exists on disk with the right bytes',
    !!outPath && fs.existsSync(outPath) && fs.readFileSync(outPath).equals(png));

  console.log('\n6. figma_place_image ships local bytes into Figma');
  const imgPath = path.join(HERE, 'exports', '_test_image.bin');
  const imgBytes = Buffer.from('ffd8ffe000104a464946', 'hex'); // JPEG magic
  fs.writeFileSync(imgPath, imgBytes);
  const placeCall = rpc('tools/call', { name: 'figma_place_image', arguments: { filePath: imgPath, nodeId: '2:9' } });
  const placeCmd = await actAsPlugin(async (cmd) => ({
    result: { nodeId: cmd.payload.nodeId, receivedBytes: cmd.payload.bytes.length, matches: Buffer.from(cmd.payload.bytes).equals(imgBytes) },
  }));
  check('plugin got kind=placeImage', placeCmd?.kind === 'placeImage');
  const placed = jsonOf(await placeCall);
  check('image bytes arrive intact via /asset', placed?.matches === true && placed?.receivedBytes === imgBytes.length, JSON.stringify(placed));

  console.log('\n7. errors surface as tool errors, not crashes');
  const errCall = rpc('tools/call', { name: 'figma_place_image', arguments: { filePath: path.join(HERE, 'nope.png'), nodeId: '1:1' } });
  const errRes = await errCall;
  check('missing file is reported', errRes.result?.isError === true && /ENOENT|no such file/i.test(textOf(errRes)), textOf(errRes).slice(0, 120));
  const unknown = await rpc('tools/call', { name: 'figma_nope', arguments: {} });
  check('unknown tool is reported', unknown.result?.isError === true);
  const badMethod = await rpc('totally/unknown');
  check('unknown method returns -32601', badMethod.error?.code === -32601);

  console.log('\n8. plugin presence tracking');
  await fetch(`${BASE}/hello?t=${TOKEN}`, { method: 'POST', body: JSON.stringify({ fileName: 'Untitled', exec: { kind: 'AsyncFunction', available: true } }) });
  const health2 = await fetch(`${BASE}/health`).then((r) => r.json());
  check('/health sees the plugin after hello', health2.pluginConnected === true && health2.plugin?.fileName === 'Untitled');

  console.log('\n9. figma_export inlines PNG bytes as image content');
  const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const fakeExport = async () => ({ result: {}, blobs: [{ name: 'inline-test_1-1.png', bytes: PNG1 }] });
  const inl = rpc('tools/call', { name: 'figma_export', arguments: { nodeIds: ['1:1'] } });
  await actAsPlugin(fakeExport);
  const inlRes = await inl;
  const img = (inlRes.result?.content || []).find((c) => c.type === 'image');
  check('export result carries an image block', !!img && img.mimeType === 'image/png', JSON.stringify(inlRes.result?.content?.map((c) => c.type)));
  check('image block holds the exported bytes', !!img && Buffer.from(img.data, 'base64').equals(PNG1));
  check('text block still lists the path', /inline-test_1-1\.png/.test(textOf(inlRes)));
  const noInl = rpc('tools/call', { name: 'figma_export', arguments: { nodeIds: ['1:1'], inline: false } });
  await actAsPlugin(fakeExport);
  check('inline:false suppresses the image block', !((await noInl).result?.content || []).some((c) => c.type === 'image'));
  const inlPath = jsonOf(inlRes)?.exported?.[0]?.path;
  if (inlPath) try { fs.unlinkSync(inlPath); } catch {}

  console.log('\n10. figma_tokens, place_image maxSide, --setup --dry-run');
  const tok = rpc('tools/call', { name: 'figma_tokens', arguments: { collection: 'Brand' } });
  const tokCmd = await actAsPlugin(async () => ({ result: { collections: [{ name: 'Brand', modes: ['Light'], variables: [] }], counts: { collections: 1, variables: 0 } } }));
  check('plugin received kind=tokens with the collection filter', tokCmd?.kind === 'tokens' && tokCmd?.payload?.collection === 'Brand', JSON.stringify(tokCmd?.payload));
  check('tokens result reaches the caller', jsonOf(await tok)?.collections?.[0]?.name === 'Brand');
  const pl = rpc('tools/call', { name: 'figma_place_image', arguments: { filePath: imgPath, nodeId: '1:1', maxSide: 2048 } });
  const plCmd = await actAsPlugin(async () => ({ result: { nodeId: '1:1' } }));
  check('place_image forwards maxSide to the plugin', plCmd?.payload?.maxSide === 2048, JSON.stringify(plCmd?.payload && Object.keys(plCmd.payload)));
  await pl;
  const setup = spawnSync(process.execPath, [path.join(HERE, 'server.mjs'), '--setup', '--dry-run'], {
    env: { ...process.env, LOCALFIG_PORT: String(PORT), LOCALFIG_HOME: TEST_HOME }, encoding: 'utf8',
  });
  check('--setup --dry-run exits 0', setup.status === 0, (setup.stderr || '').slice(0, 160));
  check('--setup prints the manifest path and a generic MCP config', /manifest\.json/.test(setup.stdout) && /mcpServers/.test(setup.stdout));

  console.log('\n11. find / changes / history / library / export JSON / metadata css / annotations');
  const fnd = rpc('tools/call', { name: 'figma_find', arguments: { types: ['TEXT'], text: 'R\\$ 797', scope: 'all' } });
  const fndCmd = await actAsPlugin(async () => ({ result: { hits: [{ id: '9:9', name: 'Preço', type: 'TEXT', page: 'Page 1' }], scanned: 3, pages: 1 } }));
  check('find forwards types / text / scope', fndCmd?.kind === 'find' && fndCmd.payload?.types?.[0] === 'TEXT' && fndCmd.payload?.scope === 'all', JSON.stringify(fndCmd?.payload));
  check('find hits reach the caller', jsonOf(await fnd)?.hits?.[0]?.id === '9:9');
  const chg = rpc('tools/call', { name: 'figma_changes', arguments: { since: 41 } });
  const chgCmd = await actAsPlugin(async () => ({ result: { seq: 43, changes: [] } }));
  check('changes forwards since', chgCmd?.kind === 'changes' && chgCmd.payload?.since === 41, JSON.stringify(chgCmd?.payload));
  await chg;
  const his = rpc('tools/call', { name: 'figma_history', arguments: { action: 'snapshot', title: 'before' } });
  const hisCmd = await actAsPlugin(async () => ({ result: { ok: true, action: 'snapshot', title: 'before' } }));
  check('history forwards action + title', hisCmd?.kind === 'history' && hisCmd.payload?.action === 'snapshot' && hisCmd.payload?.title === 'before');
  await his;
  const lib = rpc('tools/call', { name: 'figma_library', arguments: { action: 'import', key: 'abc', kind: 'component', instance: true } });
  const libCmd = await actAsPlugin(async () => ({ result: { id: '5:5', name: 'Button', kind: 'component', instanceId: '5:6' } }));
  check('library forwards import args', libCmd?.kind === 'library' && libCmd.payload?.key === 'abc' && libCmd.payload?.instance === true, JSON.stringify(libCmd?.payload));
  check('library result reaches the caller', jsonOf(await lib)?.instanceId === '5:6');
  const ej = rpc('tools/call', { name: 'figma_export', arguments: { nodeIds: ['1:1'], format: 'JSON' } });
  const ejCmd = await actAsPlugin(async () => ({ result: {}, blobs: [{ name: 'n_1-1.json', bytes: '{"document":{}}' }] }));
  const ejRes = await ej;
  check('export forwards format JSON', ejCmd?.payload?.format === 'JSON', JSON.stringify(ejCmd?.payload));
  check('JSON export writes a .json file and attaches no image block', /n_1-1\.json/.test(textOf(ejRes)) && !(ejRes.result?.content || []).some((c) => c.type === 'image'));
  const ejPath = jsonOf(ejRes)?.exported?.[0]?.path;
  if (ejPath) try { fs.unlinkSync(ejPath); } catch {}
  const mdc = rpc('tools/call', { name: 'figma_metadata', arguments: { nodeId: '1:1', css: true, styles: true } });
  const mdcCmd = await actAsPlugin(async () => ({ result: { tree: { id: '1:1' }, nodeCount: 1 } }));
  check('metadata forwards css + styles flags', mdcCmd?.payload?.css === true && mdcCmd?.payload?.styles === true, JSON.stringify(mdcCmd?.payload));
  await mdc;
  const list2 = await rpc('tools/list', {});
  const ro = (list2.result?.tools || []).filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
  check('read-only tools carry readOnlyHint', JSON.stringify(ro) === JSON.stringify(['figma_changes', 'figma_find', 'figma_metadata', 'figma_status', 'figma_tokens']), JSON.stringify(ro));

  console.log('\n12. --setup registers localfig in the MCP clients it finds, without clobbering');
  const SB = path.join(TEST_HOME, 'sandbox');
  const WIN = process.platform === 'win32', MAC = process.platform === 'darwin';
  const put = (rel, text) => { const f = path.join(SB, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  const appRel = WIN ? 'AppData/Roaming' : MAC ? 'Library/Application Support' : '.config';
  const cursorFile = put('.cursor/mcp.json', JSON.stringify({ mcpServers: { other: { command: 'x', args: [] }, localfig: { command: 'old', args: [], env: { KEEP: '1' } } } }, null, 2));
  const geminiFile = put('.gemini/settings.json', JSON.stringify({ theme: 'dark', mcpServers: {} }));
  const vscodeDir = path.join(SB, appRel, 'Code', 'User');
  fs.mkdirSync(vscodeDir, { recursive: true });
  const codexFile = put('.codex/config.toml', 'model = "o4"\n\n[mcp_servers.other]\ncommand = "y"\n');
  const zedText = '// Zed settings\n{\n  "theme": "One Dark"\n}\n';
  const zedFile = put(WIN ? 'AppData/Roaming/Zed/settings.json' : '.config/zed/settings.json', zedText);
  const deskFile = put(path.join(appRel, 'Claude', 'claude_desktop_config.json'), '{ not json');
  const clineFile = put('.cline/data/settings/cline_mcp_settings.json', JSON.stringify({ mcpServers: {} }, null, 2));
  const clineLegacyText = '{"mcpServers":{}}';
  const clineLegacy = put(path.join(appRel, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), clineLegacyText);
  const sandboxEnv = {
    ...process.env, LOCALFIG_PORT: String(PORT), LOCALFIG_HOME: TEST_HOME,
    HOME: SB, USERPROFILE: SB, APPDATA: path.join(SB, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(SB, '.config'),
  };
  delete sandboxEnv.CLINE_DATA_DIR;
  delete sandboxEnv.CLINE_MCP_SETTINGS_PATH;
  const setupIn = (...extra) => spawnSync(process.execPath, [path.join(HERE, 'server.mjs'), '--setup', ...extra], { env: sandboxEnv, encoding: 'utf8' });
  const CLIENT_LIST = '--clients=cursor,gemini,vscode,codex,zed,claude-desktop,windsurf,cline'; // never claude-code: that would run the real CLI
  const first = setupIn(CLIENT_LIST);
  check('setup with --clients exits 0', first.status === 0, (first.stderr || first.stdout || '').slice(0, 200));
  const cur = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
  check('cursor: stale localfig entry updated, its env kept', cur.mcpServers.localfig.command === 'node' && cur.mcpServers.localfig.env?.KEEP === '1');
  check('cursor: other servers kept, backup written first', cur.mcpServers.other?.command === 'x' && fs.existsSync(cursorFile + '.localfig.bak'));
  const gem = JSON.parse(fs.readFileSync(geminiFile, 'utf8'));
  check('gemini: other settings kept, localfig added', gem.theme === 'dark' && gem.mcpServers.localfig?.args?.length === 1);
  const vsFile = path.join(vscodeDir, 'mcp.json');
  check('vscode: user mcp.json created with a stdio server', fs.existsSync(vsFile) && JSON.parse(fs.readFileSync(vsFile, 'utf8')).servers?.localfig?.type === 'stdio');
  const toml = fs.readFileSync(codexFile, 'utf8');
  check('codex: [mcp_servers.localfig] appended, rest of config.toml kept', toml.startsWith('model = "o4"') && /\[mcp_servers\.other\]/.test(toml) && /\[mcp_servers\.localfig\]\r?\ncommand = "node"/.test(toml));
  check('zed: settings with comments left untouched and reported', fs.readFileSync(zedFile, 'utf8') === zedText && /Zed\s+skipped/.test(first.stdout));
  check('claude desktop: invalid JSON left untouched', fs.readFileSync(deskFile, 'utf8') === '{ not json');
  check('windsurf: not installed, nothing created', !fs.existsSync(path.join(SB, '.codeium')) && /Not found: .*Windsurf/.test(first.stdout));
  const clineNow = JSON.parse(fs.readFileSync(clineFile, 'utf8'));
  check('cline: registered in ~/.cline/data/settings, legacy VS Code copy untouched', clineNow.mcpServers.localfig?.command === 'node' && fs.readFileSync(clineLegacy, 'utf8') === clineLegacyText);
  const second = setupIn(CLIENT_LIST);
  check('second run: up to date, no duplicate codex table',
    /Cursor\s+up to date/.test(second.stdout) && /Codex\s+up to date/.test(second.stdout) && /Cline +up to date/.test(second.stdout) && (fs.readFileSync(codexFile, 'utf8').match(/\[mcp_servers\.localfig\]/g) || []).length === 1,
    second.stdout.slice(0, 300));
  const unknownClient = setupIn('--dry-run', '--clients=nope');
  check('unknown client id is rejected', unknownClient.status === 2 && /Known clients/.test(unknownClient.stdout));

  console.log('\n13. owner re-election when the bridge owner dies');
  srv2 = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    env: { ...process.env, LOCALFIG_PORT: String(PORT), LOCALFIG_HOME: TEST_HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let logs2 = '';
  srv2.stderr.on('data', (d) => { logs2 += d; });
  const replies2 = new Map();
  let rbuf2 = '';
  srv2.stdout.on('data', (d) => {
    rbuf2 += d.toString();
    let i;
    while ((i = rbuf2.indexOf('\n')) >= 0) {
      const line = rbuf2.slice(0, i).trim(); rbuf2 = rbuf2.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const r = replies2.get(msg.id);
      if (r) { replies2.delete(msg.id); r(msg); }
    }
  });
  const rpc2 = (method, params) => new Promise((resolve) => {
    const id = rpcId++;
    replies2.set(id, resolve);
    srv2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await sleep(700);
  check('second instance starts as client', /running as client/.test(logs2), logs2.trim().slice(-140));
  srv.kill();
  await sleep(400);
  const reborn = rpc2('tools/call', { name: 'figma_status', arguments: {} });
  let served = null;
  for (let i = 0; i < 25 && !served; i++) {
    try { served = await actAsPlugin(async () => ({ result: { fileName: 'Reborn' } })); } catch { await sleep(200); }
  }
  const rebornJson = jsonOf(await reborn);
  check('client re-binds the port after the owner dies', rebornJson?.mode === 'owner', JSON.stringify(rebornJson).slice(0, 160));
  check('and serves the plugin itself', rebornJson?.pluginConnected === true && rebornJson?.fileName === 'Reborn', JSON.stringify(rebornJson).slice(0, 160));
  check('re-election is logged', /re-election: previous owner gone/.test(logs2), logs2.trim().slice(-160));

  fs.unlinkSync(imgPath);
} catch (e) {
  failed++;
  console.log('\n  THREW  ' + (e.stack || e));
} finally {
  srv.kill();
  if (srv2) srv2.kill();
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
