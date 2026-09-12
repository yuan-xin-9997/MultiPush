export type QueueFailureKind = "retryable" | "permanent" | "unknown";
export type QueueTaskState =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "canceled";

export interface QueueClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface QueueStateChange {
  id: string;
  accountId: string;
  state: QueueTaskState;
  attempt: number;
  nextRunAt?: number;
  error?: unknown;
}

export type QueueOutcome<T> =
  | { state: "succeeded"; value: T; attempts: number }
  | { state: "failed"; kind: QueueFailureKind; error: unknown; attempts: number }
  | { state: "canceled"; attempts: number };

export interface QueueTask<T> {
  id: string;
  accountId: string;
  run: (context: { signal: AbortSignal; attempt: number }) => Promise<T>;
  onStateChange?: (change: QueueStateChange) => void;
}

export interface TaskQueueOptions {
  concurrency?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  clock?: QueueClock;
  classifyFailure?: (error: unknown) => QueueFailureKind;
}

export class QueueFailure extends Error {
  readonly kind: QueueFailureKind;

  constructor(
    message: string,
    kind: QueueFailureKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.kind = kind;
    this.name = "QueueFailure";
  }
}

const systemClock: QueueClock = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Entry<T = any> {
  task: QueueTask<T>;
  attempt: number;
  dueAt: number;
  controller?: AbortController;
  settled: boolean;
  resolve: (outcome: QueueOutcome<T>) => void;
}

export class TaskQueue {
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly clock: QueueClock;
  private readonly classify: (error: unknown) => QueueFailureKind;
  private readonly entries = new Map<string, Entry>();
  private readonly waiting: Entry[] = [];
  private readonly busyAccounts = new Set<string>();
  private running = 0;
  private active = false;
  private timer: unknown;

  constructor(options: TaskQueueOptions = {}) {
    this.concurrency = options.concurrency ?? 2;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1)
      throw new Error("队列并发上限必须为正整数");
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0)
      throw new Error("最大重试次数必须为非负整数");
    if (this.retryBaseMs < 0) throw new Error("重试间隔不能为负数");
    this.clock = options.clock ?? systemClock;
    this.classify =
      options.classifyFailure ??
      ((error) =>
        error instanceof QueueFailure ? error.kind : "permanent");
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.pump();
  }

  stop() {
    this.active = false;
    this.clearWakeup();
  }

  enqueue<T>(task: QueueTask<T>): Promise<QueueOutcome<T>> {
    if (this.entries.has(task.id)) throw new Error(`队列任务已存在: ${task.id}`);
    let resolve!: (outcome: QueueOutcome<T>) => void;
    const completion = new Promise<QueueOutcome<T>>((done) => {
      resolve = done;
    });
    const entry: Entry<T> = {
      task,
      attempt: 0,
      dueAt: this.clock.now(),
      settled: false,
      resolve,
    };
    this.entries.set(task.id, entry as Entry);
    this.waiting.push(entry as Entry);
    this.emit(entry, "queued");
    this.pump();
    return completion;
  }

  cancel(id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.settled) return false;
    entry.controller?.abort();
    if (!entry.controller) {
      this.removeWaiting(entry);
      this.finish(entry, { state: "canceled", attempts: entry.attempt });
      this.pump();
    }
    return true;
  }

  has(id: string) {
    return this.entries.has(id);
  }

  private pump() {
    if (!this.active) return;
    this.clearWakeup();
    const now = this.clock.now();
    while (this.running < this.concurrency) {
      const index = this.waiting.findIndex(
        (entry) =>
          entry.dueAt <= now && !this.busyAccounts.has(entry.task.accountId),
      );
      if (index < 0) break;
      const [entry] = this.waiting.splice(index, 1);
      if (entry) this.execute(entry);
    }
    const next = this.waiting
      .filter((entry) => !this.busyAccounts.has(entry.task.accountId))
      .reduce((earliest, entry) => Math.min(earliest, entry.dueAt), Infinity);
    if (next !== Infinity && this.running < this.concurrency)
      this.timer = this.clock.setTimeout(
        () => {
          this.timer = undefined;
          this.pump();
        },
        Math.max(0, next - this.clock.now()),
      );
  }

  private execute(entry: Entry) {
    this.running += 1;
    this.busyAccounts.add(entry.task.accountId);
    entry.attempt += 1;
    entry.controller = new AbortController();
    this.emit(entry, "running");
    void entry.task
      .run({ signal: entry.controller.signal, attempt: entry.attempt })
      .then((value) => {
        if (entry.controller?.signal.aborted)
          this.finish(entry, { state: "canceled", attempts: entry.attempt });
        else
          this.finish(entry, {
            state: "succeeded",
            value,
            attempts: entry.attempt,
          });
      })
      .catch((error: unknown) => {
        if (entry.controller?.signal.aborted) {
          this.finish(entry, { state: "canceled", attempts: entry.attempt });
          return;
        }
        const kind = this.classify(error);
        if (kind === "retryable" && entry.attempt <= this.maxRetries) {
          entry.controller = undefined;
          entry.dueAt =
            this.clock.now() +
            this.retryBaseMs * 2 ** Math.max(0, entry.attempt - 1);
          this.waiting.push(entry);
          this.emit(entry, "retry_wait", error, entry.dueAt);
          return;
        }
        this.finish(entry, {
          state: "failed",
          kind,
          error,
          attempts: entry.attempt,
        });
      })
      .finally(() => {
        this.running -= 1;
        this.busyAccounts.delete(entry.task.accountId);
        if (!entry.settled && entry.controller) entry.controller = undefined;
        this.pump();
      });
  }

  private finish(entry: Entry, outcome: QueueOutcome<unknown>) {
    if (entry.settled) return;
    entry.settled = true;
    this.entries.delete(entry.task.id);
    this.emit(
      entry,
      outcome.state,
      outcome.state === "failed" ? outcome.error : undefined,
    );
    entry.resolve(outcome);
  }

  private emit(
    entry: Entry,
    state: QueueTaskState,
    error?: unknown,
    nextRunAt?: number,
  ) {
    entry.task.onStateChange?.({
      id: entry.task.id,
      accountId: entry.task.accountId,
      state,
      attempt: entry.attempt,
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
      ...(error === undefined ? {} : { error }),
    });
  }

  private removeWaiting(entry: Entry) {
    const index = this.waiting.indexOf(entry);
    if (index >= 0) this.waiting.splice(index, 1);
  }

  private clearWakeup() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
