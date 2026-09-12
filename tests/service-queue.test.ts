import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Service } from "../packages/publisher-engine/src/service.ts";
import type { QueueClock } from "../packages/publisher-engine/src/task-queue.ts";
import { QueueFailure } from "../packages/publisher-engine/src/task-queue.ts";

class VirtualClock implements QueueClock {
  constructor(public time = Date.now()) {}
  private id = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = ++this.id;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  };
  clearTimeout = (handle: unknown) => this.timers.delete(handle as number);
  advance(ms: number) {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function addTask(service: Service, accountId?: string, scheduledAt?: string) {
  const account = accountId
    ? service.store.account(accountId)
    : service.store.createAccount({ platform: "zhihu", name: "队列测试" });
  const content = service.store.createContent({
    type: "article",
    title: "异步草稿",
    body: "正文",
  });
  return service.store.createCampaign({
    contentId: content.id,
    accountIds: [account.id],
    ...(scheduledAt ? { scheduledAt } : {}),
  })[0];
}

test("task.enqueueDraft立即返回，后台完成且重复请求不重复领取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-queue-"));
  let release!: () => void;
  let calls = 0;
  const service = new Service(dir, {
    draftExecutor: async (_task, { markExternalWrite }) => {
      calls += 1;
      markExternalWrite();
      await new Promise<void>((resolve) => (release = resolve));
      return { url: "https://zhuanlan.zhihu.com/p/123/edit" };
    },
  });
  try {
    const task = addTask(service);
    const response = await service.dispatch({
      id: 1,
      method: "task.enqueueDraft",
      params: { id: task.id },
    });
    assert.equal(response.error, undefined);
    assert.equal((response.result as { queued: boolean }).queued, true);
    assert.equal(calls, 1);
    assert.equal(service.store.task(task.id).status, "publishing");
    const duplicate = await service.dispatch({
      id: 2,
      method: "task.enqueueDraft",
      params: { id: task.id },
    });
    assert.equal((duplicate.result as { queued: boolean }).queued, false);
    assert.equal(calls, 1);
    release();
    await flush();
    assert.equal(service.store.task(task.id).status, "draft_saved");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("异步草稿队列持久化关键阶段，便于观察本地预检与远端回读", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-progress-"));
  let taskId = "";
  const observedMessages: string[] = [];
  const service = new Service(dir, {
    draftExecutor: async (_task, { checkpoint, markExternalWrite }) => {
      observedMessages.push(service.store.task(taskId).message);
      markExternalWrite();
      observedMessages.push(service.store.task(taskId).message);
      checkpoint("https://zhuanlan.zhihu.com/p/321/edit");
      observedMessages.push(service.store.task(taskId).message);
      return { url: "https://zhuanlan.zhihu.com/p/321/edit" };
    },
  });
  try {
    const task = addTask(service);
    taskId = task.id;
    await service.dispatch({
      id: 1,
      method: "task.enqueueDraft",
      params: { id: task.id },
    });
    await flush();
    assert.equal(service.store.task(task.id).status, "draft_saved");
    assert.deepEqual(observedMessages, [
      "本地预检通过，正在准备账号草稿会话",
      "正在异步保存测试版草稿，不会公开发布",
      "平台草稿地址已确认，正在回读保存结果",
    ]);
    const events = (
      service.store.db
        .prepare(
          "SELECT status, message FROM events WHERE task_id=? ORDER BY id",
        )
        .all(task.id) as Array<{ status: string; message: string }>
    ).map(({ status, message }) => ({ status, message }));
    assert.deepEqual(events.slice(-4), [
      {
        status: "validating",
        message: "本地预检通过，正在准备账号草稿会话",
      },
      {
        status: "publishing",
        message: "正在异步保存测试版草稿，不会公开发布",
      },
      {
        status: "publishing",
        message: "平台草稿地址已确认，正在回读保存结果",
      },
      {
        status: "draft_saved",
        message: "异步草稿已保存并回读一致；未公开发布",
      },
    ]);
    const history = await service.dispatch({
      id: 3,
      method: "task.events",
      params: { id: task.id },
    });
    assert.equal(history.error, undefined);
    assert.equal(
      (history.result as Array<{ message: string }>).at(-1)?.message,
      "异步草稿已保存并回读一致；未公开发布",
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("异步适配器的上传、字段、隐私和回读进度被结构化持久化", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "turbopush-service-detail-progress-"),
  );
  const service = new Service(dir, {
    draftExecutor: async (_task, { markExternalWrite, progress }) => {
      markExternalWrite();
      progress({
        stage: "upload",
        message: "测试素材已上传 2/3",
        current: 2,
        total: 3,
      });
      progress({ stage: "fields", message: "测试标题和正文已填写" });
      progress({ stage: "privacy", message: "测试隐私状态已确认" });
      progress({ stage: "verify", message: "测试草稿已回读" });
      return { url: "https://zhuanlan.zhihu.com/p/322/edit" };
    },
  });
  try {
    const task = addTask(service);
    await service.dispatch({
      id: 1,
      method: "task.enqueueDraft",
      params: { id: task.id },
    });
    await flush();
    const response = await service.dispatch({
      id: 2,
      method: "task.events",
      params: { id: task.id },
    });
    assert.equal(response.error, undefined);
    const progress = (
      response.result as Array<{
        progressStage: string | null;
        progressCurrent: number | null;
        progressTotal: number | null;
      }>
    ).filter((event) => event.progressStage);
    assert.deepEqual(
      progress.map((event) => ({
        stage: event.progressStage,
        current: event.progressCurrent,
        total: event.progressTotal,
      })),
      [
        { stage: "upload", current: 2, total: 3 },
        { stage: "fields", current: null, total: null },
        { stage: "privacy", current: null, total: null },
        { stage: "verify", current: null, total: null },
      ],
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("外部动作后进度持久化失败不把成功草稿误标为失败", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "turbopush-progress-observer-failure-"),
  );
  const service = new Service(dir, {
    draftExecutor: async (_task, { markExternalWrite, progress }) => {
      markExternalWrite();
      // Invalid telemetry deliberately makes Store.progress throw internally.
      progress({
        stage: "upload",
        message: "模拟进度存储失败",
        current: 2,
        total: 1,
      });
      return { url: "https://zhuanlan.zhihu.com/p/323/edit" };
    },
  });
  try {
    const task = addTask(service);
    await service.dispatch({
      id: 1,
      method: "task.enqueueDraft",
      params: { id: task.id },
    });
    await flush();
    assert.equal(service.store.task(task.id).status, "draft_saved");
    assert.equal(service.store.task(task.id).lastErrorKind, null);
    assert.equal(
      service.store
        .events(task.id)
        .some((event) => event.message === "模拟进度存储失败"),
      false,
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("后台轮询只在计划到期后领取执行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-due-"));
  const clock = new VirtualClock();
  let calls = 0;
  const service = new Service(dir, {
    clock,
    pollIntervalMs: 100,
    draftExecutor: async () => {
      calls += 1;
      return { url: "https://zhuanlan.zhihu.com/p/456/edit" };
    },
  });
  try {
    const task = addTask(
      service,
      undefined,
      new Date(clock.now() + 500).toISOString(),
    );
    clock.advance(499);
    await flush();
    assert.equal(calls, 0);
    assert.equal(service.store.task(task.id).status, "scheduled");
    clock.advance(1);
    await flush();
    assert.equal(calls, 1);
    assert.equal(service.store.task(task.id).status, "draft_saved");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("后台轮询不会自动执行未手动入队的pending任务", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-pending-"));
  const clock = new VirtualClock();
  let calls = 0;
  const service = new Service(dir, {
    clock,
    pollIntervalMs: 100,
    draftExecutor: async () => {
      calls += 1;
      return { url: "https://zhuanlan.zhihu.com/p/457/edit" };
    },
  });
  try {
    const task = addTask(service);
    clock.advance(1_000);
    await flush();
    assert.equal(calls, 0);
    assert.equal(service.store.task(task.id).status, "pending");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("可取消尚未开始的队列任务", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-cancel-"));
  const releases: Array<() => void> = [];
  const called: string[] = [];
  const service = new Service(dir, {
    draftExecutor: async (task) => {
      called.push(task.id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { url: "https://zhuanlan.zhihu.com/p/789/edit" };
    },
  });
  try {
    const tasks = [addTask(service), addTask(service), addTask(service)];
    for (const [index, task] of tasks.entries())
      await service.dispatch({
        id: index,
        method: "task.enqueueDraft",
        params: { id: task.id },
      });
    assert.equal(called.length, 2);
    const canceled = await service.dispatch({
      id: 4,
      method: "task.cancel",
      params: { id: tasks[2]!.id },
    });
    assert.equal(canceled.error, undefined);
    assert.equal(service.store.task(tasks[2]!.id).status, "cancelled");
    while (releases.length) releases.shift()!();
    await flush();
    assert.equal(called.includes(tasks[2]!.id), false);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("远端写入前可取消正在运行的本地阶段", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-cancel-local-"));
  let aborted = false;
  const service = new Service(dir, {
    draftExecutor: async (_task, { signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("local work aborted"));
          },
          { once: true },
        );
      });
      return { url: "https://zhuanlan.zhihu.com/p/unreachable/edit" };
    },
  });
  try {
    const task = addTask(service);
    await service.dispatch({
      id: 1,
      method: "task.enqueueDraft",
      params: { id: task.id },
    });
    assert.equal(service.store.task(task.id).status, "validating");
    const canceled = await service.dispatch({
      id: 2,
      method: "task.cancel",
      params: { id: task.id },
    });
    await flush();
    assert.equal(canceled.error, undefined);
    assert.equal(aborted, true);
    assert.equal(service.store.task(task.id).status, "cancelled");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("进入外部写入后失败映射为人工介入且不重试", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-unknown-"));
  let calls = 0;
  const service = new Service(dir, {
    draftExecutor: async (_task, { markExternalWrite }) => {
      calls += 1;
      markExternalWrite();
      throw new Error("connection lost");
    },
  });
  try {
    const task = addTask(service);
    await service.dispatch({
      id: 1,
      method: "task.enqueueDraft",
      params: { id: task.id },
    });
    await flush();
    assert.equal(service.store.task(task.id).status, "intervention_required");
    assert.match(service.store.task(task.id).message, /禁止自动重试/);
    assert.equal(calls, 1);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("进入外部写入后拒绝取消，不伪装成已取消", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-write-cancel-"));
  let release!: () => void;
  const service = new Service(dir, {
    draftExecutor: async (_task, { markExternalWrite }) => {
      markExternalWrite();
      await new Promise<void>((resolve) => (release = resolve));
      return { url: "https://zhuanlan.zhihu.com/p/790/edit" };
    },
  });
  try {
    const task = addTask(service);
    await service.dispatch({
      id: 1,
      method: "task.enqueueDraft",
      params: { id: task.id },
    });
    const canceled = await service.dispatch({
      id: 2,
      method: "task.cancel",
      params: { id: task.id },
    });
    assert.match(canceled.error?.message ?? "", /远端写入/);
    assert.equal(service.store.task(task.id).status, "publishing");
    release();
    await flush();
    assert.equal(service.store.task(task.id).status, "draft_saved");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Service关闭后停止轮询领取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-close-"));
  const clock = new VirtualClock();
  let calls = 0;
  const service = new Service(dir, {
    clock,
    pollIntervalMs: 100,
    draftExecutor: async () => {
      calls += 1;
      return { url: "https://zhuanlan.zhihu.com/p/999/edit" };
    },
  });
  addTask(service, undefined, new Date(clock.now() + 500).toISOString());
  await service.close();
  clock.advance(1_000);
  await flush();
  assert.equal(calls, 0);
  await rm(dir, { recursive: true, force: true });
});

test("Service关闭会把尚未外部写入的运行任务持久化为已取消", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-close-local-"));
  const service = new Service(dir, {
    draftExecutor: async (_task, { signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("local work aborted")),
          { once: true },
        );
      });
      return { url: "https://zhuanlan.zhihu.com/p/unreachable/edit" };
    },
  });
  const task = addTask(service);
  await service.dispatch({
    id: 1,
    method: "task.enqueueDraft",
    params: { id: task.id },
  });
  assert.equal(service.store.task(task.id).status, "validating");
  await service.close();
  const db = new DatabaseSync(join(dir, "turbopush.sqlite"));
  try {
    const row = db
      .prepare("SELECT status, message FROM tasks WHERE id=?")
      .get(task.id) as { status: string; message: string };
    assert.equal(row.status, "cancelled");
    assert.equal(row.message, "已取消队列任务");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Service关闭等待外部写入落入人工介入终态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-close-write-"));
  let rejectWrite!: (error: Error) => void;
  const service = new Service(dir, {
    draftExecutor: async (_task, { markExternalWrite }) => {
      markExternalWrite();
      await new Promise<void>((_resolve, reject) => (rejectWrite = reject));
      return { url: "https://zhuanlan.zhihu.com/p/unreachable/edit" };
    },
  });
  const task = addTask(service);
  await service.dispatch({
    id: 1,
    method: "task.enqueueDraft",
    params: { id: task.id },
  });
  assert.equal(service.store.task(task.id).status, "publishing");
  const closing = service.close();
  await flush();
  rejectWrite(new Error("connection lost during shutdown"));
  await closing;
  const db = new DatabaseSync(join(dir, "turbopush.sqlite"));
  try {
    const row = db
      .prepare("SELECT status, message, last_error_kind FROM tasks WHERE id=?")
      .get(task.id) as {
      status: string;
      message: string;
      last_error_kind: string;
    };
    assert.equal(row.status, "intervention_required");
    assert.equal(row.last_error_kind, "unknown");
    assert.match(row.message, /禁止自动重试/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retry_wait跨Service重启后到期恢复执行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-retry-restart-"));
  const clock = new VirtualClock();
  const first = new Service(dir, {
    clock,
    pollIntervalMs: 100,
    draftExecutor: async () => {
      throw new QueueFailure("temporary", "retryable");
    },
  });
  const task = addTask(first);
  await first.dispatch({
    id: 1,
    method: "task.enqueueDraft",
    params: { id: task.id },
  });
  await flush();
  assert.equal(first.store.task(task.id).status, "retry_wait");
  assert.equal(first.store.task(task.id).attemptCount, 1);
  await first.close();

  let calls = 0;
  const restarted = new Service(dir, {
    clock,
    pollIntervalMs: 100,
    draftExecutor: async () => {
      calls += 1;
      return { url: "https://zhuanlan.zhihu.com/p/333/edit" };
    },
  });
  try {
    clock.advance(999);
    await flush();
    assert.equal(calls, 0);
    clock.advance(1);
    await flush();
    assert.equal(calls, 1);
    assert.equal(restarted.store.task(task.id).attemptCount, 2);
    assert.equal(restarted.store.task(task.id).status, "draft_saved");
  } finally {
    await restarted.close();
    await rm(dir, { recursive: true, force: true });
  }
});
