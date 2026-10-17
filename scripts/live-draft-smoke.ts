import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Service } from "../packages/publisher-engine/src/service.ts";
import type { TaskEvent } from "../packages/shared/src/index.ts";
import {
  assertNoExistingLiveDraft,
  loadLiveDraftMaterial,
  parseLiveDraftOptions,
  redactLiveOutput,
  validateLiveDraftAccount,
  waitForDraftTerminal,
} from "./live-draft-smoke-lib.ts";

// The smoke runner must only execute the task created below. Keep the normal
// due-task scheduler dormant while this one-shot process owns the data dir;
// explicit task.enqueueDraft does not depend on the polling timer.
const ISOLATED_SMOKE_POLL_MS = 2_147_000_000;

export async function runLiveDraftSmoke(
  args = process.argv.slice(2),
  env = process.env,
) {
  const options = parseLiveDraftOptions(args, env);
  const material = await loadLiveDraftMaterial(options);
  const service = new Service(options.dataDir, {
    pollIntervalMs: ISOLATED_SMOKE_POLL_MS,
  });
  const sensitivePaths = [options.dataDir, options.bodyFile, ...options.images];
  try {
    const account = service.store.account(options.accountId);
    validateLiveDraftAccount(account, options);
    const finalTitle = `[TurboPush LIVE DRAFT] ${options.title}`;
    assertNoExistingLiveDraft(service.store.tasks(), account.id, finalTitle);

    // Reuse the exact account context that the queued executor will use. Delaying
    // every request exercises navigation, image upload and remote verification.
    const context = await service.browsers.open(account);
    await context.route("**/*", async (route) => {
      await new Promise<void>((done) =>
        setTimeout(done, options.networkDelayMs),
      );
      await route.continue();
    });

    const content = service.store.createContent({
      type: "article",
      title: finalTitle,
      body: material.body,
      images: material.images,
      cover: material.images[0],
      summary: "异步多图与慢网络专项验证；仅保存草稿，绝不公开发布。",
    });
    const task = service.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0];
    const enqueue = await service.dispatch({
      id: "enqueue-live-draft",
      method: "task.enqueueDraft",
      params: { id: task.id },
    });
    assert.equal(enqueue.error, undefined, enqueue.error?.message);
    assert.equal(
      (enqueue.result as { accepted: boolean; queued: boolean }).accepted,
      true,
    );
    assert.equal(
      (enqueue.result as { accepted: boolean; queued: boolean }).queued,
      true,
    );

    const result = await waitForDraftTerminal(
      service.dispatch.bind(service),
      task.id,
      options,
    );
    const report = {
      taskId: result.task.id,
      platform: result.task.platform,
      status: result.task.status,
      resultLocation: result.task.resultUrl
        ? new URL(result.task.resultUrl).origin
        : null,
      events: result.events.map((event: TaskEvent) => ({
        status: event.status,
        stage: event.progressStage,
        current: event.progressCurrent,
        total: event.progressTotal,
        message: event.message,
      })),
      published: false,
    };
    console.log(redactLiveOutput(report, sensitivePaths));
    assert.equal(
      result.task.status,
      "draft_saved",
      "真实草稿未进入 draft_saved 终态；禁止自动重试",
    );
  } finally {
    await service.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runLiveDraftSmoke();
