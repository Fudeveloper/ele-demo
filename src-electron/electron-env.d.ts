// tsconfig 的 paths 把 "better-sqlite3" 映射到运行时包（无类型），
// 这里显式声明模块，让 TS 使用 @types/better-sqlite3 的类型定义。
declare module "better-sqlite3" {
  export * from "@types/better-sqlite3";
  export { default } from "@types/better-sqlite3";
}
