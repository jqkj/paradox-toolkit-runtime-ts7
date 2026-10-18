"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require("vscode-jsonrpc/node");
const { URI } = require("vscode-uri");

const { FileWatcher } = require("./file-watcher");

const DEFAULTS = Object.freeze({
  indexExcludeDirectories: [],
  gameId: "ck3",
  gamePath: null,
  logsPath: null,
  modPath: null,
  locLanguage: "simp_chinese",
});

function normalizeFsPath(value) {
  if (!value) return null;
  return path.resolve(String(value));
}

function fileUri(file) {
  return URI.file(normalizeFsPath(file)).toString();
}

function fsPathFromUri(uri) {
  return URI.parse(uri).fsPath;
}

function languageId(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".yml" || ext === ".yaml") return "paradox-localization";
  if (ext === ".gui") return "paradox-gui";
  if (ext === ".asset") return "paradox-asset";
  return "paradox";
}

function compactError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

class PxLspClient {
  constructor(options = {}) {
    this.serverScript = normalizeFsPath(options.serverScript);
    this.storageDir = normalizeFsPath(
      options.storageDir || path.join(os.homedir(), ".cache", "px-lsp", "pi-codex")
    );
    this.baseSettings = { ...DEFAULTS, ...(options.settings || {}) };
    this.settings = this._normalizedSettings(this.baseSettings);
    this.child = null;
    this.connection = null;
    this.startPromise = null;
    this.initialized = false;
    this.serverInfo = null;
    this.capabilities = null;
    this.lastStatus = null;
    this.logs = [];
    this.diagnostics = new Map();
    this.documentVersions = new Map();
    this.documentText = new Map();
    this.diskDocuments = new Set();
    this.fileWatcher = null;
    this.watchSignature = null;
    this.statusWaiters = new Set();
    this.diagnosticWaiters = new Map();
  }

  _normalizedSettings(input) {
    const settings = { ...input };
    for (const key of ["gamePath", "logsPath", "modPath"]) {
      if (settings[key]) settings[key] = normalizeFsPath(settings[key]);
    }
    if (Array.isArray(settings.workspaceMods)) {
      settings.workspaceMods = settings.workspaceMods.map(normalizeFsPath).filter(Boolean);
    } else if (settings.modPath) {
      settings.workspaceMods = [settings.modPath];
    }
    if (Array.isArray(settings.parentPaths)) {
      settings.parentPaths = settings.parentPaths.map(normalizeFsPath).filter(Boolean);
    }
    return settings;
  }

  async configure(partial = {}) {
    const next = this._normalizedSettings({ ...this.settings, ...partial });
    const rootsChanged = ["gameId", "gamePath", "logsPath", "modPath", "workspaceMods", "parentPaths"].some(
      (key) => JSON.stringify(next[key]) !== JSON.stringify(this.settings[key])
    );
    this.settings = next;
    if (this.initialized) {
      await this.connection.sendNotification("paradox/configChanged", this.settings);
    }
    return { settings: this.settings, rootsChanged };
  }

  async setWorkspace(modPath, extra = {}) {
    const resolved = normalizeFsPath(modPath || this.settings.modPath);
    return this.configure({
      ...extra,
      modPath: resolved,
      workspaceMods: extra.workspaceMods || (resolved ? [resolved] : []),
    });
  }

  async start() {
    if (this.initialized) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start().catch((error) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  async _start() {
    if (!this.serverScript) throw new Error("px-lsp serverScript is not configured");
    const fsSync = require("node:fs");
    if (!fsSync.existsSync(this.serverScript)) {
      throw new Error(`px-lsp serverScript does not exist at: ${this.serverScript}`);
    }
    await fs.mkdir(this.storageDir, { recursive: true });
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=4096", this.serverScript, "--stdio", "--clientProcessId", String(process.pid)],
      {
        cwd: path.dirname(this.serverScript),
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this._log("stderr", String(chunk).trim()));
    child.on("error", (error) => this._log("process", compactError(error)));
    child.on("exit", (code, signal) => {
      this._log("process", `px-lsp exited code=${code} signal=${signal || "none"}`);
      this.fileWatcher?.close();
      this.fileWatcher = null;
      this.watchSignature = null;
      this.startPromise = null;
      this.initialized = false;
      this.documentVersions.clear();
      this.documentText.clear();
      this.diskDocuments.clear();
      this.diagnostics.clear();
      this.connection = null;
      this.child = null;
    });

    const logger = {
      error: (message) => this._log("jsonrpc:error", String(message)),
      warn: (message) => this._log("jsonrpc:warn", String(message)),
      info: (message) => this._log("jsonrpc:info", String(message)),
      log: (message) => this._log("jsonrpc", String(message)),
    };
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
      logger
    );
    this.connection = connection;
    connection.onNotification("window/logMessage", (payload) => {
      this._log("lsp", payload?.message || JSON.stringify(payload));
    });
    connection.onNotification("paradox/watchRoots", (payload) => this._watchRoots(payload));
    connection.onNotification("paradox/status", (payload) => {
      this.lastStatus = payload;
      for (const resolve of this.statusWaiters) resolve(payload);
      this.statusWaiters.clear();
    });
    connection.onNotification("paradox/indexChanged", (payload) => {
      this._log("index", JSON.stringify(payload || {}));
    });
    connection.onNotification("textDocument/publishDiagnostics", (payload) => {
      if (!payload?.uri) return;
      this.diagnostics.set(payload.uri, payload.diagnostics || []);
      const waiters = this.diagnosticWaiters.get(payload.uri) || [];
      this.diagnosticWaiters.delete(payload.uri);
      for (const resolve of waiters) resolve(payload.diagnostics || []);
    });
    connection.onRequest("workspace/configuration", () => [this.settings]);
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("client/unregisterCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("workspace/applyEdit", () => ({
      applied: false,
      failureReason: "host-owned edits",
    }));
    connection.onNotification("$/progress", () => {});
    connection.listen();

    const modPath = this.settings.modPath;
    const rootUri = modPath ? fileUri(modPath) : null;
    const result = await connection.sendRequest("initialize", {
      processId: process.pid,
      clientInfo: { name: "PI-Desktop Codex px-lsp bridge", version: "0.1.0" },
      rootUri,
      workspaceFolders: rootUri ? [{ uri: rootUri, name: path.basename(modPath) }] : null,
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeConfiguration: { dynamicRegistration: false },
          symbol: { dynamicRegistration: false },
          workspaceEdit: { documentChanges: true },
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          completion: {
            dynamicRegistration: false,
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
          },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          diagnostic: { dynamicRegistration: false },
          rename: { dynamicRegistration: false, prepareSupport: true },
          semanticTokens: {
            dynamicRegistration: false,
            requests: { full: true, range: true },
            tokenTypes: [],
            tokenModifiers: [],
            formats: ["relative"],
          },
        },
      },
      initializationOptions: {
        storageDir: this.storageDir,
        client: {
          hoverHtml: false,
          commands: [],
          ownFileWatcher: true,
          fileLinks: true,
        },
        settings: this.settings,
      },
      trace: "off",
    });
    this.serverInfo = result?.serverInfo || null;
    this.capabilities = result?.capabilities || {};
    await connection.sendNotification("initialized", {});
    this.initialized = true;
    if (!this.fileWatcher) {
      const modRoots = [
        ...new Set(
          [
            this.settings.modPath,
            ...(this.settings.workspaceMods || []),
            ...(this.settings.parentPaths || []),
          ].filter(Boolean)
        ),
      ];
      this._watchRoots({
        roots: [...modRoots, this.settings.gamePath].filter(Boolean),
        modRoots,
        excludeDirectories: this.settings.indexExcludeDirectories || [],
      });
    }
    return this;
  }

  _log(source, message) {
    if (!message) return;
    this.logs.push({ time: new Date().toISOString(), source, message: String(message).slice(0, 4000) });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
  }

  async request(method, params = null) {
    await this.start();
    return this.connection.sendRequest(method, params);
  }

  async notify(method, params = null) {
    await this.start();
    return this.connection.sendNotification(method, params);
  }

  async openDocument(file, text) {
    await this.start();
    const abs = normalizeFsPath(file);
    const uri = fileUri(abs);
    const content = text === undefined || text === null ? await fs.readFile(abs, "utf8") : String(text);
    if (text === undefined || text === null) this.diskDocuments.add(uri);
    else this.diskDocuments.delete(uri);
    const currentVersion = this.documentVersions.get(uri);
    const version = (currentVersion || 0) + 1;
    if (!currentVersion) {
      await this.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(abs), version, text: content },
      });
    } else if (this.documentText.get(uri) !== content) {
      await this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
    this.documentVersions.set(uri, version);
    this.documentText.set(uri, content);
    return { file: abs, uri, text: content, version };
  }

  async closeDocument(file) {
    const uri = fileUri(file);
    if (!this.documentVersions.has(uri) || !this.connection) return;
    await this.connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
    this.documentVersions.delete(uri);
    this.documentText.delete(uri);
    this.diskDocuments.delete(uri);
    this.diagnostics.delete(uri);
  }

  async documentRequest(method, file, position, text, extra = {}) {
    const doc = await this.openDocument(file, text);
    return this.request(method, {
      textDocument: { uri: doc.uri },
      ...(position ? { position: { line: position.line, character: position.character } } : {}),
      ...extra,
    });
  }

  async getDiagnostics(file, text, timeoutMs = 2500) {
    const doc = await this.openDocument(file, text);
    const current = this.diagnostics.get(doc.uri);
    if (current) return current;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.diagnostics.get(doc.uri) || []), timeoutMs);
      const waiters = this.diagnosticWaiters.get(doc.uri) || [];
      waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.diagnosticWaiters.set(doc.uri, waiters);
    });
  }

  async status() {
    await this.start();
    let stats = null;
    try {
      stats = await this.request("paradox/indexStats", null);
    } catch (error) {
      this._log("status", compactError(error));
    }
    return {
      runtimeBuild: `runtime-ts7-${require("../package.json").version}`,
      running: Boolean(this.child && this.initialized),
      pid: this.child?.pid || null,
      serverInfo: this.serverInfo,
      status: this.lastStatus,
      stats,
      settings: this.settings,
      recentLogs: this.logs.slice(-30),
    };
  }

  async waitForIndex({ timeoutMs = 120000, minimumDefinitions = 1 } = {}) {
    await this.start();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = this.lastStatus;
      const definitions = Number(status?.definitions || status?.definitionCount || 0);
      if (status && status.indexing === false && definitions >= minimumDefinitions) return status;
      await new Promise((resolve) => {
        const timer = setTimeout(
          () => {
            this.statusWaiters.delete(done);
            resolve();
          },
          Math.min(1500, Math.max(10, deadline - Date.now()))
        );
        const done = () => {
          clearTimeout(timer);
          this.statusWaiters.delete(done);
          resolve();
        };
        this.statusWaiters.add(done);
      });
    }
    throw new Error(`px-lsp index did not become ready within ${timeoutMs}ms`);
  }

  _watchRoots(payload) {
    const signature = JSON.stringify(payload);
    if (this.watchSignature === signature) return;
    this.fileWatcher?.close();
    this.watchSignature = signature;
    const watcher = new FileWatcher(
      async (file) => {
        if (!this.connection) return;
        const key = fileUri(file).toLowerCase();
        const uri = [...this.diskDocuments].find((value) => value.toLowerCase() === key);
        // 外部修改已打开的磁盘文档时，同步文本，避免服务端优先读取旧缓冲区。
        if (uri) {
          try {
            await this.openDocument(fsPathFromUri(uri));
          } catch (error) {
            if (error.code === "ENOENT") await this.closeDocument(fsPathFromUri(uri));
            else throw error;
          }
        }
        await this.connection?.sendNotification("paradox/modFileChanged", { fsPath: file });
      },
      (error) => this._log("watcher:error", compactError(error))
    );
    this.fileWatcher = watcher;
    watcher.start(payload.roots, payload.modRoots, payload.excludeDirectories || []);
    this._log("watcher", `watching ${watcher.handles.length} roots`);
  }

  async stop() {
    this.fileWatcher?.close();
    this.fileWatcher = null;
    this.watchSignature = null;
    this.documentVersions.clear();
    this.documentText.clear();
    this.diskDocuments.clear();
    this.diagnostics.clear();
    const connection = this.connection;
    const child = this.child;
    this.connection = null;
    this.child = null;
    this.initialized = false;
    this.startPromise = null;
    if (connection) {
      try {
        await connection.sendRequest("shutdown", null);
      } catch {}
      try {
        await connection.sendNotification("exit", null);
      } catch {}
      try {
        connection.dispose();
      } catch {}
    }
    if (child && !child.killed) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

module.exports = {
  DEFAULTS,
  PxLspClient,
  fileUri,
  fsPathFromUri,
  normalizeFsPath,
};
