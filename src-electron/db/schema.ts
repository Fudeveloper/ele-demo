import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 学生信息表
 */
export const students = sqliteTable("students", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // 学号
  studentNo: text("student_no").notNull().unique(),
  // 姓名
  name: text("name").notNull(),
  // 性别：男 / 女
  gender: text("gender").notNull(),
  // 年龄
  age: integer("age"),
  // 专业
  major: text("major"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`)
});

export type Student = typeof students.$inferSelect;
export type NewStudent = typeof students.$inferInsert;
