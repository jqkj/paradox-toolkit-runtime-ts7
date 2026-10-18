"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { PxLspClient, DEFAULTS, normalizeFsPath } = require("./lsp-client");
const { ACTIONS, runAction } = require("./tool-actions");

let client = null;
let configuredWorkspace = null;

async function workspaceRoot() {
  try {
    const workspace = await pi.workspace.get();
    return workspace?.path ? normalizeFsPath(workspace.path) : DEFAULTS.modPath;
  } catch {
    return DEFAULTS.modPath;
  }
}

async function ensureClient() {
  const root = await workspaceRoot();
  if (!client) {
    let pluginSettings = {};
    let storageDir;
    try {
      pluginSettings = await pi.plugin.getSettings();
    } catch {}
    try {
      storageDir = path.join(await pi.plugin.getDataPath(), "px-lsp");
    } catch {}
    client = new PxLspClient({
      serverScript: path.join(__dirname, "vendor", "px-lsp", "dist", "server.js"),
      storageDir,
      settings: {
        ...DEFAULTS,
        gamePath: pluginSettings.gamePath || DEFAULTS.gamePath,
        logsPath: pluginSettings.logsPath || DEFAULTS.logsPath,
        locLanguage: pluginSettings.locLanguage || DEFAULTS.locLanguage,
        modPath: root,
        workspaceMods: [root].filter(Boolean),
      },
    });
    configuredWorkspace = root;
  } else if (root && root !== configuredWorkspace) {
    await client.setWorkspace(root);
    configuredWorkspace = root;
  }
  await client.start();
  return client;
}

async function listGuiFiles(root, cap = 1200) {
  const out = [];
  const queue = [root];
  while (queue.length && out.length < cap) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "test") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gui")) {
        out.push({ file: full, relative: path.relative(root, full).replaceAll("\\", "/") });
        if (out.length >= cap) break;
      }
    }
  }
  out.sort((a, b) => a.relative.localeCompare(b.relative));
  return out;
}

const toolSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ACTIONS },
    file: {
      type: "string",
      description: "Absolute source path; defaults are never guessed for file-specific actions.",
    },
    text: { type: "string", description: "Optional unsaved document text." },
    line: { type: "integer", minimum: 0 },
    character: { type: "integer", minimum: 0 },
    query: { type: "string" },
    name: { type: "string" },
    kind: { type: "string" },
    newName: { type: "string" },
    method: { type: "string" },
    params: {},
    settings: { type: "object" },
    modRoot: { type: ["string", "null"] },
    includeDeclaration: { type: "boolean" },
    guiUses: { type: "boolean" },
    loc: { type: "string", enum: ["resolve", "raw"] },
    visibilityMode: { type: "string", enum: ["showAll", "hideAll", "evaluate"] },
    visibilityChecks: { type: "object", additionalProperties: { type: "boolean" } },
    previewValues: { type: "object", additionalProperties: { type: "string" } },
    placement: { type: "boolean" },
    op: { type: "object" },
    ops: { type: "array", items: { type: "object" } },
    output: { type: "string" },
    timeoutMs: { type: "integer", minimum: 100 },
  },
  required: ["action"],
  additionalProperties: true,
};

async function onLoad() {
  await pi.agent.registerTool({
    name: "ParadoxToolkit",
    description:
      "Use px-lsp for CK3/Paradox code intelligence and GUI analysis: status, diagnostics, completion, hover, definition, references, scope inference, dependency/override reports, rename edits, GUI tree/layout/inspector/source edits, and raw paradox/* requests. Call ToolSearch for Paradox or px-lsp to activate it.",
    risk: "medium",
    schema: toolSchema,
    execute: async (args) => {
      const active = await ensureClient();
      return runAction(active, String(args?.action || "status"), args || {});
    },
  });
  void ensureClient().catch(() => {});
}

async function onUnload() {
  try {
    await pi.agent.unregisterTool("ParadoxToolkit");
  } catch {}
  if (client) await client.stop();
  client = null;
}

async function onPanelInvoke(channel, payload) {
  try {
    const active = await ensureClient();
    if (channel === "px.hello") {
      const root = await workspaceRoot();
      const [status, files] = await Promise.all([active.status(), listGuiFiles(root)]);
      return { ok: true, root, files, status };
    }
    if (channel === "px.status") return { ok: true, status: await active.status() };
    if (channel === "px.gui.list") {
      const root = await workspaceRoot();
      return { ok: true, root, files: await listGuiFiles(root) };
    }
    if (channel === "px.gui.layout") {
      return { ok: true, result: await runAction(active, "gui_layout", payload || {}) };
    }
    if (channel === "px.gui.tree") {
      return { ok: true, result: await runAction(active, "gui_tree", payload || {}) };
    }
    if (channel === "px.gui.info") {
      return { ok: true, result: await runAction(active, "gui_widget_info", payload || {}) };
    }
    if (channel === "px.gui.dependencies") {
      return { ok: true, result: await runAction(active, "gui_dependencies", payload || {}) };
    }
    return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  } catch (error) {
    return { ok: false, code: error?.code || "PX_LSP_ERROR", message: error?.message || String(error) };
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
