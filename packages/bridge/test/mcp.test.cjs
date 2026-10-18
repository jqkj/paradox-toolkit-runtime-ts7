const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { version } = require("../package.json");

test(
  "shipped MCP supports config, references and external create/edit/delete with exclusions",
  { timeout: 60000 },
  async () => {
    // 只用临时夹具验证发行件，CI 不需要游戏或私人模组。
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "px-bridge-smoke-"));
    const mod = path.join(temp, "mod");
    const def = path.join(mod, "common/scripted_triggers/def.txt");
    const caller = path.join(mod, "common/scripted_effects/caller.txt");
    const ignored = path.join(mod, "test/copy.txt");
    const body = "caller = { if = { limit = { fixture_trigger = yes } } }\n";
    function write(file, content) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "\uFEFF" + content);
    }
    write(def, "fixture_trigger = { always = yes }\n");
    write(caller, body);
    write(ignored, body);
    const root =
      process.env.PX_BRIDGE_PAYLOAD || path.resolve(__dirname, `../dist/paradox-toolkit-${version}`);
    const client = new Client({ name: "release-smoke", version }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "mcp-server.cjs")],
      stderr: "pipe",
      env: {
        ...process.env,
        PX_GAME_PATH: "",
        PX_LOGS_PATH: "",
        PX_MOD_PATH: mod,
        PX_STORAGE_DIR: path.join(temp, "cache"),
        PX_INDEX_EXCLUDE_DIRECTORIES: '["test"]',
      },
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let phase = "connect";
    async function call(name, args = {}) {
      phase = name;
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content.find((item) => item.type === "text").text);
    }
    async function expectRefs(count) {
      const until = Date.now() + 10000;
      let result;
      do {
        result = await call("px_references", { file: def, line: 0, character: 5, includeDeclaration: false });
        if (result.length === count) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < until);
      assert.equal(result.length, count);
    }
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 23);
      await call("px_wait_for_index", { timeoutMs: 30000 });
      assert.equal((await call("px_status")).runtimeBuild, `runtime-ts7-${version}`);
      await expectRefs(1);
      write(caller, "caller = { add_gold = 1 }\n");
      await expectRefs(0);
      write(caller, body);
      await expectRefs(1);
      const created = path.join(mod, "custom/new.txt");
      write(created, body);
      await expectRefs(2);
      fs.unlinkSync(created);
      await expectRefs(1);
      await call("px_symbols", { file: ignored });
      await expectRefs(1);
      await call("px_configure", { settings: { indexExcludeDirectories: [] } });
      await expectRefs(2);
      const status = await call("px_status");
      assert.deepEqual(
        status.recentLogs.filter((item) => item.source === "watcher:error"),
        []
      );
      assert.equal(stderr, "");
    } catch (error) {
      throw new Error(`MCP failed during ${phase}; stderr: ${stderr || "(empty)"}`, { cause: error });
    } finally {
      await client.close();
      // 清理范围由 mkdtemp 返回，且先验证它仍属于系统临时目录。
      assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
);
