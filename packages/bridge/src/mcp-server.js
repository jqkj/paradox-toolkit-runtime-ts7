"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { PxLspClient, DEFAULTS } = require("./lsp-client");
const { runAction } = require("./tool-actions");

const root = fs.existsSync(path.join(__dirname, "vendor")) ? __dirname : path.resolve(__dirname, "..");
const serverScript = path.join(root, "vendor", "px-lsp", "dist", "server.js");
const settings = {
  ...DEFAULTS,
  gamePath: process.env.PX_GAME_PATH || DEFAULTS.gamePath,
  logsPath: process.env.PX_LOGS_PATH || DEFAULTS.logsPath,
  modPath: process.env.PX_MOD_PATH || DEFAULTS.modPath,
  workspaceMods: [process.env.PX_MOD_PATH || DEFAULTS.modPath].filter(Boolean),
  indexExcludeDirectories: process.env.PX_INDEX_EXCLUDE_DIRECTORIES
    ? JSON.parse(process.env.PX_INDEX_EXCLUDE_DIRECTORIES)
    : DEFAULTS.indexExcludeDirectories,
  locLanguage: process.env.PX_LOC_LANGUAGE || DEFAULTS.locLanguage,
};
const client = new PxLspClient({
  serverScript,
  storageDir: process.env.PX_STORAGE_DIR,
  settings,
});

const filePosition = {
  type: "object",
  properties: {
    file: { type: "string", description: "Absolute path to the Paradox source file." },
    line: { type: "integer", minimum: 0, description: "0-based line." },
    character: { type: "integer", minimum: 0, description: "0-based UTF-16 character." },
    text: { type: "string", description: "Optional unsaved buffer text; disk content is used when omitted." },
  },
  required: ["file", "line", "character"],
  additionalProperties: false,
};

const guiFile = {
  type: "object",
  properties: {
    file: { type: "string", description: "Absolute path to a .gui file." },
    text: { type: "string", description: "Optional unsaved buffer text." },
    loc: { type: "string", enum: ["resolve", "raw"] },
    visibilityMode: { type: "string", enum: ["showAll", "hideAll", "evaluate"] },
    visibilityChecks: { type: "object", additionalProperties: { type: "boolean" } },
    previewValues: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["file"],
  additionalProperties: false,
};

const tools = [
  {
    name: "px_status",
    description:
      "Read px-lsp process health, index status, configured roots, definition counts and recent server logs.",
    action: "status",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "px_wait_for_index",
    description: "Wait until px-lsp finishes indexing the configured CK3 game and mod roots.",
    action: "wait_for_index",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
        minimumDefinitions: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "px_configure",
    description: "Change px-lsp game/mod/log roots or language and rebuild the index. Use absolute paths.",
    action: "configure",
    inputSchema: {
      type: "object",
      properties: { settings: { type: "object", additionalProperties: true } },
      required: ["settings"],
      additionalProperties: false,
    },
  },
  {
    name: "px_diagnostics",
    description:
      "Return px-lsp syntax, schema, reference and scope diagnostics for a Paradox script, localization, GUI or asset file.",
    action: "diagnostics",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        text: { type: "string" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 30000 },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "px_completion",
    description: "Get context-aware Paradox completion items at a source position.",
    action: "completion",
    inputSchema: filePosition,
  },
  {
    name: "px_hover",
    description:
      "Get token documentation, inferred scope/value information and previews at a source position.",
    action: "hover",
    inputSchema: filePosition,
  },
  {
    name: "px_definition",
    description: "Resolve the typed Paradox definition under the cursor, including mod/parent/vanilla sites.",
    action: "definition",
    inputSchema: filePosition,
  },
  {
    name: "px_references",
    description: "Find indexed references to the typed Paradox symbol under the cursor.",
    action: "references",
    inputSchema: {
      ...filePosition,
      properties: { ...filePosition.properties, includeDeclaration: { type: "boolean" } },
    },
  },
  {
    name: "px_symbols",
    description:
      "List document symbols for one file, or workspace symbols when query is supplied without file.",
    action: "__symbols",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, text: { type: "string" }, query: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "px_scope_at",
    description: "Show the inferred CK3 scope chain and visible saved scopes at a source position.",
    action: "scope_at",
    inputSchema: filePosition,
  },
  {
    name: "px_rename",
    description:
      "Compute a version-aware workspace edit to rename a supported Paradox symbol. The bridge never applies edits itself.",
    action: "rename",
    inputSchema: {
      ...filePosition,
      properties: { ...filePosition.properties, newName: { type: "string" } },
      required: [...filePosition.required, "newName"],
    },
  },
  {
    name: "px_mod_overview",
    description: "Inventory indexed definitions/references in the mod, grouped by Paradox definition kind.",
    action: "mod_overview",
    inputSchema: {
      type: "object",
      properties: { modRoot: { type: ["string", "null"] } },
      additionalProperties: false,
    },
  },
  {
    name: "px_overrides",
    description: "Report mod definitions that shadow vanilla or parent mods and identify LIOS/FIOS winners.",
    action: "overrides",
    inputSchema: {
      type: "object",
      properties: { modRoot: { type: ["string", "null"] } },
      additionalProperties: false,
    },
  },
  {
    name: "px_dependencies",
    description:
      "Explore incoming/outgoing dependencies for a definition by cursor or by name/kind, optionally including GUI uses.",
    action: "dependencies",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        text: { type: "string" },
        line: { type: "integer", minimum: 0 },
        character: { type: "integer", minimum: 0 },
        name: { type: "string" },
        kind: { type: "string" },
        guiUses: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "px_example_wiki",
    description:
      "Search px-lsp's evidence-backed catalog of triggers, effects, targets, modifiers, datafunctions, types, keywords, scopes and indexed variables.",
    action: "example_wiki",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 } },
      additionalProperties: false,
    },
  },
  {
    name: "px_example_wiki_entry",
    description:
      "Get all known documentation, usage, scopes, signatures and example sites for one px-lsp catalog entry.",
    action: "example_wiki_entry",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, kind: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "px_gui_tree",
    description: "Parse a .gui file into its widget/declaration/state tree.",
    action: "gui_tree",
    inputSchema: guiFile,
  },
  {
    name: "px_gui_layout",
    description:
      "Measure a .gui file into render-ready rectangles, fills, localized text, visibility checks and timings.",
    action: "gui_layout",
    inputSchema: guiFile,
  },
  {
    name: "px_gui_widget_info",
    description:
      "Inspect effective properties, inheritance origins, textures and optional placement trace for one GUI widget source line.",
    action: "gui_widget_info",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        text: { type: "string" },
        line: { type: "integer", minimum: 0 },
        placement: { type: "boolean" },
      },
      required: ["file", "line"],
      additionalProperties: false,
    },
  },
  {
    name: "px_gui_dependencies",
    description:
      "Show scripted_gui, event/on_action and localization dependencies reached from a whole GUI file or one widget subtree.",
    action: "gui_dependencies",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        text: { type: "string" },
        line: { type: "integer", minimum: 0 },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "px_gui_source_edit",
    description:
      "Compute surgical source edits for a GUI designer operation; returns offsets and never writes the file.",
    action: "gui_source_edit",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        text: { type: "string" },
        op: { type: "object", additionalProperties: true },
        ops: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "px_gui_preview_file",
    description:
      "Render px-lsp's measured GUI layout as a standalone interactive HTML/SVG preview and return its absolute path.",
    action: "gui_preview_file",
    inputSchema: {
      ...guiFile,
      properties: {
        ...guiFile.properties,
        output: { type: "string", description: "Optional absolute .html output path." },
      },
    },
  },
  {
    name: "px_raw_request",
    description:
      "Call any px-lsp standard or paradox/* JSON-RPC request not covered by a dedicated tool. Read docs/PROTOCOL.md for parameters.",
    action: "raw_request",
    inputSchema: {
      type: "object",
      properties: { method: { type: "string" }, params: {} },
      required: ["method"],
      additionalProperties: false,
    },
  },
];

const byName = new Map(tools.map((tool) => [tool.name, tool]));
const mcp = new Server(
  { name: "paradox-toolkit-runtime-ts7", version: require("../package.json").version },
  { capabilities: { tools: {} } }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ action: _action, ...tool }) => tool),
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const def = byName.get(request.params.name);
  if (!def) throw new Error(`unknown tool: ${request.params.name}`);
  const args = request.params.arguments || {};
  try {
    let result;
    if (def.action === "__symbols") {
      result = args.file
        ? await runAction(client, "document_symbols", args)
        : await runAction(client, "workspace_symbols", args);
    } else {
      result = await runAction(client, def.action, args);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    };
  }
});

async function shutdown() {
  try {
    await client.stop();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
