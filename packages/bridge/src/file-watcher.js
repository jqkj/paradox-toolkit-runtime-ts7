"use strict";
const fs = require("node:fs");
const path = require("node:path");

// 监听真实文件系统；目录改名/删除时，补发其下已知文件的变化通知。
class FileWatcher {
  constructor(onChange, onError) {
    this.onChange = onChange;
    this.onError = onError;
    this.handles = [];
    this.files = new Map();
    this.stamps = new Map();
    this.pending = new Map();
    this.serial = Promise.resolve();
    this.closed = false;
  }
  key(file) {
    return process.platform === "win32" ? file.toLowerCase() : file;
  }
  below(root, file) {
    const rel = path.relative(root, file);
    return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  }
  relevant(file) {
    return /\.(txt|gui|yml|yaml|asset|mod|json|info)$/i.test(file);
  }
  stamp(file) {
    try {
      const stat = fs.statSync(file, { bigint: true });
      return stat.isFile() ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : null;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") this.onError(error);
      return null;
    }
  }
  async notifyChanged(file) {
    const key = this.key(file),
      before = this.stamps.get(key) ?? null,
      after = this.stamp(file);
    // 目录元数据事件可能覆盖整棵子树；读文件/重复通知不应不断使查询失效。
    if (before === after) return;
    if (after === null) {
      this.files.delete(key);
      this.stamps.delete(key);
    } else {
      this.files.set(key, file);
      this.stamps.set(key, after);
    }
    await this.onChange(file);
  }
  allowed(root, file, excluded) {
    const rel = path.relative(root, file);
    if (!this.below(root, file)) return false;
    const parts = rel.split(path.sep);
    if (excluded.has(this.key(parts[0]))) return false;
    return parts.every(
      (p) => !p.startsWith(".") || [".px-toolkit", ".ck3modding", ".vic3modding", ".eu5modding"].includes(p)
    );
  }
  scan(dir, root, excluded, out) {
    if (!this.allowed(root, dir, excluded)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") this.onError(error);
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (!this.allowed(root, file, excluded)) continue;
      if (entry.isDirectory()) this.scan(file, root, excluded, out);
      else if (entry.isFile() && this.relevant(file)) out.set(this.key(file), file);
    }
  }
  start(roots, modRoots, excludeDirectories) {
    const modSet = new Set(modRoots.map((r) => this.key(path.resolve(r))));
    for (const root of [...new Set(roots.filter(Boolean).map((r) => path.resolve(r)))]) {
      const excluded = new Set(modSet.has(this.key(root)) ? excludeDirectories.map((n) => this.key(n)) : []);
      try {
        const handle = fs.watch(root, { recursive: true }, (_event, name) => {
          if (this.closed) return;
          const file = name ? path.resolve(root, String(name)) : root;
          if (!this.allowed(root, file, excluded)) return;
          const key = this.key(file);
          clearTimeout(this.pending.get(key));
          this.pending.set(
            key,
            setTimeout(() => {
              this.pending.delete(key);
              this.serial = this.serial.then(() => this.changed(file, root, excluded)).catch(this.onError);
            }, 60)
          );
        });
        handle.on("error", this.onError);
        this.handles.push(handle);
        this.scan(root, root, excluded, this.files);
        for (const [key, file] of this.files) {
          if (!this.stamps.has(key)) this.stamps.set(key, this.stamp(file));
        }
      } catch (error) {
        this.onError(error);
      }
    }
  }
  async changed(file, root, excluded) {
    if (this.closed) return;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") this.onError(error);
    }
    if (stat?.isFile() || this.files.has(this.key(file)) || this.relevant(file)) {
      if (!this.relevant(file)) return;
      await this.notifyChanged(file);
      return;
    }
    const changed = new Map([...this.files].filter(([, known]) => this.below(file, known)));
    if (stat?.isDirectory()) this.scan(file, root, excluded, changed);
    for (const known of changed.values()) {
      if (this.closed) return;
      await this.notifyChanged(known);
    }
  }
  close() {
    this.closed = true;
    for (const handle of this.handles) handle.close();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.handles = [];
    this.pending.clear();
    this.files.clear();
    this.stamps.clear();
  }
}
module.exports = { FileWatcher };
