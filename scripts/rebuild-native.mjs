/**
 * 为 better-sqlite3 / sharp 下载/安装 Electron 运行时的预编译原生二进制。
 *
 * 运行环境（dev）下，原生模块会被从项目根 node_modules 解析
 * （因为 Quasar 把 electron 主进程输出到 .quasar/dev-electron/electron/），
 * 但 pnpm 默认下载的是 Node ABI 的二进制，在 Electron 里会因 ABI 不匹配加载失败。
 *
 * 本脚本调用 prebuild-install，直接下载与 Electron ABI 匹配的预编译二进制，
 * 无需本地 C++ 编译工具链。sharp 走其自带 install 脚本。
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
 * 在 pnpm 的 .pnpm 目录中定位指定包的真实目录。
 */
function findPkgDirs(pkgName) {
  const dirs = [];
  const pnpmDir = join(root, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return dirs;
  const prefix = `${pkgName}@`;
  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith(prefix)) continue;
    const pkgDir = join(pnpmDir, entry, "node_modules", pkgName);
    if (existsSync(join(pkgDir, "package.json"))) {
      dirs.push(pkgDir);
    }
  }
  // 兜底：根 node_modules
  const rootPkg = join(root, "node_modules", pkgName);
  if (existsSync(join(rootPkg, "package.json"))) dirs.push(rootPkg);
  return Array.from(new Set(dirs));
}

let failed = false;

// ---- better-sqlite3：prebuild-install ----
for (const dir of findPkgDirs("better-sqlite3")) {
  console.log(`[rebuild-native] better-sqlite3 @ ${dir}`);
  const buildDir = join(dir, "build");
  if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });

  const dirRequire = createRequire(join(dir, "package.json"));
  const rootRequire = createRequire(join(root, "package.json"));
  let prebuildBin;
  try {
    prebuildBin = dirRequire.resolve("prebuild-install/bin.js");
  } catch {
    try {
      prebuildBin = rootRequire.resolve("prebuild-install/bin.js");
    } catch {
      console.warn(`[rebuild-native] 未找到 prebuild-install（${dir}），跳过`);
      continue;
    }
  }
  const result = spawnSync(
    process.execPath,
    [prebuildBin, "-r", "electron", "-t", ELECTRON_VERSION, "--arch", ARCH, "--platform", process.platform],
    { cwd: dir, stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) {
    console.error(`[rebuild-native] better-sqlite3 失败: ${dir}`);
    failed = true;
  }
}

// ---- sharp：通过 npm install --build-from-source 或指定 runtime=electron ----
// sharp 自带针对 electron 的预构建；这里用其 install 脚本重新拉取 electron 版本。
for (const dir of findPkgDirs("sharp")) {
  console.log(`[rebuild-native] sharp @ ${dir}`);
  const result = spawnSync(
    process.execPath,
    [join(dir, "install", "lib", "index.js") || "install/lib/index.js", "||", "true"],
    {
      cwd: dir,
      stdio: "inherit",
      env: { ...process.env, npm_config_runtime: "electron", npm_config_target: ELECTRON_VERSION, npm_config_arch: ARCH },
    },
  );
  // sharp 安装脚本即使无网络也通常不致命；记录但不强制失败
  if (result.status !== 0) {
    console.warn(`[rebuild-native] sharp 重建非零退出（可能已具备兼容二进制），继续。`);
  }
}

if (failed) process.exit(1);
console.log("[rebuild-native] 完成");
