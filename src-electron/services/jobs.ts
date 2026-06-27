/**
 * 后台任务系统 —— 移植自 `jobs.py`。
 *
 * 单进程内串行执行（最多 1 个并发任务，简化为串行队列）。
 * JobProgress 通过原子 SQL 更新 jobs 表。
 */

import { eq } from "drizzle-orm";
import { getDb, getRawSqlite } from "../db";
import { jobs, type Job } from "../db/schema";
import { utcNow } from "../lib/util";

export type JobRunner = (progress: JobProgress) => Promise<unknown> | unknown;

const MAX_LOG_LENGTH = 12000;

function appendLog(logs: string | null, message: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  const line = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${message}`;
  if (!logs) return line;
  const combined = `${logs}\n${line}`;
  return combined.slice(-MAX_LOG_LENGTH);
}

export class JobProgress {
  constructor(public jobId: number) {}

  addTotal(count: number): void {
    const now = utcNow();
    getRawSqlite()
      .prepare("UPDATE jobs SET total = total + ?, updated_at = ? WHERE id = ?")
      .run(count, now, this.jobId);
  }

  success(count: number, message = ""): void {
    this.advance(count, count, 0, message);
  }

  fail(count: number, message: string): void {
    this.advance(count, 0, count, message);
  }

  log(message: string): void {
    const db = getDb();
    const job = db.select().from(jobs).where(eq(jobs.id, this.jobId)).get();
    if (!job) return;
    db.update(jobs)
      .set({ logs: appendLog(job.logs, message).slice(-MAX_LOG_LENGTH), updatedAt: utcNow() })
      .where(eq(jobs.id, this.jobId))
      .run();
  }

  private advance(count: number, success: number, fail: number, message: string): void {
    const now = utcNow();
    if (message) {
      getRawSqlite()
        .prepare(
          "UPDATE jobs SET processed = processed + ?, success_count = success_count + ?, fail_count = fail_count + ?, message = ?, updated_at = ? WHERE id = ?",
        )
        .run(count, success, fail, message.slice(0, 500), now, this.jobId);
    } else {
      getRawSqlite()
        .prepare(
          "UPDATE jobs SET processed = processed + ?, success_count = success_count + ?, fail_count = fail_count + ?, updated_at = ? WHERE id = ?",
        )
        .run(count, success, fail, now, this.jobId);
    }
  }
}

const jobQueue: Array<{ jobId: number; runner: JobRunner }> = [];
let running = false;

/** 启动一个后台任务（排队执行）。返回 Job。 */
export function startJob(jobType: string, runner: JobRunner): Job {
  const db = getDb();
  const now = utcNow();
  const result = db
    .insert(jobs)
    .values({ jobType, status: "pending", message: "等待执行", createdAt: now, updatedAt: now })
    .returning()
    .get();
  jobQueue.push({ jobId: result.id, runner });
  void runQueue();
  return result;
}

async function runQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (jobQueue.length) {
      const { jobId, runner } = jobQueue.shift()!;
      await runJob(jobId, runner);
    }
  } finally {
    running = false;
  }
}

async function runJob(jobId: number, runner: JobRunner): Promise<void> {
  const db = getDb();
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return;
  db.update(jobs)
    .set({ status: "running", message: "执行中", updatedAt: utcNow() })
    .where(eq(jobs.id, jobId))
    .run();
  const progress = new JobProgress(jobId);
  try {
    await runner(progress);
    const updated = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (updated) {
      const failCount = updated.failCount ?? 0;
      db.update(jobs)
        .set({
          status: failCount ? "partial_failed" : "succeeded",
          message: failCount ? "完成，部分失败" : "完成",
          finishedAt: utcNow(),
          updatedAt: utcNow(),
        })
        .where(eq(jobs.id, jobId))
        .run();
    }
  } catch (err) {
    const updated = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (updated) {
      const msg = String((err as Error).message ?? err).slice(0, 500);
      db.update(jobs)
        .set({
          status: "failed",
          failCount: (updated.failCount ?? 0) + 1,
          message: msg,
          logs: appendLog(updated.logs, String((err as Error).message ?? err)).slice(-MAX_LOG_LENGTH),
          finishedAt: utcNow(),
          updatedAt: utcNow(),
        })
        .where(eq(jobs.id, jobId))
        .run();
    }
  }
}

export function jobToDict(job: Job): Record<string, unknown> {
  const createdAt = job.createdAt ?? 0;
  const finishedOrUpdated = job.finishedAt ?? job.updatedAt ?? createdAt;
  const durationMs = Math.round(Math.max(0, (finishedOrUpdated - createdAt) * 1000) * 10) / 10;
  return {
    id: job.id,
    job_type: job.jobType,
    status: job.status,
    total: job.total ?? 0,
    processed: job.processed ?? 0,
    success_count: job.successCount ?? 0,
    fail_count: job.failCount ?? 0,
    message: job.message ?? "",
    logs: job.logs ?? "",
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    finished_at: job.finishedAt,
    duration_ms: durationMs,
  };
}
