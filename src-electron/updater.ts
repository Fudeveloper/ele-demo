import { app, BrowserWindow, ipcMain } from "electron";
import electronUpdater from "electron-updater";

// electron-updater 是 CommonJS 模块，需通过默认导入解构
const { autoUpdater } = electronUpdater;

/** 检查更新的返回结果 */
export interface CheckResult {
  available: boolean;
  reason?: "dev" | "no-update" | "ok" | undefined;
  version?: string | undefined;
}

/** 当前主窗口引用，供事件转发使用 */
let currentWindow: BrowserWindow | null = null;

/**
 * 触发一次更新检查。
 * - 开发环境直接返回 dev 状态
 * - 打包环境调用 autoUpdater.checkForUpdates()
 */
export async function checkForUpdates(): Promise<CheckResult> {
  if (!app.isPackaged) {
    return { available: false, reason: "dev" };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const available = !!result?.updateInfo;
    return {
      available,
      reason: available ? "ok" : "no-update",
      version: result?.updateInfo?.version
    };
  } catch (err) {
    currentWindow?.webContents.send("update:error", {
      message: err instanceof Error ? err.message : String(err)
    });
    return { available: false, reason: "no-update" };
  }
}

/**
 * 注册自动更新逻辑：
 * - 自动下载（autoDownload = true）
 * - 下载完成后转发事件到渲染进程，由 UI 提示用户重启安装
 * - 提供 updater:check / updater:quitAndInstall 两个 IPC
 *
 * 注意：electron-updater 只在打包后（app.isPackaged）生效，
 * 开发环境下 checkForUpdates 会直接返回 dev 状态，避免报错。
 */
export function registerUpdaterIpc(mainWindow: BrowserWindow) {
  currentWindow = mainWindow;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // ---------- 事件转发到渲染进程 ----------
  autoUpdater.on("checking-for-update", () => {
    mainWindow.webContents.send("update:checking");
  });

  autoUpdater.on("update-available", (info) => {
    mainWindow.webContents.send("update:available", {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    mainWindow.webContents.send("update:not-available", {
      version: info.version
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow.webContents.send("update:progress", {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    mainWindow.webContents.send("update:downloaded", {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate
    });
  });

  autoUpdater.on("error", (err) => {
    mainWindow.webContents.send("update:error", {
      message: err?.message ?? String(err)
    });
  });

  // ---------- IPC ----------
  ipcMain.handle("updater:check", (): Promise<CheckResult> => checkForUpdates());

  ipcMain.handle("updater:quitAndInstall", () => {
    autoUpdater.quitAndInstall();
  });
}
