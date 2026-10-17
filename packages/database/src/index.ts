import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  newAccount,
  newContent,
  newCampaign,
  accountLoginStatus,
  platforms,
  type Account,
  type Content,
  type Snapshot,
  type Task,
  type TaskStatus,
  type TaskEvent,
  type DraftProgress,
} from "@turbopush/shared";

export const PUBLICATION_SUBMISSION_MESSAGE =
  "已确认公开发布，正在提交；结果未知时禁止自动重试";

export class Store {
  readonly db: DatabaseSync;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "turbopush.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const version = this.db.prepare("PRAGMA user_version").get()!
      .user_version as number;
    if (version > 5) throw new Error("数据库版本较新，请升级应用");
    if (version === 0)
      this.db.exec(`BEGIN;
      CREATE TABLE accounts (id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE contents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE campaigns (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        account_id TEXT NOT NULL REFERENCES accounts(id), platform TEXT NOT NULL,
        content TEXT NOT NULL, status TEXT NOT NULL, scheduled_at TEXT,
        message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
    if (version < 2)
      this.db.exec(
        "BEGIN; ALTER TABLE tasks ADD COLUMN result_url TEXT; PRAGMA user_version=2; COMMIT;",
      );
    if (version < 3)
      this.db.exec(
        "BEGIN; ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0; ALTER TABLE tasks ADD COLUMN next_run_at TEXT; ALTER TABLE tasks ADD COLUMN last_error_kind TEXT; PRAGMA user_version=3; COMMIT;",
      );
    if (version < 4)
      this.db.exec(
        "BEGIN; ALTER TABLE accounts ADD COLUMN login_status TEXT NOT NULL DEFAULT 'unknown'; ALTER TABLE accounts ADD COLUMN login_checked_at TEXT; ALTER TABLE accounts ADD COLUMN login_message TEXT NOT NULL DEFAULT ''; PRAGMA user_version=4; COMMIT;",
      );
    if (version < 5)
      this.db.exec(
        "BEGIN; ALTER TABLE events ADD COLUMN progress_stage TEXT; ALTER TABLE events ADD COLUMN progress_current INTEGER; ALTER TABLE events ADD COLUMN progress_total INTEGER; PRAGMA user_version=5; COMMIT;",
      );
    // Never blindly retry an interrupted external write: its remote outcome is unknown.
    this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id, status FROM tasks WHERE status IN ('validating','publishing','publication_ready')",
        )
        .all();
      for (const row of rows)
        this.transition(
          row.id as string,
          row.status === "validating" ? "pending" : "intervention_required",
          row.status === "publication_ready"
            ? "待发表编辑器会话已中断；未自动发表，请人工核对"
            : row.status === "publishing"
              ? "应用中断，发布结果未知，请人工核对后处理"
              : "已恢复中断的本地预检任务",
        );
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  accounts(): Account[] {
    return this.db
      .prepare(
        `SELECT id, platform, name, created_at AS createdAt,
         login_status AS loginStatus, login_checked_at AS checkedAt,
         login_message AS message
         FROM accounts ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as unknown as Account[];
  }
  account(id: string): Account {
    const account = this.accounts().find((a) => a.id === id);
    if (!account) throw new Error("账号不存在");
    return account;
  }
  createAccount(input: unknown): Account {
    const parsed = newAccount.parse(input);
    const account: Account = {
      ...parsed,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      loginStatus: "unknown",
      checkedAt: null,
      message: "",
    };
    this.db
      .prepare(
        "INSERT INTO accounts (id,platform,name,created_at) VALUES (?,?,?,?)",
      )
      .run(account.id, account.platform, account.name, account.createdAt);
    return account;
  }
  updateAccountLoginStatus(
    id: string,
    status: unknown,
    message = "",
    checkedAt = new Date(),
  ): Account {
    const parsedStatus = accountLoginStatus.parse(status);
    if (typeof message !== "string" || message.length > 1000)
      throw new Error("登录状态消息必须是1000字以内的文本");
    if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime()))
      throw new Error("登录状态检查时间无效");
    const timestamp = checkedAt.toISOString();
    return this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE accounts SET login_status=?, login_checked_at=?, login_message=? WHERE id=?",
        )
        .run(parsedStatus, timestamp, message, id);
      if (result.changes !== 1) throw new Error("账号不存在");
      return this.account(id);
    });
  }
  createContent(input: unknown): Content {
    const content = {
      ...newContent.parse(input),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO contents VALUES (?,?)")
      .run(content.id, JSON.stringify(content));
    return content;
  }
  contents(): Content[] {
    return this.db
      .prepare("SELECT data FROM contents ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  updateContent(id: string, input: unknown): Content {
    const previous = this.contents().find((c) => c.id === id);
    if (!previous) throw new Error("内容不存在");
    const content = {
      ...newContent.parse(input),
      id: previous.id,
      createdAt: previous.createdAt,
    };
    this.db
      .prepare("UPDATE contents SET data=? WHERE id=?")
      .run(JSON.stringify(content), id);
    return content;
  }
  tasks(): Task[] {
    return this.db
      .prepare(
        `SELECT id, campaign_id AS campaignId, account_id AS accountId, platform, content,
      status, scheduled_at AS scheduledAt, message, created_at AS createdAt, result_url AS resultUrl,
      attempt_count AS attemptCount, next_run_at AS nextRunAt, last_error_kind AS lastErrorKind
      FROM tasks ORDER BY rowid DESC`,
      )
      .all()
      .map((row) => ({
        ...row,
        content: JSON.parse(row.content as string),
      })) as unknown as Task[];
  }
  task(id: string): Task {
    const task = this.tasks().find((t) => t.id === id);
    if (!task) throw new Error("任务不存在");
    return task;
  }
  events(taskId: string): TaskEvent[] {
    this.task(taskId);
    return this.db
      .prepare(
        `SELECT id, task_id AS taskId, status, message, created_at AS createdAt,
         progress_stage AS progressStage, progress_current AS progressCurrent,
         progress_total AS progressTotal
         FROM events WHERE task_id=? ORDER BY id ASC`,
      )
      .all(taskId) as unknown as TaskEvent[];
  }
  /**
   * Return tasks that a queue may attempt now. Pending tasks are immediately
   * runnable; scheduled tasks only become runnable at their persisted time.
   * Accounts already in a write-sensitive phase are omitted.
   */
  dueTasks(now = new Date(), limit = 100): Task[] {
    const timestamp = queueTimestamp(now);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("队列查询数量必须是1到1000的整数");
    const ids = this.db
      .prepare(
        `SELECT candidate.id
         FROM tasks AS candidate
         WHERE (candidate.status='pending'
           OR (candidate.status='scheduled' AND candidate.scheduled_at<=?)
           OR (candidate.status='retry_wait' AND candidate.next_run_at<=?))
         AND NOT EXISTS (
           SELECT 1 FROM tasks AS active
           WHERE active.account_id=candidate.account_id
             AND active.status IN ('validating','publishing','publication_ready')
         )
         ORDER BY COALESCE(candidate.scheduled_at,candidate.created_at), candidate.rowid
         LIMIT ?`,
      )
      .all(timestamp, timestamp, limit)
      .map((row) => row.id as string);
    return ids.map((id) => this.task(id));
  }

  /** Atomically claim one runnable task. A lost race returns null. */
  claimTask(id: string, now = new Date()): Task | null {
    const timestamp = queueTimestamp(now);
    return this.transaction(() => {
      const message = "队列已领取任务，正在执行本地预检";
      const result = this.db
        .prepare(
          `UPDATE tasks AS candidate SET status='validating', message=?,
             attempt_count=attempt_count+1, next_run_at=NULL
           WHERE candidate.id=?
             AND (candidate.status='pending'
               OR (candidate.status='scheduled' AND candidate.scheduled_at<=?)
               OR (candidate.status='retry_wait' AND candidate.next_run_at<=?))
             AND NOT EXISTS (
               SELECT 1 FROM tasks AS active
               WHERE active.account_id=candidate.account_id
                 AND active.id<>candidate.id
                 AND active.status IN ('validating','publishing','publication_ready')
             )`,
        )
        .run(message, id, timestamp, timestamp);
      if (result.changes !== 1) return null;
      this.db
        .prepare(
          "INSERT INTO events (task_id,status,message,created_at) VALUES (?,?,?,?)",
        )
        .run(id, "validating", message, new Date().toISOString());
      return this.task(id);
    });
  }
  createCampaign(input: unknown): Task[] {
    const parsed = newCampaign.parse(input);
    const content = this.contents().find((c) => c.id === parsed.contentId);
    if (!content) throw new Error("内容不存在");
    const accounts = [...new Set(parsed.accountIds)].map((id) =>
      this.account(id),
    );
    for (const account of accounts) {
      const platform = platforms.find((p) => p.id === account.platform)!;
      if (!platform.types.includes(content.type))
        throw new Error(`${platform.name}不支持此内容类型`);
    }
    const scheduledAt = parsed.scheduledAt
      ? new Date(parsed.scheduledAt).toISOString()
      : null;
    if (scheduledAt && Date.parse(scheduledAt) <= Date.now())
      throw new Error("计划时间必须晚于当前时间");
    const createdAt = new Date().toISOString();
    const campaignId = randomUUID();
    return this.transaction(() => {
      this.db
        .prepare("INSERT INTO campaigns VALUES (?,?)")
        .run(campaignId, createdAt);
      return accounts.map((account) => {
        const task: Task = {
          id: randomUUID(),
          campaignId,
          accountId: account.id,
          platform: account.platform,
          content,
          status: scheduledAt ? "scheduled" : "pending",
          scheduledAt,
          createdAt,
          resultUrl: null,
          attemptCount: 0,
          nextRunAt: null,
          lastErrorKind: null,
          message:
            "已保存本地计划，不会自动发布。知乎与公众号文章可手动保存草稿",
        };
        this.db
          .prepare(
            "INSERT INTO tasks (id,campaign_id,account_id,platform,content,status,scheduled_at,message,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            task.id,
            campaignId,
            account.id,
            account.platform,
            JSON.stringify(content),
            task.status,
            scheduledAt,
            task.message,
            createdAt,
          );
        return task;
      });
    });
  }
  transition(id: string, status: TaskStatus, message: string) {
    this.db
      .prepare("UPDATE tasks SET status=?, message=? WHERE id=?")
      .run(status, message, id);
    this.db
      .prepare(
        "INSERT INTO events (task_id,status,message,created_at) VALUES (?,?,?,?)",
      )
      .run(id, status, message, new Date().toISOString());
  }
  progress(id: string, event: DraftProgress) {
    const current = event.current ?? null;
    const total = event.total ?? null;
    if (
      !["session", "upload", "fields", "privacy", "save", "verify"].includes(
        event.stage,
      )
    )
      throw new Error("未知的平台进度阶段");
    if (!event.message.trim() || event.message.length > 1000)
      throw new Error("进度消息必须是1到1000字的文本");
    if (
      (current === null) !== (total === null) ||
      (current !== null && (!Number.isSafeInteger(current) || current < 0)) ||
      (total !== null && (!Number.isSafeInteger(total) || total < 1)) ||
      (current !== null && total !== null && current > total)
    )
      throw new Error("进度数量无效");
    this.transaction(() => {
      const task = this.task(id);
      if (task.status !== "publishing")
        throw new Error("仅远端草稿写入阶段可记录平台进度");
      this.db
        .prepare("UPDATE tasks SET message=? WHERE id=?")
        .run(event.message, id);
      this.db
        .prepare(
          `INSERT INTO events
           (task_id,status,message,created_at,progress_stage,progress_current,progress_total)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          "publishing",
          event.message,
          new Date().toISOString(),
          event.stage,
          current,
          total,
        );
    });
  }
  recordQueueFailure(
    id: string,
    kind: "retryable" | "permanent" | "unknown",
    message: string,
    now = new Date(),
  ) {
    const task = this.task(id);
    const retry = kind === "retryable" && task.attemptCount <= 2;
    const status: TaskStatus = retry
      ? "retry_wait"
      : kind === "unknown"
        ? "intervention_required"
        : "failed";
    const nextRunAt = retry
      ? new Date(
          now.getTime() + 1_000 * 2 ** Math.max(0, task.attemptCount - 1),
        ).toISOString()
      : null;
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE tasks SET status=?, message=?, next_run_at=?, last_error_kind=? WHERE id=?",
        )
        .run(status, message, nextRunAt, kind, id);
      this.db
        .prepare(
          "INSERT INTO events (task_id,status,message,created_at) VALUES (?,?,?,?)",
        )
        .run(id, status, message, now.toISOString());
    });
    return this.task(id);
  }
  checkpointDraft(id: string, url: string) {
    this.db.prepare("UPDATE tasks SET result_url=? WHERE id=?").run(url, id);
  }
  hasPublicationAttempt(id: string) {
    return !!this.db
      .prepare("SELECT 1 FROM events WHERE task_id=? AND message=? LIMIT 1")
      .get(id, PUBLICATION_SUBMISSION_MESSAGE);
  }
  hasDraftAttempt(id: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM events WHERE task_id=? AND status='publishing' LIMIT 1",
      )
      .get(id);
  }
  cancel(id: string) {
    const task = this.task(id);
    if (
      ![
        "pending",
        "scheduled",
        "retry_wait",
        "failed",
        "intervention_required",
      ].includes(task.status)
    )
      throw new Error("当前状态不能取消");
    this.transaction(() => this.transition(id, "cancelled", "已取消本地任务"));
    return this.task(id);
  }
  snapshot(): Snapshot {
    return {
      platforms,
      accounts: this.accounts(),
      contents: this.contents(),
      tasks: this.tasks(),
    };
  }
  close() {
    this.db.close();
  }
}

function queueTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error("队列时间无效");
  return value.toISOString();
}
