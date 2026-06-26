import { ipcMain } from "electron";
import { and, eq, like, or } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { NewStudent } from "../db/schema";

/** 学生输入（创建/更新） */
export type StudentInput = {
  studentNo: string;
  name: string;
  gender: string;
  age?: number | null;
  major?: string | null;
};

export function registerStudentIpc() {
  const db = getDb();

  /** 列表（可选关键字，匹配学号或姓名） */
  ipcMain.handle("student:list", async (_e, keyword?: string) => {
    const rows = keyword
      ? db
          .select()
          .from(schema.students)
          .where(
            or(
              like(schema.students.studentNo, `%${keyword}%`),
              like(schema.students.name, `%${keyword}%`)
            )
          )
          .all()
      : db.select().from(schema.students).all();
    // 按创建时间倒序
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  });

  /** 单条查询 */
  ipcMain.handle("student:get", async (_e, id: number) => {
    return db
      .select()
      .from(schema.students)
      .where(eq(schema.students.id, id))
      .get();
  });

  /** 新增 */
  ipcMain.handle("student:create", async (_e, data: StudentInput) => {
    const payload: NewStudent = {
      studentNo: data.studentNo.trim(),
      name: data.name.trim(),
      gender: data.gender,
      age: data.age ?? null,
      major: data.major?.trim() || null
    };
    const result = db.insert(schema.students).values(payload).returning().get();
    return result;
  });

  /** 更新 */
  ipcMain.handle(
    "student:update",
    async (_e, id: number, data: StudentInput) => {
      const result = db
        .update(schema.students)
        .set({
          studentNo: data.studentNo.trim(),
          name: data.name.trim(),
          gender: data.gender,
          age: data.age ?? null,
          major: data.major?.trim() || null,
          updatedAt: Math.floor(Date.now() / 1000)
        })
        .where(and(eq(schema.students.id, id)))
        .returning()
        .get();
      return result;
    }
  );

  /** 删除 */
  ipcMain.handle("student:delete", async (_e, id: number) => {
    db.delete(schema.students).where(eq(schema.students.id, id)).run();
    return { success: true, id };
  });
}
