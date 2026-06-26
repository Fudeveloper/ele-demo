/**
 * 为 better-sqlite3 下载/安装 Electron 运行时的预编译原生二进制。
 *
 * 运行环境（dev）下，better-sqlite3 会被从项目根 node_modules 解析
 * （因为 Quasar 把 electron 主进程输出到 .quasar/dev-electron/electron/），
 * 但 pnpm 默认下载的是 Node ABI 的二进制，在 Electron 里会因 ABI 不匹配加载失败。
 *
 * 本脚本调用 better-sqlite3 自带的 prebuild-install，直接下载与 Electron
 * ABI 匹配的预编译二进制，无需本地 C++ 编译工具链。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");

// Electron 版本（写死；升级 Electron 时同步修改）
const ELECTRON_VERSION = "42.5.0";
const ARCH = process.arch;

/**
 * 在 pnpm 的 .pnpm 目录中定位 better-sqlite3 的真实包目录。
 */
function findBetterSqlite3Dirs() {
  const dirs = [];
  const pnpmDir = join(root, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return dirs;
  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith("better-sqlite3@")) continue;
    const pkgDir = join(pnpmDir, entry, "node_modules", "better-sqlite3");
    if (existsSync(join(pkgDir, "package.json"))) {
      dirs.push(pkgDir);
    }
  }
  return dirs;
}

const targets = findBetterSqlite3Dirs();
if (targets.length === 0) {
  console.warn("[rebuild-native] 未找到 better-sqlite3 包目录，跳过。");
  process.exit(0);
}

let failed = false;
for (const dir of targets) {
  console.log(`[rebuild-native] 处理 ${dir}`);
  // 删除旧 build 产物，强制重新下载
  const buildDir = join(dir, "build");
  if (existsSync(buildDir)) {
    rmSync(buildDir, { recursive: true, force: true });
  }

  // prebuild-install 解析包路径时以 cwd 为基准，需在 better-sqlite3 目录运行。
  // 通过 createRequire 从该目录解析 prebuild-install，兼容 pnpm 的嵌套布局。
  const dirRequire = createRequire(join(dir, "package.json"));
  let prebuildBin;
  try {
    prebuildBin = dirRequire.resolve("prebuild-install/bin.js");
  } catch {
    console.error(`[rebuild-native] 未找到 prebuild-install（${dir}）`);
    failed = true;
    continue;
  }
  const result = spawnSync(
    process.execPath,
    [
      prebuildBin,
      "-r",
      "electron",
      "-t",
      ELECTRON_VERSION,
      "--arch",
      ARCH,
      "--platform",
      process.platform
    ],
    {
      cwd: dir,
      stdio: "inherit",
      env: process.env
    }
  );

  if (result.status !== 0) {
    console.error(`[rebuild-native] 失败: ${dir}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("[rebuild-native] 完成");
