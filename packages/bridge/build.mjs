import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { stageServerPayload, repoRoot } from "../../scripts/server-package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+-runtime\.\d+$/.test(version)) throw new Error("Invalid adaptation version");
if (JSON.parse(readFileSync(join(here, "manifest.json"), "utf8")).version !== version) {
  throw new Error("PI manifest and bridge versions must agree");
}
const output = join(here, "dist", `paradox-toolkit-${version}`);
// 清理只限构建目录中的当前版本，防止旧产物混入发行件。
if (!resolve(output).startsWith(resolve(here, "dist") + sep)) throw new Error("Unsafe build path");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
// 运行时必须来自当前仓库的修复源码，不能被 npm 上游版本覆盖。
await build({
  entryPoints: [join(repoRoot, "packages/server/src/server.ts")],
  outfile: join(repoRoot, "packages/server/dist/server.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
});
stageServerPayload(join(output, "vendor/px-lsp"));
for (const [input, name] of [
  ["mcp-server.js", "mcp-server.cjs"],
  ["pi-main.js", "main.js"],
]) {
  await build({
    entryPoints: [join(here, "src", input)],
    outfile: join(output, name),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
  });
}
for (const name of ["manifest.json", "views", "README.md"]) {
  cpSync(join(here, name), join(output, name), { recursive: true });
}
for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.md"]) {
  cpSync(join(repoRoot, name), join(output, name));
}
const files = ["mcp-server.cjs", "main.js", "vendor/px-lsp/dist/server.js"];
const manifest = {
  build: `runtime-ts7-${version}`,
  upstreamCommit: "4a3e210a74d40af91907f52753dd118f8fe8c3ea",
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
  sourceDirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim()
  ),
  serverVersion: "0.3.8",
  files: Object.fromEntries(
    files.map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(join(output, name)))
        .digest("hex"),
    ])
  ),
};
writeFileSync(join(output, "runtime-build.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Built ${output}`);
