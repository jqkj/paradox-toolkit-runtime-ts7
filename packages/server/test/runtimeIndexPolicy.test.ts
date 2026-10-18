import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TokenFilter } from "../src/index/tokenFilter";
import { createIndexPathPolicy } from "../src/index/pathPolicy";
import { LazyReferenceScanner } from "../src/index/lazyRefs";
import { iterFilesInRoots } from "@px-lsp/protocol/fsWalk";
import { readSettings } from "../src/settings";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "px-runtime-"));
  temporary.push(dir);
  return dir;
}
function write(root: string, relative: string, content: string) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe("runtime index freshness", () => {
  it("preserves every exact token and falls back when the memory budget is exhausted", () => {
    for (const budget of [0, 4096]) {
      const filter = new TokenFilter(budget);
      const words = ["probe.123.t", "probe-trait", "Probe_Case", "probe_scope", "new_target"];
      filter.add("f", words.join(" = \n"));
      for (const word of words) expect(filter.mayContain("f", word)).toBe(true);
      filter.invalidate("f");
      expect(filter.mayContain("f", "unseen_target")).toBe(true);
    }
  });

  it("forgets negative filters on file updates and a same-root rebuild", async () => {
    const root = fixture();
    const file = write(root, "common/scripted_effects/calls.txt", "call = { add_gold = 1 }");
    const scanner = new LazyReferenceScanner();
    const roots = [{ root, source: "parent" as const }];
    scanner.setRoots(roots);
    expect(await scanner.lookup("new_target_trigger")).toHaveLength(0);
    fs.writeFileSync(file, "call = {\n if = { limit = { new_target_trigger = yes } }\n}");
    scanner.invalidateFile(file.replaceAll("\\", "/"));
    expect(await scanner.lookup("new_target_trigger")).toHaveLength(1);
    fs.writeFileSync(file, "call = {\n if = { limit = { second_target_trigger = yes } }\n}");
    scanner.setRoots(roots);
    expect(await scanner.lookup("new_target_trigger")).toHaveLength(0);
    expect(await scanner.lookup("second_target_trigger")).toHaveLength(1);
  });

  it("restarts an in-flight lookup when a file changes between batches", async () => {
    const root = fixture();
    for (let i = 0; i < 205; i++) write(root, `common/scripted_effects/${i}.txt`, "call = { add_gold = 1 }");
    const scanner = new LazyReferenceScanner();
    scanner.setRoots([{ root, source: "parent" }]);
    const pending = scanner.lookup("race_target_trigger");
    const file = write(
      root,
      "common/scripted_effects/0.txt",
      "call = {\n if = { limit = { race_target_trigger = yes } }\n}"
    );
    scanner.invalidateFile(file);
    expect(await pending).toHaveLength(1);
    expect(await scanner.lookup("race_target_trigger")).toHaveLength(1);
  });

  it("uses root boundaries, prunes excluded roots, and keeps custom runtime directories", () => {
    const root = fixture();
    const excluded = write(root, "test/copy.txt", "a = b");
    const retained = write(root, "custom_runtime/calls.txt", "a = b");
    const policy = createIndexPathPolicy([root], ["test"]);
    expect(policy(excluded)).toBe(false);
    expect(policy(path.join(root + "-other", "test", "calls.txt"))).toBe(true);
    expect([...iterFilesInRoots([path.join(root, "test"), root], ".txt", policy)].filter(Boolean)).toEqual([
      retained,
    ]);
    const nested = createIndexPathPolicy([root, path.join(root, "test")], ["test"]);
    expect(nested(excluded)).toBe(true);
    expect(readSettings({ indexExcludeDirectories: ["../common"] })).toBeUndefined();
    expect(readSettings({ indexExcludeDirectories: ["test"] })).toEqual({
      indexExcludeDirectories: ["test"],
    });
  });
});
