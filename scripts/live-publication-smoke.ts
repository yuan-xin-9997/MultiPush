import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Snapshot, Task } from "../packages/shared/src/index.ts";

export function publicationCommand(
  args: string[],
  liveFlag: string | undefined,
) {
  if (args.length !== 2)
    throw new Error(
      "用法：live-publication-smoke.ts inspect|prepare|stage|restage|draft|repair|publish|verify|review zhihu|wechat-official|xiaohongshu",
    );
  const [mode, platform] = args;
  if (
    ![
      "inspect",
      "prepare",
      "stage",
      "restage",
      "verify",
      "review",
      "draft",
      "repair",
      "publish",
    ].includes(mode) ||
    !["zhihu", "wechat-official", "xiaohongshu"].includes(platform)
  )
    throw new Error("无效的验收模式或平台");
  if (mode !== "inspect" && liveFlag !== "1")
    throw new Error(
      "必须显式设置 TURBOPUSH_LIVE_PUBLICATION_TEST=1；draft/publish 会写入真实平台",
    );
  return { mode, platform };
}

async function main() {
  const { mode, platform } = publicationCommand(
    process.argv.slice(2),
    process.env.TURBOPUSH_LIVE_PUBLICATION_TEST,
  );
  const port = Number(process.env.TURBOPUSH_PORT ?? 34080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口无效");
  const base = `http://127.0.0.1:${port}`;
  async function rpc<T>(method: string, params?: unknown): Promise<T> {
    const response = await fetch(`${base}/__rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ id: crypto.randomUUID(), method, params }),
      signal: AbortSignal.timeout(180_000),
    });
    const data = await response.json();
    if (!response.ok || data.error)
      throw new Error(data.error?.message ?? `HTTP ${response.status}`);
    return data.result as T;
  }
  const fixturePath = resolve(
    process.env.TURBOPUSH_PUBLICATION_FIXTURE ??
      "test-results/publication-fixture.json",
  );
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    batch: string;
    images: string[];
    body: string;
    titles?: Record<string, string>;
    accounts: Record<string, string>;
    tasks?: Record<string, string>;
  };
  const accountId = fixture.accounts[platform];
  if (
    !accountId ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(accountId)
  )
    throw new Error("测试账号ID无效");
  if (mode === "inspect") {
    await rpc("account.open", { id: accountId });
    console.log(
      JSON.stringify(
        await rpc("diagnostics.inspect", { id: accountId }),
        null,
        2,
      ),
    );
    return;
  }
  const snapshot = await rpc<Snapshot>("snapshot");
  if (
    !snapshot.accounts.some(
      (account) => account.id === accountId && account.platform === platform,
    )
  )
    throw new Error("账号与平台不匹配");
  const title =
    fixture.titles?.[platform] ??
    `【开发测试】TurboPush图文发布验收 ${fixture.batch}`;
  if (!title.startsWith("【开发测试】"))
    throw new Error("验收标题必须明确标注开发测试");
  let task = fixture.tasks?.[platform]
    ? snapshot.tasks.find((task) => task.id === fixture.tasks![platform])
    : undefined;
  if (mode === "prepare" && !task) {
    if (
      snapshot.tasks.some(
        (task) => task.accountId === accountId && task.content.title === title,
      )
    )
      throw new Error(
        "同标题任务已存在但未记录在fixture中，请人工核对，禁止重复创建",
      );
    const content = await rpc<{ id: string }>("content.create", {
      type: platform === "xiaohongshu" ? "gallery" : "article",
      title,
      body: fixture.body,
      images: fixture.images,
      tags: [],
      ...(platform === "wechat-official" ? { cover: fixture.images[0] } : {}),
    });
    [task] = await rpc<Task[]>("campaign.create", {
      contentId: content.id,
      accountIds: [accountId],
    });
    fixture.tasks ??= {};
    fixture.tasks[platform] = task.id;
    await writeFile(fixturePath, JSON.stringify(fixture, null, 2));
  }
  if (
    !task ||
    task.accountId !== accountId ||
    task.platform !== platform ||
    task.content.title !== title
  )
    throw new Error("缺少对应开发测试任务；先执行prepare，并核对任务快照");
  if (mode === "prepare") {
    console.log(
      JSON.stringify({ platform, taskId: task.id, status: task.status, title }),
    );
    return;
  }
  const taskId = task.id;
  try {
    if (mode === "review") {
      task = await rpc<Task>("task.confirmPublicationReview", {
        id: taskId,
        accountId,
        title,
        confirmed: true,
      });
    } else if (mode === "verify") {
      task = await rpc<Task>("task.verifyPublication", {
        id: taskId,
        accountId,
        ...(process.env.TURBOPUSH_PUBLICATION_URL
          ? { url: process.env.TURBOPUSH_PUBLICATION_URL }
          : {}),
      });
    } else if (mode === "stage" || mode === "restage") {
      if (
        platform !== "xiaohongshu" ||
        (mode === "restage"
          ? task.status !== "intervention_required"
          : task.status !== "pending")
      )
        throw new Error("准备发布仅接受从未尝试的小红书图文任务");
      task = await rpc<Task>("task.preparePublish", {
        id: taskId,
        accountId,
        title,
        confirmed: true,
        ...(mode === "restage" ? { restore: true } : {}),
      });
    } else if (mode === "draft") {
      if (task.status !== "pending")
        throw new Error("草稿验证只接受从未尝试的新任务；禁止自动重试");
      task = await rpc<Task>("task.saveDraft", { id: taskId });
    } else if (mode === "repair") {
      if (platform !== "zhihu" || !task.resultUrl)
        throw new Error("仅允许修复已记录ID的知乎开发测试草稿");
      task = await rpc<Task>("task.repairDraft", {
        id: taskId,
        accountId,
        title,
        confirmed: true,
      });
    } else {
      if (!["draft_saved", "publication_ready"].includes(task.status))
        throw new Error("仅接受已回读通过的草稿，未知结果禁止重试");
      task = await rpc<Task>("task.publish", {
        id: taskId,
        accountId,
        title,
        confirmed: true,
      });
    }
    console.log(
      JSON.stringify({
        platform,
        taskId,
        status: task.status,
        resultUrl: task.resultUrl,
      }),
    );
  } finally {
    const current = (await rpc<Snapshot>("snapshot")).tasks.find(
      (task) => task.id === taskId,
    );
    const evidence = {
      platform,
      taskId,
      status: current?.status,
      resultUrl: current?.resultUrl,
      message: current?.message,
      events: await rpc("task.events", { id: taskId }),
      pages: await rpc("diagnostics.inspect", { id: accountId }).catch(
        () => [],
      ),
      network: await rpc("diagnostics.network", { id: accountId }).catch(
        () => [],
      ),
      screenshot: await rpc("diagnostics.capture", { id: accountId }).catch(
        () => null,
      ),
    };
    await writeFile(
      resolve(
        `test-results/publication-${fixture.batch}-${platform}-${mode}.json`,
      ),
      JSON.stringify(evidence, null, 2),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
