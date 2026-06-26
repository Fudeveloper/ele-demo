/**
 * Add types (that are not auto-magically added by Quasar CLI already)
 * for your custom variables to avoid TypeScript errors, like dynamic
 * process.env variables or definitions in dotenv files configured ONLY
 * for the /quasar.config file itself.
 *
 * https://quasar.dev/quasar-cli-vite/handling-import-meta-env#type-inference
 *
 * @example
 * interface ImportMetaEnv {
 *   readonly MY_VAR: string;
 *   readonly MY_OTHER_VAR: string;
 * }
 */
interface ImportMetaEnv {}

/** 学生信息输入 */
interface StudentInput {
  studentNo: string;
  name: string;
  gender: string;
  age?: number | null;
  major?: string | null;
}

/** 学生信息（数据库记录） */
interface Student {
  id: number;
  studentNo: string;
  name: string;
  gender: string;
  age: number | null;
  major: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 渲染进程可用的学生 CRUD API（由 electron-preload 注入） */
interface StudentApi {
  list: (keyword?: string) => Promise<Student[]>;
  get: (id: number) => Promise<Student | undefined>;
  create: (data: StudentInput) => Promise<Student>;
  update: (id: number, data: StudentInput) => Promise<Student>;
  remove: (id: number) => Promise<{ success: boolean; id: number }>;
}

/** 更新检查结果（由 electron-preload 注入） */
interface UpdateCheckResult {
  available: boolean;
  reason?: "dev" | "no-update" | "ok";
  version?: string;
}

/** 更新已下载信息 */
interface UpdateDownloadedInfo {
  version: string;
  releaseNotes?: unknown;
  releaseDate?: string;
}

/** 自动更新 API（由 electron-preload 注入） */
interface UpdaterApi {
  check: () => Promise<UpdateCheckResult>;
  quitAndInstall: () => Promise<void>;
  onUpdateDownloaded: (cb: (info: UpdateDownloadedInfo) => void) => () => void;
}

interface Window {
  studentApi: StudentApi;
  updaterApi: UpdaterApi;
}
