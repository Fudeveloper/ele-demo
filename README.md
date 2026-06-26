# test-demo (quasar-demo)

## Install the dependencies

```bash
pnpm install
# or: yarn/npm/bun install
```

### Start the app in development mode (HMR, error reporting, etc.)

```bash
quasar dev
```

### Build the app for production

```bash
quasar build
```

### Customize the configuration

See [Configuring quasar.config.js](https://v2.quasar.dev/quasar-cli-vite/quasar-config-js).

## Electron + Drizzle ORM + better-sqlite3

学生信息 CRUD 示例已集成在 Electron 主进程中：

- 数据库：SQLite，运行时数据库文件位于 `app.getPath('userData')/app.db`
- ORM：Drizzle ORM + better-sqlite3
- Schema：`src-electron/db/schema.ts`
- IPC 处理：`src-electron/ipc/student.ts`（`student:list/get/create/update/delete`）
- 渲染进程通过 `window.studentApi` 调用（见 `src-electron/electron-preload.ts`）
- 前端页面：`src/pages/StudentsPage.vue`（侧边栏「学生管理」入口）

### 开发期同步表结构

在 `src-electron/` 下：

```bash
pnpm drizzle-kit push   # 将 schema 同步到 ./app.db（开发用库）
```

> 运行时库由主进程在 `userData` 目录自动创建并建表，无需手动 push。

### 开发模式启动

```bash
pnpm dev -m electron
```

### 生产打包注意事项

`better-sqlite3` 为原生模块，生产打包（`electron-packager` / `electron-builder`）时需要：

1. 针对 Electron 的 ABI 重新编译原生模块（如 `pnpm rebuild better-sqlite3` 配合 `@electron/rebuild`，设置 `npm_config_runtime=electron`、`npm_config_target=<electron版本>`）。
2. 将原生二进制从 asar 包中外部化（`buildResources` 中的 `asarUnpack` / packager 的 `--asar.unpack`，包含 `**/better-sqlite3/**`）。

## 自动更新（electron-updater + GitHub Releases）

应用启动后会在打包环境自动检查更新，下载完成后弹窗提示重启安装。工具栏「检查更新」按钮可手动触发。

### 架构

- 主进程：`src-electron/updater.ts`，封装 `electron-updater` 的 `autoUpdater`
  - `autoDownload = true`：发现新版本自动后台下载
  - 下载完成转发 `update:downloaded` 事件到渲染进程
  - 提供 IPC：`updater:check`、`updater:quitAndInstall`
  - **dev 环境下 no-op**（`app.isPackaged === false` 时直接返回 `reason: "dev"`）
- 打包器已切换为 `electron-builder`（`quasar.config.ts` 的 `electron.bundler`），因为它会生成 `latest.yml`，这是 auto-updater 检查更新所必需的。
- 发布源在 `quasar.config.ts` 的 `electron.builder.publish`，provider 为 `github`。

### 配置你的 GitHub 仓库（首次使用必做）

1. **替换 owner 占位符**：打开 `quasar.config.ts`，把
   `electron.builder.publish.owner` 中的 `<YOUR_GH_OWNER>` 改成你的 GitHub 用户名（`repo` 默认为 `quasar-demo`，如仓库名不同也一并修改）。
2. **创建并推送仓库**：
   ```bash
   # 在 GitHub 上 New repository，命名为 quasar-demo，不要勾选 init
   git remote add origin https://github.com/<YOUR_GH_OWNER>/quasar-demo.git
   git push -u origin master
   ```
3. **（可选）本地发布**：需要 `GH_TOKEN` 环境变量（classic PAT 需 `repo` 权限；fine-grained 需 Contents 读写权限）：
   ```powershell
   $env:GH_TOKEN=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
   pnpm build -m electron
   pnpm exec electron-builder --publish always
   ```
4. **CI 发布（推荐）**：项目已内置 `.github/workflows/release.yml`，打 tag 即可触发：
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
   workflow 使用内置的 `GITHUB_TOKEN`（无需额外配置 secret）即可把安装包 + `latest.yml` 发布到 Releases。

### 工作流程

1. 安装旧版本 → 启动后 3 秒自动 `checkForUpdates()`，或用户点击「检查更新」。
2. `electron-updater` 拉取 `<repo>/releases/latest/download/latest.yml`，比较版本。
3. 有新版本则自动下载，完成后渲染进程弹窗「立即重启 / 稍后」，确认后 `quitAndInstall()`。

### 注意事项

- **代码签名**：Windows 未签名安装包会触发 SmartScreen 警告，但 NSIS 自动更新功能本身不受影响。如需消除警告，请配置 `electron-builder` 的证书（`CSC_LINK` / `CSC_KEY_PASSWORD`），并在 `win` 中启用 signing。
- **版本号**：发布前记得更新 `package.json` 的 `version`，`electron-builder` 会用它生成 `latest.yml`，也是 auto-updater 的比较依据。
- **dev 环境**：auto-updater 只在 `app.isPackaged === true` 时工作，`pnpm dev -m electron` 下「检查更新」会提示「开发环境下不检查更新」。
