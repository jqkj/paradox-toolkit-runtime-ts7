import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./server-package.mjs";

const version = JSON.parse(readFileSync(join(repoRoot, "packages/bridge/package.json"), "utf8")).version;
const name = `paradox-toolkit-${version}`;
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const built = JSON.parse(
  readFileSync(join(repoRoot, "packages/bridge/dist", name, "runtime-build.json"), "utf8")
);
if (built.sourceCommit !== commit || built.sourceDirty !== false) {
  throw new Error("Rebuild the runtime from the current clean commit before packaging.");
}
const output = join(repoRoot, "dist/runtime-release");
mkdirSync(output, { recursive: true });
// 运行件与对应提交源码一起分发；不把开发目录和个人缓存装进包。
const zip = new AdmZip();
zip.addLocalFolder(join(repoRoot, "packages/bridge/dist", name), name);
const archive = join(output, `${name}-${process.platform}.zip`);
zip.writeZip(archive);
const source = join(output, `${name}-source.zip`);
if (execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim()) {
  throw new Error("Source archive requires a clean committed tree; commit the reviewed changes first.");
}
execFileSync("git", ["archive", "--format=zip", `--output=${source}`, "HEAD"], { cwd: repoRoot });
const sourceZip = new AdmZip(source);
sourceZip.addFile(
  "runtime-source.json",
  Buffer.from(
    JSON.stringify(
      {
        sourceCommit: commit,
        version,
      },
      null,
      2
    ) + "\n"
  )
);
// ZIP 记录日历字段；固定元数据时间，使同一平台重复打包的源码校验和稳定。
sourceZip.getEntry("runtime-source.json").header.time = new Date(2000, 0, 1);
sourceZip.writeZip(source);
const files = [archive, source];
writeFileSync(
  join(output, `SHA256SUMS-${process.platform}.txt`),
  files
    .map(
      (file) =>
        `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${file.slice(output.length + 1)}`
    )
    .join("\n") + "\n"
);
console.log(`Release artifacts: ${output}`);
