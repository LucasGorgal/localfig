# localfig

**The Figma desktop app as an MCP server.** localfig gives an AI agent the **full Figma Plugin API** on the file you have open — through a tiny dev plugin and a loopback HTTP bridge, entirely on your machine.

- **Reads and writes.** Frames, text, auto-layout, variables, components, image fills, exports, undo — anything the Plugin API can do, the agent can do.
- **No Figma cloud API, no personal access token, no per-account quota.**
- **Zero dependencies.** Node built-ins only. Nothing leaves your machine.
- Works with any MCP client that can launch a stdio server: Claude Code, Cursor, Windsurf, Cline, Claude Desktop and more.

```
MCP client  --stdio JSON-RPC-->  localfig  --http localhost:8765-->  Figma plugin  -->  Plugin API
```

## Why localfig

| | localfig | Official Figma MCP | REST-API servers | Fixed-command plugin bridges |
|---|---|---|---|---|
| Writes to the file | anything the Plugin API can | limited | no — the REST API cannot write nodes | a fixed menu of commands |
| Arbitrary Plugin API JavaScript | **yes** (`figma_eval`) | no | no | no |
| Quota / login | none | plan-dependent | token + rate limits | none |
| Tokens, styles, components read back | `figma_tokens`, `figma_metadata` | yes, incl. Code Connect | partial | rarely |
| Renders back to the agent | inline images | yes | no | varies |
| Undo per agent step, change tracking | yes | no | no | no |

## Requirements

- Node.js 18 or newer
- The **Figma desktop app** — dev plugins cannot be imported in the browser
- An MCP client: Claude Code, Cursor, Windsurf, Cline, Claude Desktop, …

## Install (once)

```
npx -y localfig --setup
```

That generates your local secret, writes the plugin to `~/.localfig/plugin/`, **registers localfig with every MCP client it finds on your machine**, and prints the manifest path for the next step. `--dry-run` shows what it would do without touching anything, and `--clients=cursor,vscode` limits it to the clients you name. Prefer a clone? `git clone https://github.com/LucasGorgal/localfig.git && cd localfig && node server.mjs --setup` does the same.

| Client | Where setup registers localfig |
|---|---|
| Claude Code | `claude mcp add --scope user` |
| Claude Desktop | `claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot agent mode) | user `mcp.json` |
| Cline (extension and CLI) | `~/.cline/data/settings/cline_mcp_settings.json`, or VS Code's extension storage on older versions |
| Gemini CLI | `~/.gemini/settings.json` |
| Codex | `~/.codex/config.toml` |
| opencode | `~/.config/opencode/opencode.json` |
| Zed | `settings.json`, under `context_servers` |
| LM Studio | `~/.lmstudio/mcp.json` |

A client counts as installed when its config folder exists. Setup merges into existing files instead of replacing them: other servers and settings stay, an existing `localfig` entry keeps its `env`, and a `.localfig.bak` copy is written before any change. Files it cannot safely rewrite, such as a `settings.json` with comments, are left untouched and reported with the entry to paste. Restart any client that was already open.

For a client that is not in the list, add this to its MCP configuration:

```json
{ "mcpServers": { "localfig": { "command": "npx", "args": ["-y", "localfig"] } } }
```

On Windows, use `"command": "cmd", "args": ["/c", "npx", "-y", "localfig"]` instead: most clients start servers without a shell, and `npx` is a `.cmd` script there.

Then import the plugin into Figma (once):

1. Open any **design file** in the desktop app. The Plugins menu only exists inside a file, not on the home screen.
2. Figma menu (the logo, top-left) → **Plugins → Development → Import plugin from manifest…** — or press `Ctrl` `/` (`Cmd` `/`) and type *import plugin from manifest*.
3. Pick `~/.localfig/plugin/manifest.json` (the setup output prints the full path).

The manifest asks for two permissions — `teamlibrary` (library components and tokens) and `currentuser` (who is driving) — and registers a relaunch button.

## Use (every session)

1. Open the file you want to work on.
2. Run the plugin: `Ctrl` `/` → *localfig* — or `Ctrl` `Alt` `P` (`Cmd` `Opt` `P`) to re-run the last plugin, or the **Reconnect localfig** button in the properties panel of a file it has run in. A small panel appears and says **Connected to localfig** once the MCP server is up. Leave it open.
3. Ask your agent to do Figma work. Every tool acts on **the file where the plugin is running** — there is no file key, which is why nothing touches the cloud.

Closing the panel (or the file) disconnects; re-run the plugin to reconnect. This is the one manual step: Figma provides no way to launch a plugin from outside.

## Tools

| Tool | What it does |
|---|---|
| `figma_status` | Plugin connected? File, page, selection, top-level frames, who is driving, and whether dynamic code execution is available |
| `figma_eval` | Run arbitrary Plugin API JavaScript in the file — the workhorse |
| `figma_metadata` | Structural dump of a subtree: ids, names, types, geometry, text. `styles: true` adds fills (hex), gradient stops, fonts, effects, auto-layout, **bound variables, named styles and component info** per node; `css: true` adds the **CSS Figma computes** per node |
| `figma_tokens` | Every local variable collection with its modes and per-mode values, plus paint / text / effect styles |
| `figma_find` | Search the current page or every page by type, layer-name regex and text regex |
| `figma_changes` | What changed since your last call — creations, deletions, property changes, per-node summary; edits made by tool calls are tagged and hidden by default, so this is **what the person did in Figma meanwhile** |
| `figma_history` | `snapshot`: save a named version (restore point). `undo`: revert the last tool call — every mutating call is checkpointed as **one undo step** |
| `figma_library` | Team library: list variable collections and their variables, import components / styles / variables by key, place instances |
| `figma_export` | Export nodes to PNG/JPG/SVG/PDF/**JSON** on disk. PNG/JPG come back **inline as images**; JSON (the subtree in **Figma REST API shape**) and SVG come back inline as text |
| `figma_place_image` | Put a local image into a node's fill. Any format the browser decodes — PNG, JPG, **WebP**, GIF, BMP, AVIF. Images over 4096px per side are **downscaled automatically** (`maxSide`) |

### `figma_eval` environment

Code runs inside the plugin sandbox, wrapped in an async function: top-level `await` and `return` both work.

```js
const n = await figma.getNodeByIdAsync('10:59');   // sync getNodeById is unavailable (dynamic-page access)
await helpers.setText(n.findOne(x => x.type === 'TEXT'), 'new copy');
helpers.reveal(n);                                  // put it on the person's screen
return { id: n.id, w: n.width };                   // JSON-serialized back to the agent
```

Globals: `figma` and `helpers`.

- `helpers.createText({characters, font: {family, style}, fontSize, color: '#hex', width, lineHeight, letterSpacing, textCase, textAlign, name, parent, x, y})` — loads the font and orders `resize()` before `textAutoResize`.
- `helpers.setText(node, chars)` — loads the node's real fonts, then sets characters. `helpers.loadNodeFonts(node)`.
- `helpers.set(node, props)` — batch assign; `layoutMode` first, `width`/`height` via `resize`, sizing modes after.
- `helpers.rgb('#rrggbb')`, `helpers.rgba('#rrggbbaa')` — hex to the `{r, g, b[, a]}` fills want.
- `helpers.reveal(nodes)` — scroll and zoom the viewport to what you just made. `helpers.notify(msg)` — a toast.
- `helpers.collection(name, [modes])`, `helpers.token(collection, name, type, value | {mode: value})`, `helpers.bind(node, 'fills' | 'strokes' | prop, variable)` — create design tokens and bind properties to them, one line each.
- `helpers.importComponent(key)`, `helpers.instance(key, parent, props)` — team-library components.
- `helpers.query(root, sel)` — minimal selectors: `TEXT`, `[name=X]`, `[name*=X]`, `A B`, `a, b`. `helpers.createAutoLayout(dir, props)`.
- `helpers.command(kind, payload)` — run any typed command (`tokens`, `metadata`, `find`, `changes`, `export`…) from inside a script: `(await helpers.command('tokens', { collection: 'Brand' })).result`.

### Plugin API gotchas the helpers protect you from

- `resize()` on a TEXT node resets `textAutoResize` to `NONE`; on an auto-layout frame it sets both sizing modes to `FIXED`. Resize first, then set the sizing.
- Return plain data from `figma_eval`. Real Figma nodes are collapsed to `{id, name, type}` so a stray node reference cannot flood the result — use `figma_metadata` to inspect a subtree.
- Load fonts before any text mutation.
- `figma.notify()` works here (the cloud MCP blocks it).

## Design-system awareness

`figma_tokens` returns the file's variables the way a design system thinks about them:

```json
{ "collections": [{ "name": "Brand", "modes": ["Light", "Dark"], "defaultMode": "Light",
    "variables": [{ "name": "color/bg", "type": "COLOR", "values": { "Light": "#ffffff", "Dark": "#04060c" } },
                  { "name": "space/md", "type": "FLOAT", "values": { "Light": 16, "Dark": 16 } },
                  { "name": "color/accent", "type": "COLOR", "values": { "Light": "{color/blue-500}", "Dark": "{color/blue-300}" } }] }],
  "styles": { "paint": [...], "text": [...], "effect": [...] } }
```

`figma_metadata` with `styles: true` then reports, per node, `boundVariables` (which token drives each property), `fillStyle` / `textStyle` / `effectStyle` names, and for instances the main `component` and its `componentProperties`; `css: true` adds the CSS Figma computes for each node. Together they let an agent build **on** a design system instead of hard-coding values — and hand code off from a real file.

## Images

- **In:** `figma_place_image` sends the file's bytes to the plugin UI, which is a full Chromium iframe. It decodes any browser-supported format, downscales to `maxSide` (default 4096, Figma's hard limit) with high-quality smoothing, converts non-native formats to PNG, and hands the result to the main thread. The tool result reports what happened (`prepared`).
- **Out:** `figma_export` writes files to `~/.localfig/exports/` and attaches PNG/JPG (≤ 2 MB each) to the result as images, so the agent sees the render without another call. `JSON` exports the subtree in Figma REST API shape.

## Undo, versions and change tracking

Every mutating tool call is checkpointed with `figma.commitUndo`, so it lands in the file's undo history as **one step** a person can Ctrl+Z (the most recent call is committed 60 s after it finishes, or at the next call). Within that window `figma_history {action: "undo"}` reverts the last call from the agent side — `triggerUndo` reverts to the last checkpoint — and `{action: "snapshot"}` saves a named version before risky edits. The plugin also records node changes on every page it has seen (Figma delivers them batched, after the fact): `figma_changes` returns what changed since a `seq`, with edits caused by tool calls tagged `byPlugin` by a time-window heuristic and hidden by default — the agent can notice what the person changed in Figma between calls instead of overwriting it.

## Multiple sessions

The first localfig process owns the bridge port; later ones detect it via `/health`, run as clients, and proxy through it — same tools either way. If the owner dies, the next tool call on a client re-binds the port and takes over ("re-election" in the log); the plugin re-registers when it reconnects.

## Files and configuration

```
~/.localfig/
  token            local secret (generated on first run)
  plugin/          manifest.json + code.js + ui.html — import THIS manifest into Figma
  exports/         where figma_export writes
```

| Variable | Default | Notes |
|---|---|---|
| `LOCALFIG_HOME` | `~/.localfig` | Where the token, plugin and exports live |
| `LOCALFIG_PORT` | `8765` | Also change `networkAccess` in the manifest and re-import the plugin |
| `LOCALFIG_OUT` | `~/.localfig/exports` | Where `figma_export` writes |

`node server.mjs --help` lists the flags.

## Security

The bridge binds loopback only (`127.0.0.1` and `::1`). Every endpoint except `/health` requires a 32-hex secret generated on first run into `~/.localfig/token` and baked into `~/.localfig/plugin/ui.html`. Edit `plugin/ui.template.html` in the package, never the generated `ui.html`. Nothing is sent to any server.

## Design notes

- **Why a plugin?** It is the only local surface with full read/write access to an open Figma document. The REST API is cloud, needs a token, and cannot write nodes.
- **Why HTTP long-poll and not WebSocket?** The plugin *main thread* has no network at all; only the UI iframe does. Long-poll needs no dependency and no framing code, and `http://localhost` is exempt from mixed-content blocking. Figma's manifest validator rejects raw IPs in `networkAccess`, hence `localhost` — and the IPv6 mirror listener, because Windows resolves `localhost` to `::1` first.
- **Binary stays binary on the plugin channel.** Exports leave as `POST /blob`; images enter via `GET /asset` into a `Uint8Array`. Only JSON goes through the command channel. (Renders are base64-encoded once, in the MCP result, where the protocol requires it.)
- **Why a home directory?** The package may live in the npx cache or a read-only global install; the plugin folder you import must not move when the package updates, and per-user state must not live in a package.

## Platform notes

Developed and tested on Windows 11 with the Figma desktop app. macOS and Linux should work unchanged — Node built-ins only, no native code — but have not been exercised yet. Reports and fixes welcome.

## Test

```
node test-e2e.mjs
```

Spawns the server in an isolated home, speaks MCP over stdio, and impersonates the plugin over HTTP — covering the handshake, all ten tools, file round-trips, inline images, owner re-election, and setup against sandboxed MCP client configs, without Figma running. 55 assertions.

## Layout

```
server.mjs               MCP (stdio) + bridge (http), single process; --setup, --help
plugin/manifest.json     copied to ~/.localfig/plugin on start
plugin/code.js           main thread: executes commands against the Plugin API
plugin/ui.template.html  UI source; token/port get baked into ~/.localfig/plugin/ui.html
test-e2e.mjs             end-to-end test without Figma
```

## License

MIT — see `LICENSE`.
