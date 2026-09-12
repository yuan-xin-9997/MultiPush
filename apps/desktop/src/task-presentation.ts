import type { Task, TaskEvent } from "@turbopush/shared";

export function queueSummary(tasks: Task[]) {
  return {
    waiting: tasks.filter((task) =>
      ["scheduled", "retry_wait"].includes(task.status),
    ).length,
    active: tasks.filter((task) =>
      ["validating", "publishing"].includes(task.status),
    ).length,
    attention: tasks.filter((task) =>
      ["intervention_required", "failed"].includes(task.status),
    ).length,
    completed: tasks.filter((task) =>
      ["draft_saved", "succeeded"].includes(task.status),
    ).length,
  };
}

export function chronologicalEvents(events: TaskEvent[]) {
  return [...events].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.id - right.id,
  );
}
