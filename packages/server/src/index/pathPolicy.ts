import * as path from "path";

/** 统一初次扫描与增量更新的目录边界；仅排除模组根下明确配置的目录。 */
export function createIndexPathPolicy(roots: string[], excluded: string[]): (file: string) => boolean {
  const normalize = (file: string) => {
    const resolved = path.resolve(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const ordered = [...new Set(roots.map(normalize))].sort((a, b) => b.length - a.length);
  const names = new Set(excluded.map((name) => (process.platform === "win32" ? name.toLowerCase() : name)));
  return (file) => {
    const normalized = normalize(file);
    for (const root of ordered) {
      const relative = path.relative(root, normalized);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
      return !names.has(relative.split(path.sep)[0]);
    }
    return true;
  };
}
