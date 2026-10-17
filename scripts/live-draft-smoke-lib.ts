import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  Account,
  PlatformId,
  RpcRequest,
  RpcResponse,
  Task,
  TaskEvent,
  TaskStatus,
} from "../packages/shared/src/index.ts";

export const LIVE_DRAFT_ENV = "TURBOPUSH_LIVE_DRAFT_TEST";

export interface LiveDraftOptions {
  platform: Extract<PlatformId, "zhihu" | "wechat-official">;
  accountId: string;
  dataDir: string;
  title: string;
  bodyFile: string;
  images: string[];
  networkDelayMs: number;
  pollMs: number;
  timeoutMs: number;
}

type Dispatch = (request: RpcRequest) => Promise<RpcResponse>;

const usage = `用法：
  TURBOPUSH_LIVE_DRAFT_TEST=1 tsx scripts/live-draft-smoke.ts \\
    --platform <zhihu|wechat-official> --account-id <uuid> \\
    --data-dir <绝对路径> --title <测试标题> --body-file <绝对路径> \\
    --image <绝对路径> --image <绝对路径> --network-delay-ms <100..10000>

此入口只调用 task.enqueueDraft，并轮询 task.events；不会公开发布。`;

function valueAfter(args: string[], index: number, name: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} 缺少参数值\n${usage}`);
  return value;
}

function boundedInteger(
  value: string | undefined,
  name: string,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} 必须是 ${min}..${max} 的整数`);
  return parsed;
}

export function parseLiveDraftOptions(
  args: string[],
  env = process.env,
): LiveDraftOptions {
  if (env[LIVE_DRAFT_ENV] !== "1")
    throw new Error(
      `此脚本会写入真实平台草稿；必须显式设置 ${LIVE_DRAFT_ENV}=1`,
    );

  const values = new Map<string, string>();
  const images: string[] = [];
  const allowed = new Set([
    "--platform",
    "--account-id",
    "--data-dir",
    "--title",
    "--body-file",
    "--image",
    "--network-delay-ms",
    "--poll-ms",
    "--timeout-ms",
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i]!;
    if (!allowed.has(name)) throw new Error(`未知参数：${name}\n${usage}`);
    const value = valueAfter(args, i, name);
    if (name === "--image") images.push(value);
    else {
      if (values.has(name)) throw new Error(`参数不能重复：${name}`);
      values.set(name, value);
    }
    i += 1;
  }

  const required = [
    "--platform",
    "--account-id",
    "--data-dir",
    "--title",
    "--body-file",
    "--network-delay-ms",
  ];
  for (const name of required)
    if (!values.has(name)) throw new Error(`缺少必需参数：${name}\n${usage}`);
  const platform = values.get("--platform");
  if (platform !== "zhihu" && platform !== "wechat-official")
    throw new Error("--platform 仅允许 zhihu 或 wechat-official");
  const accountId = values.get("--account-id")!;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(accountId))
    throw new Error("--account-id 必须是 UUID");
  const dataDir = values.get("--data-dir")!;
  const bodyFile = values.get("--body-file")!;
  if (
    !isAbsolute(dataDir) ||
    !isAbsolute(bodyFile) ||
    images.some((path) => !isAbsolute(path))
  )
    throw new Error("--data-dir、--body-file 和所有 --image 都必须是绝对路径");
  if (images.length < 2 || images.length > 20)
    throw new Error("多图专项要求显式提供 2..20 个 --image 参数");
  const title = values.get("--title")!.trim();
  if (!title) throw new Error("--title 不能为空");

  return {
    platform,
    accountId,
    dataDir: resolve(dataDir),
    title,
    bodyFile: resolve(bodyFile),
    images: images.map((path) => resolve(path)),
    networkDelayMs: boundedInteger(
      values.get("--network-delay-ms"),
      "--network-delay-ms",
      100,
      10_000,
    ),
    pollMs: boundedInteger(
      values.get("--poll-ms") ?? "1000",
      "--poll-ms",
      250,
      5_000,
    ),
    timeoutMs: boundedInteger(
      values.get("--timeout-ms") ?? "1200000",
      "--timeout-ms",
      30_000,
      1_800_000,
    ),
  };
}

export async function loadLiveDraftMaterial(options: LiveDraftOptions) {
  await Promise.all(options.images.map((path) => access(path)));
  const body = (await readFile(options.bodyFile, "utf8")).trim();
  if (!body) throw new Error("--body-file 内容不能为空");
  return { body, images: options.images };
}

export function validateLiveDraftAccount(
  account: Account,
  options: Pick<LiveDraftOptions, "accountId" | "platform">,
) {
  if (account.id !== options.accountId)
    throw new Error("读取到的账号与显式 --account-id 不匹配");
  if (account.platform !== options.platform)
    throw new Error("账号与显式 --platform 不匹配");
  if (account.loginStatus !== "authenticated")
    throw new Error("指定账号必须已通过登录检查（authenticated）");
}

export function assertNoExistingLiveDraft(
  tasks: readonly Task[],
  accountId: string,
  finalTitle: string,
) {
  const existing = tasks.find(
    (task) => task.accountId === accountId && task.content.title === finalTitle,
  );
  if (existing)
    throw new Error(
      `该账号已有同标题真实草稿任务（${existing.status}）；禁止自动重跑，请先人工核对草稿箱，确认后使用全新 --title`,
    );
}

const terminalStatuses = new Set<TaskStatus>([
  "draft_saved",
  "failed",
  "intervention_required",
  "cancelled",
  "succeeded",
]);

export async function waitForDraftTerminal(
  dispatch: Dispatch,
  taskId: string,
  options: {
    pollMs: number;
    timeoutMs: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
) {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  let events: TaskEvent[] = [];
  while (now() <= deadline) {
    const eventResponse = await dispatch({
      id: `events-${now()}`,
      method: "task.events",
      params: { id: taskId },
    });
    if (eventResponse.error)
      throw new Error(`task.events 失败：${eventResponse.error.message}`);
    events = eventResponse.result as TaskEvent[];
    const snapshotResponse = await dispatch({
      id: `snapshot-${now()}`,
      method: "snapshot",
    });
    if (snapshotResponse.error)
      throw new Error(`snapshot 失败：${snapshotResponse.error.message}`);
    const task = (snapshotResponse.result as { tasks: Task[] }).tasks.find(
      (item) => item.id === taskId,
    );
    if (!task) throw new Error("轮询时任务不存在");
    if (terminalStatuses.has(task.status)) return { task, events };
    await sleep(options.pollMs);
  }
  throw new Error(
    `等待异步草稿终态超时（${options.timeoutMs}ms）；不会自动重试或发布`,
  );
}

export function redactLiveOutput(
  value: unknown,
  sensitivePaths: readonly string[] = [],
) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const path of sensitivePaths
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(path, "<local-path>");
    text = text.replaceAll(JSON.stringify(path).slice(1, -1), "<local-path>");
  }
  return text
    .replace(/https?:\/\/[^\s"']+/g, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "<redacted-url>";
      }
    })
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, (id) => `${id.slice(0, 8)}…`)
    .replace(
      /\b(token|access_token|authorization|cookie)=([^\s&"']+)/gi,
      "$1=<redacted>",
    );
}
