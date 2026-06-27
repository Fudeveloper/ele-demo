import { BrowserWindow, app, protocol, session } from "electron";
import path from "node:path";
import os from "node:os";
import {
  registerQuasarRuntime,
  resolveElectronAssetsPath
} from "#q-app/electron/main";
import { initDb, runStartupMaintenance } from "./db";
import { registerGigaIpc } from "./ipc/giga";
import { registerUpdaterIpc, checkForUpdates } from "./updater";
import { getConfig } from "./config";
import { startPriceInventoryTimer } from "./priceInventoryTimer";
import { registerFileProtocolSchemes, registerFileProtocol } from "./fileProtocol";
import { startStudioServer } from "./studio/studioServer";
import { GigaB2BApiError } from "./lib/gigab2b/exceptions";

// needed in case process is undefined under Linux
const platform = process.platform || os.platform();

async function createWindow() {
  /**
   * Initial window options
   */
  const mainWindow = new BrowserWindow({
    icon: resolveElectronAssetsPath("icons/icon.png"), // linux
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
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
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.webContents.on("devtools-opened", () => {
      mainWindow?.webContents.closeDevTools();
    });
  }
}

// 自定义协议方案必须在 app ready 前注册
registerFileProtocolSchemes();

void app.whenReady().then(async () => {
  await registerQuasarRuntime();

  // 初始化配置（加载 .env）
  try {
    getConfig();
  } catch (err) {
    console.error("[配置] 加载失败:", err);
  }

  // 初始化数据库 & 启动维护
  initDb();
  runStartupMaintenance();

  // 注册文件协议（modify-images / local-images 静态服务）
  registerFileProtocol();

  // 注册 GIGA 业务 IPC
  registerGigaIpc();

  // 启动 Studio 本地服务（图片工作台 + 反向代理）
  try {
    await startStudioServer();
  } catch (err) {
    console.warn("[工作台] 服务启动失败:", err);
  }

  // 启动价格/库存定时同步
  startPriceInventoryTimer();

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

void session;
void protocol;
void GigaB2BApiError;
