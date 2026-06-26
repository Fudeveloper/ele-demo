/**
 * This file is used specifically for security reasons.
 * Here you can access Nodejs stuff and inject functionality into
 * the renderer thread (accessible there through the "window" object)
 *
 * WARNING!
 * If you import anything from node_modules, then make sure that the package is specified
 * in /src-electron/package.json > dependencies and NOT in devDependencies
 *
 * Example (injects window.myAPI.doAThing() into renderer thread):
 *
 *   import { contextBridge } from 'electron'
 *
 *   contextBridge.exposeInMainWorld('myAPI', {
 *     doAThing: () => {}
 *   })
 *
 * WARNING!
 * If accessing Node functionality (like importing @electron/remote) then in your
 * electron-main.ts you will need to set the following when you instantiate BrowserWindow:
 *
 * mainWindow = new BrowserWindow({
 *   // ...
 *   webPreferences: {
 *     // ...
 *     sandbox: false // <-- to be able to import @electron/remote in preload script
 *   }
 * }
 */

import { contextBridge, ipcRenderer } from "electron";
import { quasarRuntime } from "#q-app/electron/preload";

/** 学生信息输入 */
export interface StudentInput {
  studentNo: string;
  name: string;
  gender: string;
  age?: number | null;
  major?: string | null;
}

/** 学生信息（数据库记录） */
export interface Student {
  id: number;
  studentNo: string;
  name: string;
  gender: string;
  age: number | null;
  major: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 更新检查结果 */
export interface UpdateCheckResult {
  available: boolean;
  reason?: "dev" | "no-update" | "ok";
  version?: string;
}

/** 更新已下载的信息 */
export interface UpdateDownloadedInfo {
  version: string;
  releaseNotes?: unknown;
  releaseDate?: string;
}

const studentApi = {
  list: (keyword?: string): Promise<Student[]> =>
    ipcRenderer.invoke("student:list", keyword),
  get: (id: number): Promise<Student | undefined> =>
    ipcRenderer.invoke("student:get", id),
  create: (data: StudentInput): Promise<Student> =>
    ipcRenderer.invoke("student:create", data),
  update: (id: number, data: StudentInput): Promise<Student> =>
    ipcRenderer.invoke("student:update", id, data),
  remove: (id: number): Promise<{ success: boolean; id: number }> =>
    ipcRenderer.invoke("student:delete", id)
};

const updaterApi = {
  /** 手动检查更新 */
  check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke("updater:check"),
  /** 退出并安装已下载的更新 */
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke("updater:quitAndInstall"),
  /** 监听「更新已下载」事件，返回取消监听的函数 */
  onUpdateDownloaded: (
    cb: (info: UpdateDownloadedInfo) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      info: UpdateDownloadedInfo
    ): void => cb(info);
    ipcRenderer.on("update:downloaded", handler);
    return () => ipcRenderer.removeListener("update:downloaded", handler);
  }
};

/**
 * Can be used in the renderer process through `window.quasarRuntime`
 */
contextBridge.exposeInMainWorld("quasarRuntime", quasarRuntime);

/**
 * 学生信息 CRUD API，渲染进程可通过 `window.studentApi` 访问
 */
contextBridge.exposeInMainWorld("studentApi", studentApi);

/**
 * 自动更新 API，渲染进程可通过 `window.updaterApi` 访问
 */
contextBridge.exposeInMainWorld("updaterApi", updaterApi);
