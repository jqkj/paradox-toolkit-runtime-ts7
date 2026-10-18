import AdmZip from "adm-zip";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { repoRoot } from "./server-package.mjs";

const version = JSON.parse(readFileSync(join(repoRoot, "packages/bridge/package.json"), "utf8")).version;
const name = `paradox-toolkit-${version}`;
const temp = mkdtempSync(join(tmpdir(), "px-release-zip-"));
if (!resolve(temp).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup path");
try {
  // 从 ZIP 解压后的目录启动，避免构建目录中的额外文件掩盖漏打包。
  new AdmZip(join(repoRoot, "dist/runtime-release", `${name}-${process.platform}.zip`)).extractAllTo(temp);
  execFileSync(process.execPath, ["--test", "packages/bridge/test/mcp.test.cjs"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, PX_BRIDGE_PAYLOAD: join(temp, name) },
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
