"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { fileUri, normalizeFsPath } = require("./lsp-client");

const ACTIONS = [
  "status",
  "wait_for_index",
  "configure",
  "diagnostics",
  "completion",
  "hover",
  "definition",
  "references",
  "document_symbols",
  "workspace_symbols",
  "scope_at",
  "rename",
  "mod_overview",
  "overrides",
  "dependencies",
  "example_wiki",
  "example_wiki_entry",
  "gui_tree",
  "gui_layout",
  "gui_widget_info",
  "gui_dependencies",
  "gui_vocabulary",
  "gui_source_edit",
  "gui_preview_file",
  "reload_docs",
  "raw_request",
];

function requireArg(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing required argument: ${key}`);
  }
  return value;
}

function position(args) {
  return {
    line: Math.max(0, Number(args?.line ?? 0)),
    character: Math.max(0, Number(args?.character ?? 0)),
  };
}

async function guiDocument(args) {
  const file = normalizeFsPath(requireArg(args, "file"));
  const text =
    args.text === undefined || args.text === null ? await fs.readFile(file, "utf8") : String(args.text);
  return { file, uri: fileUri(file), text };
}

function rgba(color, fallback = "rgba(65,80,105,.32)") {
  if (!Array.isArray(color) || color.length < 4) return fallback;
  const [r, g, b, a] = color;
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${Math.max(0, Math.min(1, a))})`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function flattenLayout(nodes, depth = 0, out = []) {
  for (const node of nodes || []) {
    out.push({ ...node, depth });
    flattenLayout(node.children, depth + 1, out);
  }
  return out;
}

function previewHtml(file, layout) {
  const flat = flattenLayout(layout?.nodes || []);
  const rects = flat
    .map((node, index) => {
      const rect = node.rect || { x: 0, y: 0, w: 0, h: 0 };
      const fill = node.fill || node.bg || {};
      const color = rgba(fill.color, node.ghost ? "rgba(121,105,160,.18)" : "rgba(70,90,125,.22)");
      const label = node.text?.text || node.name || node.key;
      const texture = fill.texture ? ` · ${fill.texture}` : "";
      return `<g class="node depth-${Math.min(node.depth, 8)}" data-i="${index}">
      <rect x="${rect.x}" y="${rect.y}" width="${Math.max(1, rect.w)}" height="${Math.max(1, rect.h)}" fill="${color}" opacity="${node.ghost ? 0.45 : 1}" />
      <text x="${rect.x + 4}" y="${rect.y + Math.max(12, Number(node.text?.fontsize || 11))}" font-size="${Math.max(8, Math.min(24, Number(node.text?.fontsize || 11)))}">${escapeHtml(label)}</text>
      <title>${escapeHtml(`${node.key}${node.name ? ` ${node.name}` : ""}${texture} · line ${node.line === undefined ? "derived" : node.line + 1} · ${rect.x},${rect.y} ${rect.w}×${rect.h}`)}</title>
    </g>`;
    })
    .join("\n");
  const bounds = flat.reduce(
    (acc, node) => {
      const r = node.rect || {};
      acc.minX = Math.min(acc.minX, Number(r.x || 0));
      acc.minY = Math.min(acc.minY, Number(r.y || 0));
      acc.maxX = Math.max(acc.maxX, Number(r.x || 0) + Number(r.w || 0));
      acc.maxY = Math.max(acc.maxY, Number(r.y || 0) + Number(r.h || 0));
      return acc;
    },
    { minX: 0, minY: 0, maxX: 1280, maxY: 720 }
  );
  const width = Math.max(100, bounds.maxX - bounds.minX);
  const height = Math.max(100, bounds.maxY - bounds.minY);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>px-lsp GUI Preview · ${escapeHtml(path.basename(file))}</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0b0f16;color:#d9e2f2;font:13px/1.45 system-ui,sans-serif}.bar{position:sticky;top:0;z-index:2;padding:10px 14px;background:#111824e8;border-bottom:1px solid #26334a;backdrop-filter:blur(10px)}.title{font-weight:700}.meta{color:#8fa2bf;margin-left:10px}.stage{padding:18px;overflow:auto}.frame{width:max-content;min-width:100%;background:#141b27;border:1px solid #2c3950;box-shadow:0 14px 50px #0008}.node rect{stroke:#7997c9;stroke-width:1;vector-effect:non-scaling-stroke}.node:hover rect{stroke:#73d4ff;stroke-width:2}.node text{fill:#e5edf9;pointer-events:none;text-shadow:0 1px 2px #000}.depth-0 rect{stroke:#d5a95d}.foot{padding:10px 14px;color:#8fa2bf;border-top:1px solid #26334a}
</style></head><body>
<div class="bar"><span class="title">${escapeHtml(path.basename(file))}</span><span class="meta">${layout.nodeCount} widgets · ${layout.defsFiles} GUI definition files · ${layout.timings?.totalMs ?? "?"} ms</span></div>
<div class="stage"><svg class="frame" viewBox="${bounds.minX} ${bounds.minY} ${width} ${height}" width="${width}" height="${height}">${rects}</svg></div>
<div class="foot">Hover a widget for its type, source line, rectangle and texture path. This preview is measured by px-lsp; runtime-only datafunctions remain approximations.</div>
</body></html>`;
}

async function runAction(client, action, args = {}) {
  switch (action) {
    case "status":
      return client.status();
    case "wait_for_index":
      return client.waitForIndex({
        timeoutMs: Number(args.timeoutMs || 120000),
        minimumDefinitions: Number(args.minimumDefinitions || 1),
      });
    case "configure":
      return client.configure(args.settings || args);
    case "diagnostics":
      return client.getDiagnostics(requireArg(args, "file"), args.text, Number(args.timeoutMs || 2500));
    case "completion":
      return client.documentRequest(
        "textDocument/completion",
        requireArg(args, "file"),
        position(args),
        args.text,
        {
          context: { triggerKind: 1 },
        }
      );
    case "hover":
      return client.documentRequest(
        "textDocument/hover",
        requireArg(args, "file"),
        position(args),
        args.text
      );
    case "definition":
      return client.documentRequest(
        "textDocument/definition",
        requireArg(args, "file"),
        position(args),
        args.text
      );
    case "references":
      return client.documentRequest(
        "textDocument/references",
        requireArg(args, "file"),
        position(args),
        args.text,
        {
          context: { includeDeclaration: args.includeDeclaration !== false },
        }
      );
    case "document_symbols":
      return client.documentRequest("textDocument/documentSymbol", requireArg(args, "file"), null, args.text);
    case "workspace_symbols":
      return client.request("workspace/symbol", { query: String(args.query || "") });
    case "scope_at": {
      const doc = await client.openDocument(requireArg(args, "file"), args.text);
      return client.request("paradox/scopeAt", { uri: doc.uri, position: position(args) });
    }
    case "rename":
      return client.documentRequest(
        "textDocument/rename",
        requireArg(args, "file"),
        position(args),
        args.text,
        {
          newName: String(requireArg(args, "newName")),
        }
      );
    case "mod_overview":
      return client.request("paradox/modOverview", { modRoot: normalizeFsPath(args.modRoot) });
    case "overrides":
      // 与初始化根目录使用同一规范，避免 Windows 正反斜杠导致错误的空结果。
      return client.request("paradox/overrides", { modRoot: normalizeFsPath(args.modRoot) });
    case "dependencies": {
      const params = { guiUses: args.guiUses === true };
      if (args.file) {
        const doc = await client.openDocument(args.file, args.text);
        params.uri = doc.uri;
        params.position = position(args);
      } else {
        params.name = String(requireArg(args, "name"));
        if (args.kind) params.kind = String(args.kind);
      }
      return client.request("paradox/dependencies", params);
    }
    case "example_wiki": {
      const result = await client.request("paradox/exampleWiki", null);
      const query = String(args.query || "")
        .trim()
        .toLowerCase();
      if (!query) return result;
      const rows = Array.isArray(result?.entries)
        ? result.entries
        : Array.isArray(result?.rows)
          ? result.rows
          : [];
      return {
        ...result,
        entries: rows
          .filter((row) => `${row.name} ${row.kind} ${row.shortDoc || ""}`.toLowerCase().includes(query))
          .slice(0, Number(args.limit || 100)),
      };
    }
    case "example_wiki_entry":
      return client.request("paradox/exampleWikiEntry", {
        name: String(requireArg(args, "name")),
        kind: args.kind || undefined,
      });
    case "gui_tree": {
      const doc = await guiDocument(args);
      return client.request("paradox/guiTree", { uri: doc.uri, text: doc.text });
    }
    case "gui_layout": {
      const doc = await guiDocument(args);
      return client.request("paradox/guiLayout", {
        uri: doc.uri,
        text: doc.text,
        visibility: args.visibility || {
          mode: args.visibilityMode || "showAll",
          checks: args.visibilityChecks || {},
        },
        loc: args.loc || "resolve",
        previewValues: args.previewValues || {},
      });
    }
    case "gui_widget_info": {
      const doc = await guiDocument(args);
      return client.request("paradox/guiWidgetInfo", {
        uri: doc.uri,
        text: doc.text,
        line: Number(requireArg(args, "line")),
        placement: args.placement === true,
      });
    }
    case "gui_dependencies": {
      const doc = await guiDocument(args);
      return client.request("paradox/guiDependencies", {
        uri: doc.uri,
        text: doc.text,
        ...(args.line === undefined ? {} : { line: Number(args.line) }),
      });
    }
    case "gui_vocabulary": {
      const doc = await guiDocument(args);
      return client.request("paradox/guiVocabulary", { uri: doc.uri, text: doc.text });
    }
    case "gui_source_edit": {
      const doc = await guiDocument(args);
      return client.request("paradox/guiSourceEdit", {
        uri: doc.uri,
        text: doc.text,
        ...(args.ops ? { ops: args.ops } : { op: requireArg(args, "op") }),
      });
    }
    case "gui_preview_file": {
      const doc = await guiDocument(args);
      const layout = await client.request("paradox/guiLayout", {
        uri: doc.uri,
        text: doc.text,
        visibility: args.visibility || {
          mode: args.visibilityMode || "showAll",
          checks: args.visibilityChecks || {},
        },
        loc: args.loc || "resolve",
        previewValues: args.previewValues || {},
      });
      const output = normalizeFsPath(
        args.output ||
          path.join(
            os.tmpdir(),
            "px-lsp-previews",
            `${path.basename(doc.file, path.extname(doc.file))}-${Date.now()}.html`
          )
      );
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, previewHtml(doc.file, layout), "utf8");
      return {
        output,
        file: doc.file,
        nodeCount: layout.nodeCount,
        timings: layout.timings,
        visibilityChecks: layout.visibilityChecks,
      };
    }
    case "reload_docs":
      return client.request("paradox/reloadDocs", null);
    case "raw_request":
      return client.request(String(requireArg(args, "method")), args.params ?? null);
    default:
      throw new Error(`unknown action ${action}; use one of: ${ACTIONS.join(", ")}`);
  }
}

module.exports = { ACTIONS, flattenLayout, previewHtml, runAction };
