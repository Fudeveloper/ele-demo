/**
 * Electron preload —— 暴露主进程能力给渲染进程。
 */

import { contextBridge, ipcRenderer } from "electron";
import { quasarRuntime } from "#q-app/electron/preload";

/** 通用 IPC 调用封装。 */
function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

/**
 * GIGA 业务 API。对应原 Flask `/api/*` 路由，全部返回 `{success, message?, ...data}`。
 */
const gigaApi = {
  // 账号
  accountsList: () => invoke("accounts:list"),
  accountsCreate: (payload: Record<string, unknown>) => invoke("accounts:create", payload),
  accountsUpdate: (id: number, payload: Record<string, unknown>) => invoke("accounts:update", id, payload),
  accountsReplace: (id: number, payload: Record<string, unknown>) => invoke("accounts:replace", id, payload),
  accountsDelete: (id: number) => invoke("accounts:delete", id),
  accountsBatchDelete: (payload: { account_ids: number[] }) => invoke("accounts:batchDelete", payload),
  accountsTest: (id: number) => invoke("accounts:test", id),
  accountsImportCsv: (csvText: string) => invoke("accounts:importCsv", csvText),
  accountsSync: (id: number, payload: { full?: boolean }) => invoke("accounts:sync", id, payload),

  // 商品
  productsList: (params: Record<string, unknown>) => invoke("products:list", params),
  productsDelete: (id: number) => invoke("products:delete", id),
  productsBatchDelete: (payload: { product_ids: number[] }) => invoke("products:batchDelete", payload),
  productsUpdateFlags: (id: number, payload: Record<string, unknown>) => invoke("products:updateFlags", id, payload),
  productsBatchFlags: (payload: { product_ids: number[] } & Record<string, unknown>) => invoke("products:batchFlags", payload),
  productsManualSync: (payload: { account_ids: number[]; input_type: string; values: string }) => invoke("products:manualSync", payload),
  productsFullSync: (payload: { account_ids: number[]; full?: boolean }) => invoke("products:fullSync", payload),
  productsBatchPriceInventorySync: (payload: { product_ids: number[] }) => invoke("products:batchPriceInventorySync", payload),
  productsBatchSkuInfoSync: (payload: { product_ids: number[] }) => invoke("products:batchSkuInfoSync", payload),
  productsGetImages: (id: number) => invoke("products:getImages", id),
  productsUploadLocalImages: (payload: { account_id: number; item_code: string; product_name: string; files: { name: string; data: ArrayBuffer }[] }) => invoke("products:uploadLocalImages", payload),

  // 收藏
  favoritesCancelAll: (payload: { account_ids: number[] }) => invoke("favorites:cancelAll", payload),

  // 图片
  imagesGenerate: (payload: { product_ids: number[]; flip_source?: boolean }) => invoke("images:generate", payload),
  imagesRegenerate: (payload: { product_ids: number[] }) => invoke("images:regenerate", payload),
  productsRegenerateImages: (id: number, payload: { indices: number[] }) => invoke("products:regenerateImages", id, payload),
  productsApproveImage: (id: number, payload: { index: number; selected_path?: string }) => invoke("products:approveImage", id, payload),
  productsRejectImage: (id: number, payload: { index: number; selected_path?: string }) => invoke("products:rejectImage", id, payload),

  // WPS
  productsWpsSync: (id: number) => invoke("products:wpsSync", id),
  productsBatchWpsSync: (payload: { product_ids: number[] }) => invoke("products:batchWpsSync", payload),

  // 任务
  jobsList: () => invoke("jobs:list"),
  jobsGet: (id: number) => invoke("jobs:get", id),

  // 文件代理
  fileUrl: (path: string) => `app://giga-files/${path}`,
  /** 打开 Amazon Image Studio 窗口。 */
  openStudio: () => invoke("studio:open"),
};

/** 自动更新 API（沿用原项目）。 */
const updaterApi = {
  check: (): Promise<unknown> => ipcRenderer.invoke("updater:check"),
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke("updater:quitAndInstall"),
  onUpdateDownloaded: (cb: (info: unknown) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, info: unknown): void => cb(info);
    ipcRenderer.on("update:downloaded", handler);
    return () => ipcRenderer.removeListener("update:downloaded", handler);
  },
};

contextBridge.exposeInMainWorld("quasarRuntime", quasarRuntime);
contextBridge.exposeInMainWorld("gigaApi", gigaApi);
contextBridge.exposeInMainWorld("updaterApi", updaterApi);
