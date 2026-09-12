import test from "node:test";
import assert from "node:assert/strict";
import type {
  Task,
  TaskEvent,
  TaskStatus,
} from "../packages/shared/src/index.ts";
import {
  chronologicalEvents,
  queueSummary,
} from "../apps/desktop/src/task-presentation.ts";

function task(status: TaskStatus): Task {
  return { status } as Task;
}

test("队列汇总区分等待、执行、需处理和完成，不计入未入队任务", () => {
  assert.deepEqual(
    queueSummary([
      task("pending"),
      task("scheduled"),
      task("retry_wait"),
      task("validating"),
      task("publishing"),
      task("intervention_required"),
      task("failed"),
      task("draft_saved"),
      task("succeeded"),
      task("cancelled"),
    ]),
    { waiting: 2, active: 2, attention: 2, completed: 2 },
  );
});

test("任务事件按时间和事件ID稳定排序且不修改RPC原数组", () => {
  const events = [
    { id: 3, createdAt: "2026-09-12T02:00:00.000Z" },
    { id: 2, createdAt: "2026-09-12T01:00:00.000Z" },
    { id: 1, createdAt: "2026-09-12T01:00:00.000Z" },
  ] as TaskEvent[];
  assert.deepEqual(
    chronologicalEvents(events).map((event) => event.id),
    [1, 2, 3],
  );
  assert.deepEqual(
    events.map((event) => event.id),
    [3, 2, 1],
  );
});
