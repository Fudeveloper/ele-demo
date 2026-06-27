/**
 * 全局类型声明：window.gigaApi / window.updaterApi。
 */

export interface ApiResult<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  [key: string]: unknown;
}

export interface GigaApi {
  accountsList: () => Promise<ApiResult>;
  accountsCreate: (payload: Record<string, unknown>) => Promise<ApiResult>;
  accountsUpdate: (id: number, payload: Record<string, unknown>) => Promise<ApiResult>;
  accountsReplace: (id: number, payload: Record<string, unknown>) => Promise<ApiResult>;
  accountsDelete: (id: number) => Promise<ApiResult>;
  accountsBatchDelete: (payload: { account_ids: number[] }) => Promise<ApiResult>;
  accountsTest: (id: number) => Promise<ApiResult>;
  accountsImportCsv: (csvText: string) => Promise<ApiResult>;
  accountsSync: (id: number, payload: { full?: boolean }) => Promise<ApiResult>;

  productsList: (params: Record<string, unknown>) => Promise<ApiResult>;
  productsDelete: (id: number) => Promise<ApiResult>;
  productsBatchDelete: (payload: { product_ids: number[] }) => Promise<ApiResult>;
  productsUpdateFlags: (id: number, payload: Record<string, unknown>) => Promise<ApiResult>;
  productsBatchFlags: (payload: { product_ids: number[] } & Record<string, unknown>) => Promise<ApiResult>;
  productsManualSync: (payload: { account_ids: number[]; input_type: string; values: string }) => Promise<ApiResult>;
  productsFullSync: (payload: { account_ids: number[]; full?: boolean }) => Promise<ApiResult>;
  productsBatchPriceInventorySync: (payload: { product_ids: number[] }) => Promise<ApiResult>;
  productsBatchSkuInfoSync: (payload: { product_ids: number[] }) => Promise<ApiResult>;
  productsGetImages: (id: number) => Promise<ApiResult>;
  productsUploadLocalImages: (payload: {
    account_id: number;
    item_code: string;
    product_name: string;
    files: { name: string; data: ArrayBuffer }[];
  }) => Promise<ApiResult>;

  favoritesCancelAll: (payload: { account_ids: number[] }) => Promise<ApiResult>;

  imagesGenerate: (payload: { product_ids: number[]; flip_source?: boolean }) => Promise<ApiResult>;
  imagesRegenerate: (payload: { product_ids: number[] }) => Promise<ApiResult>;
  productsRegenerateImages: (id: number, payload: { indices: number[] }) => Promise<ApiResult>;
  productsApproveImage: (id: number, payload: { index: number; selected_path?: string | undefined }) => Promise<ApiResult>;
  productsRejectImage: (id: number, payload: { index: number; selected_path?: string | undefined }) => Promise<ApiResult>;

  productsWpsSync: (id: number) => Promise<ApiResult>;
  productsBatchWpsSync: (payload: { product_ids: number[] }) => Promise<ApiResult>;

  jobsList: () => Promise<ApiResult>;
  jobsGet: (id: number) => Promise<ApiResult>;

  fileUrl: (path: string) => string;
  openStudio: () => Promise<ApiResult>;
}

declare global {
  interface Window {
    gigaApi?: GigaApi;
    updaterApi?: {
      check: () => Promise<{ available: boolean; reason?: string; version?: string }>;
      quitAndInstall: () => Promise<void>;
      onUpdateDownloaded: (cb: (info: { version: string }) => void) => () => void;
    };
  }
}

export {};
