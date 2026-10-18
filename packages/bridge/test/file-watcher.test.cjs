const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { FileWatcher } = require("../src/file-watcher");
test("directory noise is ignored; real file changes, same-size writes and deletions notify", async () => {
  const base = path.resolve(require("node:os").tmpdir(), "px-watcher-fixtures");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "case-")),
    file = path.join(root, "calls.txt"),
    changes = [],
    errors = [];
  fs.writeFileSync(file, "first");
  const before = fs.statSync(file);
  const watcher = new FileWatcher(
    async (f) => changes.push(f),
    (e) => errors.push(String(e))
  );
  try {
    watcher.start([root], [root], []);
    await watcher.changed(root, root, new Set());
    await watcher.changed(file, root, new Set());
    assert.equal(changes.length, 0);
    fs.writeFileSync(file, "other");
    fs.utimesSync(file, before.atime, before.mtime);
    await watcher.changed(root, root, new Set());
    assert.deepEqual(changes, [file]);
    await watcher.changed(root, root, new Set());
    assert.equal(changes.length, 1);
    fs.unlinkSync(file);
    await watcher.changed(root, root, new Set());
    assert.deepEqual(changes, [file, file]);
    await watcher.changed(root, root, new Set());
    assert.equal(changes.length, 2);
    assert.deepEqual(errors, []);
  } finally {
    watcher.close();
    assert.ok(path.resolve(root).startsWith(base + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watching an aliased root preserves logical paths for index notifications", async () => {
  const base = path.resolve(require("node:os").tmpdir());
  const temp = fs.mkdtempSync(path.join(base, "px-watch-alias-"));
  const real = path.join(temp, "physical long directory");
  const alias = path.join(temp, "alias");
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  const physicalFile = path.join(real, "calls.txt");
  const logicalFile = path.join(alias, "calls.txt");
  fs.writeFileSync(physicalFile, "before");
  const changes = [],
    errors = [];
  const watcher = new FileWatcher(
    async (file) => {
      changes.push(file);
    },
    (error) => {
      errors.push(String(error));
    }
  );
  try {
    watcher.start([alias], [alias], []);
    fs.writeFileSync(physicalFile, "after");
    const deadline = Date.now() + 5000;
    while (!changes.length && !errors.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(changes, [logicalFile]);
  } finally {
    watcher.close();
    assert.ok(path.resolve(temp).startsWith(base + path.sep));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
