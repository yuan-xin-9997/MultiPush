import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyXiaohongshuAdapterContract,
  type XiaohongshuContractAdapter,
} from "./support/xiaohongshu-adapter-contract.ts";
import {
  QueueFailure,
  TaskQueue,
} from "../packages/publisher-engine/src/task-queue.ts";

// This path is deliberately a local contract fixture, not a claim about the
// current Xiaohongshu production route. Real routes require read-only probing.
const fixtureUrl = "https://creator.xiaohongshu.com/__fixture__/draft/123";

class ReferenceAdapter implements XiaohongshuContractAdapter {
  events: string[] = [];
  validateDraftUrl(value: string) {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "creator.xiaohongshu.com" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !/^\/__fixture__\/draft\/\d+$/.test(parsed.pathname) ||
      parsed.href !== `https://creator.xiaohongshu.com${parsed.pathname}`
    )
      throw new Error("不安全的小红书草稿地址");
    return parsed.href;
  }
  async saveDraft(input: {
    images: readonly string[];
    checkpoint?: string;
    checkpointDraft: (url: string) => void;
  }) {
    if (input.checkpoint) {
      const url = this.validateDraftUrl(input.checkpoint);
      this.events.push("open:checkpoint", "verify");
      return { url, verified: true };
    }
    for (const image of input.images) {
      await Promise.resolve();
      this.events.push(`upload:${image}`);
    }
    // Saving a draft and publishing are separate capabilities. The contract
    // intentionally exposes no public-publish operation.
    this.events.push("click:save-draft");
    input.checkpointDraft(fixtureUrl);
    this.events.push("checkpoint", "verify");
    return { url: fixtureUrl, verified: true };
  }
}

test("未来小红书adapter必须满足URL、顺序、草稿与checkpoint幂等契约", async () => {
  await verifyXiaohongshuAdapterContract(
    () => new ReferenceAdapter(),
    fixtureUrl,
  );
});

test("外部写入结果未知时调度层不得自动重试", async () => {
  let attempts = 0;
  const queue = new TaskQueue();
  queue.start();
  const result = await queue.enqueue({
    id: "xiaohongshu-unknown",
    accountId: "fixture-account",
    run: async () => {
      attempts += 1;
      throw new QueueFailure("unknown external outcome", "unknown");
    },
  });
  assert.equal(result.state, "failed");
  if (result.state === "failed") assert.equal(result.kind, "unknown");
  assert.equal(attempts, 1);
});
