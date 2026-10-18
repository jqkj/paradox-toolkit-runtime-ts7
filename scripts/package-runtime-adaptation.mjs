import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./server-package.mjs";

const version = JSON.parse(readFileSync(join(repoRoot, "packages/bridge/package.json"), "utf8")).version;
const name = `paradox-toolkit-${version}`;
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
