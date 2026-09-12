import test from "node:test";
import assert from "node:assert/strict";
import {
  QueueFailure,
  TaskQueue,
  type QueueClock,
} from "../packages/publisher-engine/src/task-queue.ts";

class VirtualClock implements QueueClock {
  time = 0;
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
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

test("默认全局并发2且同账号严格串行", async () => {
  const queue = new TaskQueue();
  queue.start();
  let running = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const order: string[] = [];
  const add = (id: string, accountId: string) =>
    queue.enqueue({
      id,
      accountId,
      run: () =>
        new Promise<void>((resolve) => {
          running += 1;
          peak = Math.max(peak, running);
          order.push(id);
          releases.push(() => {
            running -= 1;
            resolve();
          });
        }),
    });
  const a1 = add("a1", "a");
  const a2 = add("a2", "a");
  const b1 = add("b1", "b");
  const c1 = add("c1", "c");
  assert.deepEqual(order, ["a1", "b1"]);
  releases.shift()!();
  await flush();
  assert.deepEqual(order, ["a1", "b1", "a2"]);
  releases.shift()!();
  await flush();
  assert.deepEqual(order, ["a1", "b1", "a2", "c1"]);
  while (releases.length) {
    releases.shift()!();
    await flush();
  }
  await Promise.all([a1, a2, b1, c1]);
  assert.equal(peak, 2);
});

test("停止时不启动新任务，重新启动后继续", async () => {
  const queue = new TaskQueue();
  let calls = 0;
  const done = queue.enqueue({
    id: "paused",
    accountId: "a",
    run: async () => ++calls,
  });
  await flush();
  assert.equal(calls, 0);
  queue.start();
  assert.equal((await done).state, "succeeded");
  queue.stop();
});

test("等待任务直接取消，运行任务收到AbortSignal", async () => {
  const queue = new TaskQueue({ concurrency: 1 });
  queue.start();
  const running = queue.enqueue({
    id: "running",
    accountId: "a",
    run: ({ signal }) =>
      new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  });
  const pending = queue.enqueue({
    id: "pending",
    accountId: "b",
    run: async () => assert.fail("取消任务不应执行"),
  });
  assert.equal(queue.cancel("pending"), true);
  assert.deepEqual(await pending, { state: "canceled", attempts: 0 });
  assert.equal(queue.cancel("running"), true);
  assert.deepEqual(await running, { state: "canceled", attempts: 1 });
  assert.equal(queue.cancel("missing"), false);
});

test("可重试失败最多退避2次，间隔为1秒和2秒", async () => {
  const clock = new VirtualClock();
  const states: Array<{ state: string; nextRunAt?: number }> = [];
  const attempts: number[] = [];
  const queue = new TaskQueue({ clock });
  queue.start();
  const done = queue.enqueue({
    id: "retry",
    accountId: "a",
    onStateChange: ({ state, nextRunAt }) => states.push({ state, nextRunAt }),
    run: async ({ attempt }) => {
      attempts.push(attempt);
      if (attempt < 3) throw new QueueFailure("temporary", "retryable");
      return "ok";
    },
  });
  await flush();
  assert.deepEqual(attempts, [1]);
  assert.equal(states.at(-1)?.nextRunAt, 1_000);
  clock.advance(999);
  await flush();
  assert.deepEqual(attempts, [1]);
  clock.advance(1);
  await flush();
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(states.at(-1)?.nextRunAt, 3_000);
  clock.advance(2_000);
  await flush();
  assert.deepEqual(await done, { state: "succeeded", value: "ok", attempts: 3 });
});

test("结果未知和永久失败从不自动重试", async () => {
  for (const kind of ["unknown", "permanent"] as const) {
    const clock = new VirtualClock();
    const queue = new TaskQueue({ clock });
    queue.start();
    let calls = 0;
    const error = new QueueFailure("write outcome", kind);
    const done = queue.enqueue({
      id: kind,
      accountId: "a",
      run: async () => {
        calls += 1;
        throw error;
      },
    });
    await flush();
    clock.advance(60_000);
    await flush();
    const outcome = await done;
    assert.equal(outcome.state, "failed");
    if (outcome.state === "failed") assert.equal(outcome.kind, kind);
    assert.equal(calls, 1);
  }
});
