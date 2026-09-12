import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/database/src/index.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "turbopush-store-"));
  const store = new Store(dir);
  return {
    store,
    dir,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("accounts and immutable campaign content survive reopening the SQLite database", () => {
  const f = fixture();
  const account = f.store.createAccount({
    platform: "wechat-official",
    name: "公众号测试",
  });
  const content = f.store.createContent({
    type: "article",
    title: "第一篇",
    body: "# 正文",
  });
  const tasks = f.store.createCampaign({
    contentId: content.id,
    accountIds: [account.id, account.id],
  });
  assert.equal(tasks.length, 1);
  f.store.updateContent(content.id, {
    type: "article",
    title: "修改后的原稿",
    body: "修改正文",
    bodyFormat: "markdown",
  });
  assert.throws(() =>
    f.store.updateContent(content.id, {
      type: "article",
      title: "",
      body: "正文",
    }),
  );
  f.store.close();
  const reopened = new Store(f.dir);
  try {
    assert.equal(reopened.accounts()[0].name, "公众号测试");
    assert.equal(reopened.tasks()[0].content.title, "第一篇");
    assert.equal(reopened.contents()[0].title, "修改后的原稿");
    assert.equal(
      reopened.db.prepare("PRAGMA user_version").get()?.user_version,
      5,
    );
  } finally {
    reopened.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("平台细粒度进度更新任务消息并保留结构化计数", () => {
  const f = fixture();
  try {
    const account = f.store.createAccount({ platform: "zhihu", name: "进度" });
    const content = f.store.createContent({
      type: "article",
      title: "进度测试",
      body: "正文",
    });
    const task = f.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0]!;
    f.store.transition(task.id, "publishing", "开始远端草稿写入");
    f.store.progress(task.id, {
      stage: "upload",
      message: "图片已上传 1/2",
      current: 1,
      total: 2,
    });
    assert.equal(f.store.task(task.id).message, "图片已上传 1/2");
    const event = f.store.events(task.id).at(-1)!;
    assert.equal(event.id, 2);
    assert.equal(event.taskId, task.id);
    assert.equal(event.status, "publishing");
    assert.equal(event.message, "图片已上传 1/2");
    assert.equal(event.progressStage, "upload");
    assert.equal(event.progressCurrent, 1);
    assert.equal(event.progressTotal, 2);
    assert.throws(
      () =>
        f.store.progress(task.id, {
          stage: "upload",
          message: "错误计数",
          current: 3,
          total: 2,
        }),
      /数量无效/,
    );
    assert.throws(
      () =>
        f.store.progress(task.id, {
          stage: "upload",
          message: "缺少总数",
          current: 1,
        }),
      /数量无效/,
    );
    assert.throws(
      () =>
        f.store.progress(task.id, {
          stage: "unexpected" as "upload",
          message: "未知阶段",
        }),
      /未知的平台进度阶段/,
    );
    f.store.transition(task.id, "draft_saved", "完成");
    assert.throws(
      () =>
        f.store.progress(task.id, {
          stage: "verify",
          message: "终态后不应写入",
        }),
      /仅远端草稿写入阶段/,
    );
    assert.equal(f.store.task(task.id).message, "完成");
  } finally {
    f.close();
  }
});
test("invalid mixed-platform campaign creates no partial tasks or campaign", () => {
  const f = fixture();
  try {
    const wechat = f.store.createAccount({
      platform: "wechat-official",
      name: "微信",
    });
    const douyin = f.store.createAccount({ platform: "douyin", name: "抖音" });
    const content = f.store.createContent({
      type: "article",
      title: "文章",
      body: "正文",
    });
    assert.throws(
      () =>
        f.store.createCampaign({
          contentId: content.id,
          accountIds: [wechat.id, douyin.id],
        }),
      /不支持/,
    );
    assert.equal(f.store.tasks().length, 0);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM campaigns").get()?.n,
      0,
    );
  } finally {
    f.close();
  }
});
test("recovery preserves schedules and quarantines interrupted publishing", () => {
  const f = fixture();
  const account = f.store.createAccount({ platform: "zhihu", name: "知乎" });
  const content = f.store.createContent({
    type: "article",
    title: "测试",
    body: "正文",
  });
  const publishing = f.store.createCampaign({
    contentId: content.id,
    accountIds: [account.id],
  })[0];
  const validating = f.store.createCampaign({
    contentId: content.id,
    accountIds: [account.id],
  })[0];
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const scheduled = f.store.createCampaign({
    contentId: content.id,
    accountIds: [account.id],
    scheduledAt: future,
  })[0];
  f.store.transition(publishing.id, "publishing", "开始发布");
  f.store.transition(validating.id, "validating", "预检");
  f.store.close();
  const reopened = new Store(f.dir);
  try {
    assert.equal(reopened.task(publishing.id).status, "intervention_required");
    assert.match(reopened.task(publishing.id).message, /结果未知/);
    assert.equal(reopened.task(validating.id).status, "pending");
    assert.equal(reopened.task(scheduled.id).scheduledAt, future);
    assert.equal(reopened.task(scheduled.id).status, "scheduled");
  } finally {
    reopened.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("past schedules and empty media are rejected; cancellation is persistent", () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.store.createContent({ type: "gallery", title: "空图文" }),
    );
    assert.throws(() =>
      f.store.createContent({ type: "video", title: "空视频" }),
    );
    const a = f.store.createAccount({ platform: "zhihu", name: "知乎" });
    const c = f.store.createContent({
      type: "article",
      title: "测试",
      body: "正文",
    });
    assert.throws(
      () =>
        f.store.createCampaign({
          contentId: c.id,
          accountIds: [a.id],
          scheduledAt: "2020-01-01T00:00:00Z",
        }),
      /晚于/,
    );
    const task = f.store.createCampaign({
      contentId: c.id,
      accountIds: [a.id],
    })[0];
    f.store.cancel(task.id);
    assert.equal(f.store.task(task.id).status, "cancelled");
    assert.throws(() => f.store.cancel(task.id), /不能取消/);
  } finally {
    f.close();
  }
});

test("v1 database migrates without losing tasks, and draft URL survives recovery", () => {
  const f = fixture();
  const a = f.store.createAccount({ platform: "zhihu", name: "迁移账号" });
  const c = f.store.createContent({
    type: "article",
    title: "迁移测试",
    body: "正文",
  });
  const task = f.store.createCampaign({
    contentId: c.id,
    accountIds: [a.id],
  })[0];
  f.store.db.exec(
    "ALTER TABLE tasks DROP COLUMN result_url; ALTER TABLE tasks DROP COLUMN attempt_count; ALTER TABLE tasks DROP COLUMN next_run_at; ALTER TABLE tasks DROP COLUMN last_error_kind; ALTER TABLE accounts DROP COLUMN login_status; ALTER TABLE accounts DROP COLUMN login_checked_at; ALTER TABLE accounts DROP COLUMN login_message; ALTER TABLE events DROP COLUMN progress_stage; ALTER TABLE events DROP COLUMN progress_current; ALTER TABLE events DROP COLUMN progress_total; PRAGMA user_version=1;",
  );
  f.store.close();
  const migrated = new Store(f.dir);
  assert.equal(migrated.task(task.id).resultUrl, null);
  migrated.checkpointDraft(task.id, "https://zhuanlan.zhihu.com/p/123/edit");
  migrated.transition(task.id, "publishing", "保存中");
  migrated.close();
  const reopened = new Store(f.dir);
  try {
    assert.equal(reopened.task(task.id).status, "intervention_required");
    assert.equal(
      reopened.task(task.id).resultUrl,
      "https://zhuanlan.zhihu.com/p/123/edit",
    );
    assert.equal(reopened.task(task.id).content.title, "迁移测试");
  } finally {
    reopened.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("retry_wait元数据持久化，重启后按1秒/2秒到期恢复且最多重试2次", () => {
  const f = fixture();
  const account = f.store.createAccount({ platform: "zhihu", name: "重试" });
  const content = f.store.createContent({
    type: "article",
    title: "重试测试",
    body: "正文",
  });
  const task = f.store.createCampaign({
    contentId: content.id,
    accountIds: [account.id],
  })[0];
  const now = new Date("2030-01-01T00:00:00.000Z");
  assert.equal(f.store.claimTask(task.id, now)?.attemptCount, 1);
  let failed = f.store.recordQueueFailure(
    task.id,
    "retryable",
    "临时失败1",
    now,
  );
  assert.equal(failed.status, "retry_wait");
  assert.equal(failed.nextRunAt, "2030-01-01T00:00:01.000Z");
  assert.equal(failed.lastErrorKind, "retryable");
  f.store.close();

  const reopened = new Store(f.dir);
  try {
    assert.deepEqual(reopened.dueTasks(new Date(now.getTime() + 999)), []);
    assert.equal(
      reopened.dueTasks(new Date(now.getTime() + 1_000))[0]?.id,
      task.id,
    );
    assert.equal(
      reopened.claimTask(task.id, new Date(now.getTime() + 1_000))
        ?.attemptCount,
      2,
    );
    failed = reopened.recordQueueFailure(
      task.id,
      "retryable",
      "临时失败2",
      new Date(now.getTime() + 1_000),
    );
    assert.equal(failed.nextRunAt, "2030-01-01T00:00:03.000Z");
    assert.equal(
      reopened.claimTask(task.id, new Date(now.getTime() + 3_000))
        ?.attemptCount,
      3,
    );
    failed = reopened.recordQueueFailure(
      task.id,
      "retryable",
      "临时失败3",
      new Date(now.getTime() + 3_000),
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.nextRunAt, null);
  } finally {
    reopened.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("unknown与permanent失败不进入重试等待", () => {
  for (const kind of ["unknown", "permanent"] as const) {
    const f = fixture();
    try {
      const account = f.store.createAccount({ platform: "zhihu", name: kind });
      const content = f.store.createContent({
        type: "article",
        title: kind,
        body: "正文",
      });
      const task = f.store.createCampaign({
        contentId: content.id,
        accountIds: [account.id],
      })[0];
      f.store.claimTask(task.id);
      const failed = f.store.recordQueueFailure(task.id, kind, "失败");
      assert.equal(
        failed.status,
        kind === "unknown" ? "intervention_required" : "failed",
      );
      assert.equal(failed.nextRunAt, null);
      assert.equal(
        f.store.dueTasks().some((item) => item.id === task.id),
        false,
      );
    } finally {
      f.close();
    }
  }
});

test("v2数据库迁移补齐重试列且保留草稿链接", () => {
  const f = fixture();
  const account = f.store.createAccount({ platform: "zhihu", name: "v2" });
  const content = f.store.createContent({
    type: "article",
    title: "v2",
    body: "正文",
  });
  const task = f.store.createCampaign({
    contentId: content.id,
    accountIds: [account.id],
  })[0];
  f.store.checkpointDraft(task.id, "https://zhuanlan.zhihu.com/p/222/edit");
  f.store.db.exec(
    "ALTER TABLE tasks DROP COLUMN attempt_count; ALTER TABLE tasks DROP COLUMN next_run_at; ALTER TABLE tasks DROP COLUMN last_error_kind; ALTER TABLE accounts DROP COLUMN login_status; ALTER TABLE accounts DROP COLUMN login_checked_at; ALTER TABLE accounts DROP COLUMN login_message; ALTER TABLE events DROP COLUMN progress_stage; ALTER TABLE events DROP COLUMN progress_current; ALTER TABLE events DROP COLUMN progress_total; PRAGMA user_version=2;",
  );
  f.store.close();
  const migrated = new Store(f.dir);
  try {
    const restored = migrated.task(task.id);
    assert.equal(restored.resultUrl, "https://zhuanlan.zhihu.com/p/222/edit");
    assert.equal(restored.attemptCount, 0);
    assert.equal(restored.nextRunAt, null);
    assert.equal(
      migrated.db.prepare("PRAGMA user_version").get()?.user_version,
      5,
    );
  } finally {
    migrated.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("account login status persists and rejects invalid updates", () => {
  const f = fixture();
  const account = f.store.createAccount({
    platform: "zhihu",
    name: "登录状态",
  });
  assert.equal(account.loginStatus, "unknown");
  assert.equal(account.checkedAt, null);
  assert.equal(account.message, "");
  const checkedAt = new Date("2030-02-03T04:05:06.000Z");
  const updated = f.store.updateAccountLoginStatus(
    account.id,
    "authenticated",
    "登录有效",
    checkedAt,
  );
  assert.equal(updated.loginStatus, "authenticated");
  assert.equal(updated.checkedAt, checkedAt.toISOString());
  assert.equal(updated.message, "登录有效");
  assert.throws(
    () => f.store.updateAccountLoginStatus(account.id, "logged_in"),
    /Invalid option/,
  );
  assert.throws(
    () => f.store.updateAccountLoginStatus("missing", "expired"),
    /账号不存在/,
  );
  f.store.close();
  const reopened = new Store(f.dir);
  try {
    assert.deepEqual(reopened.account(account.id), updated);
  } finally {
    reopened.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("v3 database migration adds default login state without losing accounts", () => {
  const f = fixture();
  const account = f.store.createAccount({ platform: "zhihu", name: "v3账号" });
  f.store.db.exec(
    "ALTER TABLE accounts DROP COLUMN login_status; ALTER TABLE accounts DROP COLUMN login_checked_at; ALTER TABLE accounts DROP COLUMN login_message; ALTER TABLE events DROP COLUMN progress_stage; ALTER TABLE events DROP COLUMN progress_current; ALTER TABLE events DROP COLUMN progress_total; PRAGMA user_version=3;",
  );
  f.store.close();
  const migrated = new Store(f.dir);
  try {
    const restored = migrated.account(account.id);
    assert.equal(restored.name, "v3账号");
    assert.equal(restored.loginStatus, "unknown");
    assert.equal(restored.checkedAt, null);
    assert.equal(restored.message, "");
    assert.equal(
      migrated.db.prepare("PRAGMA user_version").get()?.user_version,
      5,
    );
  } finally {
    migrated.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("v4数据库迁移为既有事件补齐可空进度字段", () => {
  const f = fixture();
  const account = f.store.createAccount({ platform: "zhihu", name: "v4账号" });
  const content = f.store.createContent({
    type: "article",
    title: "v4事件迁移",
    body: "正文",
  });
  const task = f.store.createCampaign({
    contentId: content.id,
    accountIds: [account.id],
  })[0]!;
  f.store.transition(task.id, "publishing", "迁移前事件");
  f.store.db.exec(
    "ALTER TABLE events DROP COLUMN progress_stage; ALTER TABLE events DROP COLUMN progress_current; ALTER TABLE events DROP COLUMN progress_total; PRAGMA user_version=4;",
  );
  f.store.close();

  const migrated = new Store(f.dir);
  try {
    assert.equal(
      migrated.db.prepare("PRAGMA user_version").get()?.user_version,
      5,
    );
    // Recovery appends an intervention event; the pre-migration event remains readable.
    const previous = migrated.events(task.id)[0]!;
    assert.equal(previous.message, "迁移前事件");
    assert.equal(previous.progressStage, null);
    assert.equal(previous.progressCurrent, null);
    assert.equal(previous.progressTotal, null);
  } finally {
    migrated.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("queue lists only runnable tasks and atomically claims each task once", () => {
  const f = fixture();
  try {
    const account = f.store.createAccount({ platform: "zhihu", name: "队列" });
    const content = f.store.createContent({
      type: "article",
      title: "队列测试",
      body: "正文",
    });
    const pending = f.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0];
    const scheduledAt = new Date(Date.now() + 60_000);
    const scheduled = f.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
      scheduledAt: scheduledAt.toISOString(),
    })[0];

    assert.deepEqual(
      f.store
        .dueTasks(new Date(scheduledAt.getTime() - 1))
        .map((task) => task.id),
      [pending.id],
    );
    assert.equal(f.store.claimTask(scheduled.id, new Date()), null);
    assert.equal(f.store.claimTask(pending.id)?.status, "validating");
    assert.equal(f.store.claimTask(pending.id), null);
    assert.deepEqual(f.store.dueTasks(new Date(scheduledAt.getTime() + 1)), []);

    f.store.transition(pending.id, "failed", "释放账号");
    assert.deepEqual(
      f.store
        .dueTasks(new Date(scheduledAt.getTime() + 1))
        .map((task) => task.id),
      [scheduled.id],
    );
    assert.equal(
      f.store.claimTask(scheduled.id, new Date(scheduledAt.getTime() + 1))
        ?.status,
      "validating",
    );
    assert.equal(f.store.claimTask(pending.id), null);
  } finally {
    f.close();
  }
});

test("cancelled tasks cannot be queued and one account cannot be claimed twice", () => {
  const f = fixture();
  let contender: Store | undefined;
  try {
    const account = f.store.createAccount({ platform: "zhihu", name: "互斥" });
    const other = f.store.createAccount({ platform: "zhihu", name: "另一个" });
    const content = f.store.createContent({
      type: "article",
      title: "队列互斥",
      body: "正文",
    });
    const first = f.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0];
    const second = f.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0];
    const cancelled = f.store.createCampaign({
      contentId: content.id,
      accountIds: [other.id],
    })[0];
    f.store.cancel(cancelled.id);
    contender = new Store(f.dir);

    assert.equal(f.store.claimTask(cancelled.id), null);
    assert.equal(f.store.claimTask(first.id)?.status, "validating");
    assert.equal(contender.claimTask(first.id), null);
    assert.equal(contender.claimTask(second.id), null);
    assert.equal(f.store.task(second.id).status, "pending");
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) AS n FROM events WHERE task_id=? AND status='validating'",
        )
        .get(first.id)?.n,
      1,
    );
  } finally {
    contender?.close();
    f.close();
  }
});
