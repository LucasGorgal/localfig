/**
 * localfig — Figma plugin main thread.
 *
 * The main thread has the Plugin API but no network. The UI iframe has network
 * but no Plugin API. So: UI long-polls the local bridge, relays commands here,
 * and posts results back. Keep this plugin running while an agent works in the file.
 */

/* ------------------------------------------------------- code execution --- */
// The plugin sandbox may or may not permit dynamic code construction. Probe once,
// honestly, and report the answer through figma_status instead of guessing.
var MAKE_FN = null;
var EXEC_KIND = 'none';
var EXEC_ERROR = null;
try {
  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  var probe = new AsyncFunction('a', 'return a + 1;');
  MAKE_FN = function (src) { return new AsyncFunction('figma', 'helpers', 'payload', src); };
  EXEC_KIND = 'AsyncFunction';
  probe(1); // never awaited; construction is what we care about
} catch (e1) {
  EXEC_ERROR = String(e1 && e1.message || e1);
  try {
    // eslint-disable-next-line no-eval
    var made = eval('(function(){ return 1; })');
    if (typeof made === 'function') {
      MAKE_FN = function (src) {
        // eslint-disable-next-line no-eval
        return eval('(async function(figma, helpers, payload){\n' + src + '\n})');
      };
      EXEC_KIND = 'eval';
      EXEC_ERROR = null;
    }
  } catch (e2) {
    EXEC_ERROR = EXEC_ERROR + ' | eval: ' + String(e2 && e2.message || e2);
  }
}

/* -------------------------------------------------------------- helpers --- */
var helpers = {
  // Load every font actually used by a text node (the #1 cause of write errors).
  loadNodeFonts: async function (node) {
    var segs = node.getStyledTextSegments(['fontName']);
    var seen = {};
    var jobs = [];
    for (var i = 0; i < segs.length; i++) {
      var f = segs[i].fontName;
      var key = f.family + '|' + f.style;
      if (!seen[key]) { seen[key] = 1; jobs.push(figma.loadFontAsync(f)); }
    }
    if (!jobs.length && node.fontName && node.fontName !== figma.mixed) {
      jobs.push(figma.loadFontAsync(node.fontName));
    }
    await Promise.all(jobs);
    return Object.keys(seen);
  },

  // Replace a text node's characters, preserving the first segment's styling.
  setText: async function (node, chars) {
    await helpers.loadNodeFonts(node);
    node.characters = chars;
    return node.id;
  },

  // '#rrggbb' -> {r,g,b} in 0..1 (what fills want).
  rgb: function (hex) {
    var n = parseInt(String(hex).replace('#', ''), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  },

  // Create a styled text node in one call. Handles the ordering trap: resize() resets
  // textAutoResize to NONE, so a fixed-width node must be resized BEFORE re-arming HEIGHT.
  createText: async function (opts) {
    opts = opts || {};
    var font = opts.font || { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(font);
    var t = figma.createText();
    t.fontName = font;
    t.characters = opts.characters !== undefined ? opts.characters : (opts.chars || '');
    if (opts.fontSize) t.fontSize = opts.fontSize;
    if (opts.fills) t.fills = opts.fills;
    else if (opts.color) t.fills = [{ type: 'SOLID', color: helpers.rgb(opts.color), opacity: opts.opacity === undefined ? 1 : opts.opacity }];
    if (opts.letterSpacing !== undefined) t.letterSpacing = typeof opts.letterSpacing === 'number' ? { value: opts.letterSpacing, unit: 'PIXELS' } : opts.letterSpacing;
    if (opts.lineHeight !== undefined) t.lineHeight = typeof opts.lineHeight === 'number' ? { value: opts.lineHeight, unit: 'PERCENT' } : opts.lineHeight;
    if (opts.textCase) t.textCase = opts.textCase;
    if (opts.textAlign) t.textAlignHorizontal = opts.textAlign;
    if (opts.width) { t.resize(opts.width, t.height); t.textAutoResize = 'HEIGHT'; }
    else t.textAutoResize = 'WIDTH_AND_HEIGHT';
    if (opts.name) t.name = opts.name;
    if (opts.parent) opts.parent.appendChild(t);
    if (opts.x !== undefined) t.x = opts.x;
    if (opts.y !== undefined) t.y = opts.y;
    return t;
  },

  set: function (node, props) {
    if (props.layoutMode !== undefined) node.layoutMode = props.layoutMode;
    var w = props.width, h = props.height;
    // resize() silently resets these to NONE/FIXED, so they are applied after it.
    var after = ['primaryAxisSizingMode', 'counterAxisSizingMode', 'textAutoResize'];
    for (var k in props) {
      if (k === 'width' || k === 'height' || k === 'layoutMode' || after.indexOf(k) >= 0) continue;
      node[k] = props[k];
    }
    if (w !== undefined || h !== undefined) {
      node.resize(w === undefined ? node.width : w, h === undefined ? node.height : h);
    }
    for (var a = 0; a < after.length; a++) if (props[after[a]] !== undefined) node[after[a]] = props[after[a]];
    return node;
  },

  // Minimal selector support: "TYPE", "[name=X]", "[name*=X]", "A B" (descendant), "a, b".
  query: function (root, selector) {
    var groups = String(selector).split(',');
    var out = [];
    var seen = {};
    for (var gi = 0; gi < groups.length; gi++) {
      var chain = groups[gi].trim().split(/\s+/).filter(Boolean);
      if (!chain.length) continue;
      var current = [root];
      for (var ci = 0; ci < chain.length; ci++) {
        var step = chain[ci];
        var m = step.match(/^([A-Za-z*]+)?(?:\[name(\*?)=([^\]]+)\])?$/);
        if (!m) { current = []; break; }
        var type = m[1] && m[1] !== '*' ? m[1].toUpperCase() : null;
        var fuzzy = m[2] === '*';
        var name = m[3] || null;
        var next = [];
        for (var ni = 0; ni < current.length; ni++) {
          var node = current[ni];
          if (!node.findAll) continue;
          var found = node.findAll(function (n) {
            if (type && n.type !== type) return false;
            if (name) {
              if (fuzzy) { if (n.name.indexOf(name) < 0) return false; }
              else if (n.name !== name) return false;
            }
            return true;
          });
          next = next.concat(found);
        }
        current = next;
      }
      for (var oi = 0; oi < current.length; oi++) {
        if (!seen[current[oi].id]) { seen[current[oi].id] = 1; out.push(current[oi]); }
      }
    }
    return out;
  },

  // Put nodes on the user's screen (after creating something, show it).
  reveal: function (nodes) {
    var arr = Array.isArray(nodes) ? nodes : [nodes];
    figma.viewport.scrollAndZoomIntoView(arr);
    return arr.map(function (n) { return n.id; });
  },
  notify: function (message, opts) { figma.notify(String(message), opts || {}); },

  // '#rrggbb' or '#rrggbbaa' -> {r,g,b,a}
  rgba: function (hex, a) {
    var h = String(hex).replace('#', '');
    var c = helpers.rgb(h.slice(0, 6));
    c.a = a !== undefined ? a : (h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
    return c;
  },

  // ----- design tokens -----
  // Find-or-create a local variable collection; optional mode names (first one renames the default mode).
  collection: async function (name, modes) {
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    var col = cols.filter(function (c) { return c.name === name; })[0] || figma.variables.createVariableCollection(name);
    if (modes && modes.length) {
      if (col.modes[0].name !== modes[0]) col.renameMode(col.modes[0].modeId, modes[0]);
      for (var i = 1; i < modes.length; i++) {
        var exists = col.modes.some(function (m) { return m.name === modes[i]; });
        if (!exists) col.addMode(modes[i]);
      }
    }
    return col;
  },
  // Find-or-create a variable and set its values. `values` is one value for every mode, or
  // {modeName: value}. COLOR values accept '#hex' strings.
  token: async function (collection, name, type, values) {
    var col = typeof collection === 'string' ? await helpers.collection(collection) : collection;
    var all = await figma.variables.getLocalVariablesAsync(type);
    var v = all.filter(function (x) { return x.variableCollectionId === col.id && x.name === name; })[0] ||
      figma.variables.createVariable(name, col, type);
    var toValue = function (val) { return (type === 'COLOR' && typeof val === 'string') ? helpers.rgba(val) : val; };
    if (values !== null && values !== undefined) {
      var perMode = typeof values === 'object' && !Array.isArray(values) && !(type === 'COLOR' && values.r !== undefined);
      if (perMode) {
        for (var modeName in values) {
          var m = col.modes.filter(function (x) { return x.name === modeName; })[0];
          if (!m) throw new Error('no mode named "' + modeName + '" in collection ' + col.name);
          v.setValueForMode(m.modeId, toValue(values[modeName]));
        }
      } else {
        for (var i = 0; i < col.modes.length; i++) v.setValueForMode(col.modes[i].modeId, toValue(values));
      }
    }
    return v;
  },
  // Bind a node property to a variable: 'fills' / 'strokes' bind the first paint's color;
  // anything else ('width', 'itemSpacing', 'paddingLeft', 'cornerRadius', 'opacity', 'fontSize'...) uses setBoundVariable.
  bind: function (node, prop, variable) {
    if (prop === 'fills' || prop === 'strokes') {
      var cur = node[prop];
      var paints = (cur && cur !== figma.mixed && cur.length) ? cur.slice() : [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
      paints[0] = figma.variables.setBoundVariableForPaint(paints[0], 'color', variable);
      node[prop] = paints;
    } else {
      node.setBoundVariable(prop, variable);
    }
    return node.id;
  },

  // ----- team library (needs the "teamlibrary" manifest permission) -----
  importComponent: function (key) { return figma.importComponentByKeyAsync(key); },
  instance: async function (key, parent, props) {
    var comp = await figma.importComponentByKeyAsync(key);
    var inst = comp.createInstance();
    (parent || figma.currentPage).appendChild(inst);
    if (props) helpers.set(inst, props);
    return inst;
  },

  // Run any typed command (metadata, tokens, export, placeImage, status) from inside eval,
  // e.g. (await helpers.command('tokens', { collection: 'Brand' })).result
  command: function (kind, payload) { return runCommand({ kind: kind, payload: payload || {} }); },

  createAutoLayout: function (dir, props) {
    var f = figma.createFrame();
    f.layoutMode = (dir || 'HORIZONTAL').toUpperCase();
    f.primaryAxisSizingMode = 'AUTO';
    f.counterAxisSizingMode = 'AUTO';
    if (props) helpers.set(f, props);
    return f;
  },
};

/* ---------------------------------------------------------- json safety --- */
function safeJson(value, depth, seen) {
  depth = depth || 0;
  seen = seen || [];
  if (value === undefined) return null;
  if (value === null) return null;
  if (value === figma.mixed) return 'mixed';
  var t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return value;
  if (t === 'function') return '[function]';
  if (t === 'symbol') return String(value);
  if (t === 'bigint') return String(value);
  if (depth > 8) return '[depth]';
  for (var s = 0; s < seen.length; s++) if (seen[s] === value) return '[circular]';
  seen = seen.concat([value]);
  if (Array.isArray(value)) {
    var arr = [];
    for (var i = 0; i < value.length && i < 2000; i++) arr.push(safeJson(value[i], depth + 1, seen));
    return arr;
  }
  if (value instanceof Uint8Array) return '[bytes:' + value.length + ']';
  // Real Figma node? (they have remove(); plain data objects with id/type do not)
  // Return a compact descriptor instead of walking the whole tree.
  if (typeof value.remove === 'function' && typeof value.id === 'string') {
    return { id: value.id, name: value.name, type: value.type };
  }
  var o = {};
  var keys = Object.keys(value).slice(0, 200);
  for (var k = 0; k < keys.length; k++) {
    try { o[keys[k]] = safeJson(value[keys[k]], depth + 1, seen); } catch (e) { o[keys[k]] = '[err]'; }
  }
  return o;
}

/* --------------------------------------------------------------- probes --- */
async function currentContext() {
  var page = figma.currentPage;
  var sel = page.selection.map(function (n) {
    return { id: n.id, name: n.name, type: n.type, width: n.width, height: n.height };
  });
  var fileKey = null;
  try { fileKey = figma.fileKey || null; } catch (e) { fileKey = null; }
  var ctx = {
    fileName: figma.root.name,
    fileKey: fileKey,
    editorType: figma.editorType,
    pageId: page.id,
    pageName: page.name,
    pages: figma.root.children.map(function (p) { return { id: p.id, name: p.name }; }),
    selection: sel,
    topLevelFrames: page.children.slice(0, 60).map(function (n) {
      return { id: n.id, name: n.name, type: n.type, x: n.x, y: n.y, width: n.width, height: n.height };
    }),
    exec: { kind: EXEC_KIND, available: !!MAKE_FN, error: EXEC_ERROR },
    pluginApi: figma.apiVersion,
  };
  try { ctx.user = figma.currentUser ? figma.currentUser.name : null; } catch (e) { ctx.user = null; }
  return ctx;
}

/* ------------------------------------------------------- style describers --- */
function hexOf(c) {
  return '#' + [c.r, c.g, c.b].map(function (v) { var s = Math.round(v * 255).toString(16); return s.length < 2 ? '0' + s : s; }).join('');
}
function describePaint(pt) {
  if (!pt || pt.visible === false) return null;
  var o = { type: pt.type };
  if (pt.opacity !== undefined && pt.opacity !== 1) o.opacity = Math.round(pt.opacity * 100) / 100;
  if (pt.type === 'SOLID') o.color = hexOf(pt.color);
  else if (pt.type.indexOf('GRADIENT') === 0) {
    o.stops = pt.gradientStops.map(function (s) { return hexOf(s.color) + '@' + Math.round(s.color.a * 100) / 100 + '/' + Math.round(s.position * 100) / 100; });
  } else if (pt.type === 'IMAGE') {
    o.scaleMode = pt.scaleMode;
    if (pt.filters) { var f = {}; for (var k in pt.filters) if (pt.filters[k]) f[k] = Math.round(pt.filters[k] * 100) / 100; if (Object.keys(f).length) o.filters = f; }
  }
  return o;
}
// Everything a designer would read off the right-hand panel, compact enough to dump per node.
function describeStyles(node) {
  var s = {};
  if (node.fills === figma.mixed) s.fills = 'mixed';
  else if (Array.isArray(node.fills) && node.fills.length) s.fills = node.fills.map(describePaint).filter(Boolean);
  if (Array.isArray(node.strokes) && node.strokes.length) {
    s.strokes = node.strokes.map(describePaint).filter(Boolean);
    s.strokeWeight = node.strokeWeight === figma.mixed ? 'mixed' : node.strokeWeight;
  }
  if (typeof node.opacity === 'number' && node.opacity < 1) s.opacity = Math.round(node.opacity * 100) / 100;
  if (node.cornerRadius === figma.mixed) s.cornerRadius = 'mixed';
  else if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) s.cornerRadius = node.cornerRadius;
  if (Array.isArray(node.effects) && node.effects.length) {
    s.effects = node.effects.filter(function (e) { return e.visible !== false; }).map(function (e) { return e.type + (e.radius !== undefined ? ' ' + e.radius : ''); });
  }
  if (node.isMask) s.isMask = true;
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    s.layout = { mode: node.layoutMode, gap: node.itemSpacing, padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      sizing: node.primaryAxisSizingMode + '/' + node.counterAxisSizingMode, align: node.primaryAxisAlignItems + '/' + node.counterAxisAlignItems };
  }
  if (node.type === 'TEXT') {
    s.font = node.fontName === figma.mixed ? 'mixed' : node.fontName.family + ' / ' + node.fontName.style;
    s.fontSize = node.fontSize === figma.mixed ? 'mixed' : node.fontSize;
    if (node.lineHeight === figma.mixed) s.lineHeight = 'mixed';
    else if (node.lineHeight.unit !== 'AUTO') s.lineHeight = node.lineHeight.value + (node.lineHeight.unit === 'PERCENT' ? '%' : 'px');
    if (node.letterSpacing === figma.mixed) s.letterSpacing = 'mixed';
    else if (node.letterSpacing.value) s.letterSpacing = node.letterSpacing.value + (node.letterSpacing.unit === 'PERCENT' ? '%' : 'px');
    if (node.textCase !== 'ORIGINAL') s.textCase = node.textCase;
    s.textAlign = node.textAlignHorizontal;
    s.autoResize = node.textAutoResize;
  }
  return s;
}

/* ------------------------------------------------- design-system lookups --- */
// What a node is BOUND to: named styles, variables (tokens) and components. Cached per
// call so a 400-node dump does not hit the async APIs once per token per node.
function DesignSystemLookup() { this.vars = {}; this.styles = {}; }
DesignSystemLookup.prototype.variableName = async function (id) {
  if (!id) return null;
  if (!(id in this.vars)) {
    try { var v = await figma.variables.getVariableByIdAsync(id); this.vars[id] = v ? v.name : null; }
    catch (e) { this.vars[id] = null; }
  }
  return this.vars[id];
};
DesignSystemLookup.prototype.styleName = async function (id) {
  if (id === figma.mixed) return 'mixed';
  if (!id) return null;
  if (!(id in this.styles)) {
    try { var s = await figma.getStyleByIdAsync(id); this.styles[id] = s ? s.name : null; }
    catch (e) { this.styles[id] = null; }
  }
  return this.styles[id];
};
DesignSystemLookup.prototype.describe = async function (node) {
  var o = {};
  var bv = node.boundVariables;
  if (bv) {
    var bound = {};
    for (var prop in bv) {
      var b = bv[prop];
      if (Array.isArray(b)) {
        var names = [];
        for (var i = 0; i < b.length; i++) names.push(await this.variableName(b[i] && b[i].id));
        if (names.length) bound[prop] = names;
      } else if (b && b.id) {
        bound[prop] = await this.variableName(b.id);
      } else if (b && typeof b === 'object') {
        var sub = {};
        for (var k in b) sub[k] = await this.variableName(b[k] && b[k].id);
        bound[prop] = sub;
      }
    }
    if (Object.keys(bound).length) o.boundVariables = bound;
  }
  var styleProps = { fillStyleId: 'fillStyle', strokeStyleId: 'strokeStyle', textStyleId: 'textStyle', effectStyleId: 'effectStyle', gridStyleId: 'gridStyle' };
  for (var sp in styleProps) {
    if (sp in node && node[sp]) { var nm = await this.styleName(node[sp]); if (nm) o[styleProps[sp]] = nm; }
  }
  if (node.type === 'INSTANCE') {
    try {
      var main = await node.getMainComponentAsync();
      if (main) {
        var set = main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent : null;
        o.component = { name: set ? set.name + ' / ' + main.name : main.name, key: main.key || null, remote: !!main.remote };
      }
      if (node.componentProperties) {
        var props = {};
        for (var cp in node.componentProperties) props[cp.replace(/#.*$/, '')] = node.componentProperties[cp].value;
        o.componentProperties = props;
      }
    } catch (e) { o.component = { error: String(e && e.message || e) }; }
  }
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    o.componentKey = node.key || null;
    if (node.type === 'COMPONENT_SET' && node.variantGroupProperties) o.variantProperties = Object.keys(node.variantGroupProperties);
    if (node.type === 'COMPONENT' && node.variantProperties) o.variantProperties = node.variantProperties;
  }
  return o;
};
async function describeVariableValue(raw, type, lookup) {
  if (raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') {
    var nm = await lookup.variableName(raw.id);
    return '{' + (nm || raw.id) + '}';
  }
  if (type === 'COLOR' && raw && typeof raw === 'object') {
    var hex = hexOf(raw);
    return raw.a !== undefined && raw.a < 1 ? hex + '@' + Math.round(raw.a * 100) / 100 : hex;
  }
  return raw;
}

/* ------------------------------------------------------------- commands --- */
async function runCommand(cmd) {
  var kind = cmd.kind;
  var p = cmd.payload || {};

  if (kind === 'status') {
    return { result: await currentContext() };
  }

  if (kind === 'eval') {
    if (!MAKE_FN) {
      throw new Error(
        'This Figma build blocks dynamic code in the plugin sandbox (' + EXEC_ERROR + '). ' +
        'Use figma_metadata / figma_export / figma_place_image, or add a typed command to plugin/code.js.'
      );
    }
    var fn = MAKE_FN(p.code);
    var out = await fn(figma, helpers, p);
    return { result: safeJson(out) };
  }

  if (kind === 'metadata') {
    var root = p.nodeId ? await figma.getNodeByIdAsync(p.nodeId) : figma.currentPage;
    if (!root) throw new Error('node not found: ' + p.nodeId);
    var maxNodes = p.maxNodes || 400;
    var styles = !!p.styles;
    var css = !!p.css;
    var count = 0;
    var truncated = false;
    var lookup = new DesignSystemLookup();
    async function walk(node, depth) {
      if (count >= maxNodes) { truncated = true; return null; }
      count++;
      var o = { id: node.id, name: node.name, type: node.type };
      if (typeof node.x === 'number') { o.x = Math.round(node.x * 100) / 100; o.y = Math.round(node.y * 100) / 100; }
      if (typeof node.width === 'number') { o.w = Math.round(node.width * 100) / 100; o.h = Math.round(node.height * 100) / 100; }
      if (node.type === 'TEXT') o.characters = node.characters;
      if (node.visible === false) o.visible = false;
      if (styles) {
        var st = describeStyles(node); for (var sk in st) o[sk] = st[sk];
        var ds = await lookup.describe(node); for (var dk in ds) o[dk] = ds[dk];
      }
      if (css && typeof node.getCSSAsync === 'function') { try { o.css = await node.getCSSAsync(); } catch (e) {} }
      if (node.children && depth > 0) {
        var kids = [];
        for (var i = 0; i < node.children.length; i++) {
          var c = await walk(node.children[i], depth - 1);
          if (c) kids.push(c);
        }
        if (kids.length) o.children = kids;
      }
      return o;
    }
    return { result: { tree: await walk(root, p.depth === undefined ? 6 : p.depth), nodeCount: count, truncated: truncated } };
  }

  if (kind === 'tokens') {
    var includeStyles = p.includeStyles !== false;
    var filter = p.collection ? String(p.collection).toLowerCase() : null;
    var cap = p.maxVariables || 2000;
    var collections = await figma.variables.getLocalVariableCollectionsAsync();
    var variables = await figma.variables.getLocalVariablesAsync();
    var tokLookup = new DesignSystemLookup();
    var out = { collections: [], styles: null, counts: { collections: collections.length, variables: variables.length } };
    var n = 0;
    for (var ci = 0; ci < collections.length; ci++) {
      var col = collections[ci];
      if (filter && col.name.toLowerCase().indexOf(filter) < 0) continue;
      var modes = col.modes.map(function (m) { return { id: m.modeId, name: m.name }; });
      var defaultMode = modes.filter(function (m) { return m.id === col.defaultModeId; })[0];
      var entry = { id: col.id, name: col.name, modes: modes.map(function (m) { return m.name; }), defaultMode: defaultMode ? defaultMode.name : null, variables: [] };
      for (var vi = 0; vi < variables.length; vi++) {
        var v = variables[vi];
        if (v.variableCollectionId !== col.id) continue;
        if (n++ >= cap) { entry.truncated = true; break; }
        var values = {};
        for (var mi = 0; mi < modes.length; mi++) values[modes[mi].name] = await describeVariableValue(v.valuesByMode[modes[mi].id], v.resolvedType, tokLookup);
        var ve = { name: v.name, type: v.resolvedType, values: values };
        if (v.description) ve.description = v.description;
        if (v.scopes && v.scopes.length && !(v.scopes.length === 1 && v.scopes[0] === 'ALL_SCOPES')) ve.scopes = v.scopes;
        if (v.codeSyntax && Object.keys(v.codeSyntax).length) ve.codeSyntax = v.codeSyntax;
        if (v.hiddenFromPublishing) ve.hidden = true;
        entry.variables.push(ve);
      }
      out.collections.push(entry);
    }
    if (includeStyles) {
      var paints = await figma.getLocalPaintStylesAsync();
      var texts = await figma.getLocalTextStylesAsync();
      var effects = await figma.getLocalEffectStylesAsync();
      var lh = function (v) { return v.unit === 'AUTO' ? 'auto' : v.value + (v.unit === 'PERCENT' ? '%' : 'px'); };
      out.styles = {
        paint: paints.map(function (s) { var e = { name: s.name, paints: s.paints.map(describePaint).filter(Boolean) }; if (s.description) e.description = s.description; return e; }),
        text: texts.map(function (s) {
          var e = { name: s.name, font: s.fontName.family + ' / ' + s.fontName.style, fontSize: s.fontSize, lineHeight: lh(s.lineHeight), letterSpacing: s.letterSpacing.value + (s.letterSpacing.unit === 'PERCENT' ? '%' : 'px') };
          if (s.textCase !== 'ORIGINAL') e.textCase = s.textCase;
          if (s.description) e.description = s.description;
          return e;
        }),
        effect: effects.map(function (s) { var e = { name: s.name, effects: s.effects.filter(function (x) { return x.visible !== false; }).map(function (x) { return x.type + (x.radius !== undefined ? ' ' + x.radius : ''); }) }; if (s.description) e.description = s.description; return e; }),
      };
      out.counts.styles = paints.length + texts.length + effects.length;
    }
    return { result: out };
  }

  if (kind === 'changes') {
    var since = p.since || 0;
    var limit = p.limit || 200;
    var list = CHANGES.filter(function (c) { return c.seq > since && (p.includePlugin || !c.byPlugin); });
    var total = list.length;
    if (list.length > limit) list = list.slice(list.length - limit);
    var byNode = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var s = byNode[c.id] || (byNode[c.id] = { id: c.id, name: c.name, nodeType: c.nodeType, types: [], properties: [], count: 0 });
      s.count++;
      if (c.name) s.name = c.name;
      if (c.nodeType) s.nodeType = c.nodeType;
      if (s.types.indexOf(c.type) < 0) s.types.push(c.type);
      if (c.properties) for (var k = 0; k < c.properties.length; k++) if (s.properties.indexOf(c.properties[k]) < 0) s.properties.push(c.properties[k]);
    }
    var summary = []; for (var id in byNode) summary.push(byNode[id]);
    return { result: { seq: CHANGE_SEQ, since: since, total: total, returned: list.length, summary: summary, changes: list } };
  }

  if (kind === 'history') {
    if (p.action === 'undo') {
      if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
      figma.triggerUndo();
      lastMutationEnd = Date.now();
      return { result: { ok: true, action: 'undo', note: 'Reverted the edits of the last mutating tool call, provided it ran within the last ' + (UNDO_WINDOW_MS / 1000) + 's (older edits are already in the undo history — Ctrl+Z in Figma).' } };
    }
    if (p.action !== 'snapshot') throw new Error('action must be snapshot or undo');
    var title = p.title || ('localfig ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
    var version = await figma.saveVersionHistoryAsync(title, p.description || '');
    return { result: { ok: true, action: 'snapshot', title: title, versionId: version && version.id ? version.id : null } };
  }

  if (kind === 'find') {
    var flimit = p.limit || 200;
    var types = Array.isArray(p.types) && p.types.length ? p.types.map(function (t) { return String(t).toUpperCase(); }) : null;
    var nameRe = p.name ? new RegExp(p.name, 'i') : null;
    var textRe = p.text ? new RegExp(p.text, 'i') : null;
    var pages;
    if (p.scope === 'all') { await figma.loadAllPagesAsync(); pages = figma.root.children.slice(); }
    else pages = [figma.currentPage];
    var hits = [], scanned = 0;
    for (var pi = 0; pi < pages.length && hits.length < flimit; pi++) {
      var pg = pages[pi];
      var candidates = types ? pg.findAllWithCriteria({ types: types }) : pg.findAll(function () { return true; });
      for (var ni = 0; ni < candidates.length && hits.length < flimit; ni++) {
        var nd = candidates[ni]; scanned++;
        if (nameRe && !nameRe.test(nd.name)) continue;
        if (textRe && (nd.type !== 'TEXT' || !textRe.test(nd.characters))) continue;
        var h = { id: nd.id, name: nd.name, type: nd.type, page: pg.name };
        if (typeof nd.x === 'number') { h.x = Math.round(nd.x); h.y = Math.round(nd.y); h.w = Math.round(nd.width); h.h = Math.round(nd.height); }
        if (nd.type === 'TEXT') h.characters = nd.characters.slice(0, 120);
        hits.push(h);
      }
    }
    return { result: { hits: hits, scanned: scanned, pages: pages.length, truncated: hits.length >= flimit } };
  }

  if (kind === 'library') {
    var lib;
    try { lib = figma.teamLibrary; }
    catch (e) { throw new Error('Team library access needs "teamlibrary" in plugin/manifest.json permissions (re-import the plugin after adding it). ' + e.message); }
    var action = p.action || 'collections';
    if (action === 'collections') {
      var cols = await lib.getAvailableLibraryVariableCollectionsAsync();
      return { result: { collections: cols.map(function (c) { return { key: c.key, name: c.name, library: c.libraryName }; }) } };
    }
    if (action === 'variables') {
      if (!p.collectionKey) throw new Error('collectionKey required');
      var lvars = await lib.getVariablesInLibraryCollectionAsync(p.collectionKey);
      return { result: { variables: lvars.map(function (v) { return { key: v.key, name: v.name, type: v.resolvedType }; }) } };
    }
    if (action === 'import') {
      if (!p.key) throw new Error('key required');
      var what = p.kind || 'component';
      var imported;
      if (what === 'component') imported = await figma.importComponentByKeyAsync(p.key);
      else if (what === 'componentSet') imported = await figma.importComponentSetByKeyAsync(p.key);
      else if (what === 'style') imported = await figma.importStyleByKeyAsync(p.key);
      else if (what === 'variable') imported = await figma.importVariableByKeyAsync(p.key);
      else throw new Error('kind must be component | componentSet | style | variable');
      var res = { id: imported.id, name: imported.name, kind: what };
      if (what === 'component' && p.instance) {
        var inst = imported.createInstance();
        var parent = p.parentId ? await figma.getNodeByIdAsync(p.parentId) : null;
        (parent || figma.currentPage).appendChild(inst);
        if (p.x !== undefined) inst.x = p.x;
        if (p.y !== undefined) inst.y = p.y;
        res.instanceId = inst.id;
      }
      return { result: res };
    }
    throw new Error('unknown library action: ' + action);
  }

  if (kind === 'export') {
    var ids = p.nodeIds;
    var nodes = [];
    if (ids && ids.length) {
      for (var i = 0; i < ids.length; i++) {
        var n = await figma.getNodeByIdAsync(ids[i]);
        if (!n) throw new Error('node not found: ' + ids[i]);
        nodes.push(n);
      }
    } else {
      nodes = figma.currentPage.selection.slice();
      if (!nodes.length) throw new Error('nothing selected and no nodeIds given');
    }
    var format = String(p.format || 'PNG').toUpperCase();
    // JSON = the subtree in Figma REST API shape (JSON_REST_V1). SVG is fetched as a string so
    // both can ride along inline in the result as well as being written to disk.
    var settings = { format: format === 'JSON' ? 'JSON_REST_V1' : format === 'SVG' ? 'SVG_STRING' : format };
    if (format === 'PNG' || format === 'JPG') settings.constraint = { type: 'SCALE', value: p.scale || 1 };
    if (p.contentsOnly !== undefined) settings.contentsOnly = !!p.contentsOnly;
    if (p.useAbsoluteBounds !== undefined) settings.useAbsoluteBounds = !!p.useAbsoluteBounds;
    var inlineLimit = p.inlineTextLimit || 200000;
    var blobs = [];
    var meta = [];
    for (var j = 0; j < nodes.length; j++) {
      var node = nodes[j];
      var data = await node.exportAsync(settings);
      var text = format === 'JSON' ? JSON.stringify(data, null, 1) : format === 'SVG' ? String(data) : null;
      var fname = (node.name || node.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) +
        '_' + node.id.replace(/[^0-9A-Za-z]/g, '-') + '.' + format.toLowerCase();
      blobs.push({ name: fname, bytes: text !== null ? text : data });
      var m = { nodeId: node.id, name: node.name, width: node.width, height: node.height, file: fname };
      if (text !== null) { if (text.length <= inlineLimit) m.text = text; else m.textBytes = text.length; }
      meta.push(m);
    }
    return { result: { exported: meta }, blobs: blobs };
  }

  if (kind === 'placeImage') {
    var target = await figma.getNodeByIdAsync(p.nodeId);
    if (!target) throw new Error('node not found: ' + p.nodeId);
    if (!p.bytes) throw new Error('image bytes missing (UI did not fetch the asset)');
    var image = figma.createImage(p.bytes);
    var size = await image.getSizeAsync();
    if (!('fills' in target)) throw new Error(target.type + ' cannot take an image fill');
    target.fills = [{ type: 'IMAGE', scaleMode: p.scaleMode || 'FILL', imageHash: image.hash }];
    return {
      result: {
        nodeId: target.id, nodeName: target.name, imageHash: image.hash,
        imageWidth: size.width, imageHeight: size.height,
        nodeWidth: target.width, nodeHeight: target.height,
        source: p.name || null,
        prepared: p.prepared || null,
      },
    };
  }

  throw new Error('unknown command kind: ' + kind);
}

/* -------------------------------------------------------------- changes --- */
// Node changes on every page we have seen, so the agent can ask "what changed since I last
// looked". Edits made while a command runs are tagged byPlugin; the rest came from a person.
var CHANGES = [];
var CHANGE_SEQ = 0;
var BUSY = 0;
var MUTATING = { eval: 1, placeImage: 1, library: 1 };
var lastMutationEnd = 0;       // change events arrive batched AFTER the command, so attribution is by time window
var UNDO_WINDOW_MS = 60000;    // how long figma_history {action:"undo"} can still revert the last call
var commitTimer = null;
var watchedPages = {};
function recordChanges(ev) {
  var list = ev && ev.nodeChanges ? ev.nodeChanges : [];
  for (var i = 0; i < list.length; i++) {
    var ch = list[i];
    var e = { seq: ++CHANGE_SEQ, t: Date.now(), type: ch.type, id: ch.id, origin: ch.origin, byPlugin: BUSY > 0 || (Date.now() - lastMutationEnd) < 2000 };
    try { if (ch.node && !ch.node.removed) { e.name = ch.node.name; e.nodeType = ch.node.type; } } catch (x) {}
    if (ch.properties) e.properties = ch.properties;
    CHANGES.push(e);
  }
  if (CHANGES.length > 1000) CHANGES.splice(0, CHANGES.length - 1000);
}
function watchPage(page) {
  if (!page || watchedPages[page.id]) return;
  watchedPages[page.id] = 1;
  try { page.on('nodechange', recordChanges); } catch (e) {}
}
watchPage(figma.currentPage);
figma.on('currentpagechange', function () { watchPage(figma.currentPage); });

/* ------------------------------------------------------------ ui wiring --- */
figma.showUI(__html__, { width: 300, height: 172, themeColors: true });

// "Reconnect localfig" button in the properties panel of files the plugin has run in.
try {
  if (!figma.root.getRelaunchData().open) figma.root.setRelaunchData({ open: 'Reopen the localfig panel so the agent can work in this file' });
} catch (e) {}

figma.ui.onmessage = async function (msg) {
  if (!msg) return;
  if (msg.stop) { figma.closePlugin('Bridge stopped'); return; }
  if (msg.hello) {
    figma.ui.postMessage({ helloPayload: await currentContext() });
    return;
  }
  if (!msg.command) return;
  var cmd = msg.command;
  var mutating = !!MUTATING[cmd.kind];
  if (mutating) {
    // Checkpoint BEFORE the call: figma.triggerUndo() reverts to the last commit, so this is what
    // lets figma_history {action:"undo"} revert exactly this call. The call's own edits get committed
    // for the person's Ctrl+Z after UNDO_WINDOW_MS, or at the next checkpoint, whichever comes first.
    try { figma.commitUndo(); } catch (e0) {}
    if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
  }
  BUSY++;
  try {
    var out = await runCommand(cmd);
    figma.ui.postMessage({
      reply: { id: cmd.id, ok: true, result: out.result, blobs: out.blobs || null },
    });
  } catch (e) {
    figma.ui.postMessage({
      reply: { id: cmd.id, ok: false, error: String((e && e.message) || e) },
    });
  } finally {
    BUSY--;
    if (mutating) {
      lastMutationEnd = Date.now();
      commitTimer = setTimeout(function () { commitTimer = null; try { figma.commitUndo(); } catch (e1) {} }, UNDO_WINDOW_MS);
    }
  }
};

figma.on('selectionchange', function () {
  figma.ui.postMessage({ tick: figma.currentPage.selection.length });
});
