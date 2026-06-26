import { BrowserWindow, app } from "electron";
import path from "node:path";
import os from "node:os";
import {
  registerQuasarRuntime,
  resolveElectronAssetsPath
} from "#q-app/electron/main";
import { initDb } from "./db";
import { registerStudentIpc } from "./ipc/student";
import { registerUpdaterIpc, checkForUpdates } from "./updater";

// needed in case process is undefined under Linux
const platform = process.platform || os.platform();

async function createWindow() {
  /**
   * Initial window options
   */
  const mainWindow = new BrowserWindow({
    icon: resolveElectronAssetsPath("icons/icon.png"), // linux
    width: 1000,
    height: 600,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      // https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/electron-preload-script
      preload: path.join(import.meta.dirname, "electron-preload.cjs")
    }
  });

  if (import.meta.env.QUASAR_DEV) {
    await mainWindow.loadURL(import.meta.env.QUASAR_APP_URL);
  } else {
    await mainWindow.loadFile("index.html");
  }

  // 注册自动更新（必须在窗口创建后，事件转发需要 mainWindow）
  registerUpdaterIpc(mainWindow);

  if (import.meta.env.QUASAR_DEBUG) {
    // if on DEV or Production with debug enabled
    mainWindow.webContents.openDevTools();
  } else {
    // we're on production; no access to devtools pls
    mainWindow.webContents.on("devtools-opened", () => {
      mainWindow?.webContents.closeDevTools();
    });
  }
}

void app.whenReady().then(async () => {
  await registerQuasarRuntime();

  // 初始化数据库 & 注册 IPC（主进程）
  initDb();
  registerStudentIpc();

  void createWindow();

  // 打包环境启动 3 秒后自动检查更新（dev 下 no-op）
  if (app.isPackaged) {
    setTimeout(() => {
      void checkForUpdates();
    }, 3000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (platform !== "darwin") {
    app.quit();
  }
});
