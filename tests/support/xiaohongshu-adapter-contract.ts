import assert from "node:assert/strict";

export interface XiaohongshuContractAdapter {
  validateDraftUrl(url: string): string;
  saveDraft(input: {
    images: readonly string[];
    checkpoint?: string;
    checkpointDraft: (url: string) => void;
  }): Promise<{ url: string; verified: boolean }>;
  events: readonly string[];
}

export type XiaohongshuContractFactory = () => XiaohongshuContractAdapter;

/**
 * Reusable acceptance suite for a future real adapter. URLs are fixture-only;
 * a real adapter factory should map these cases to its probed canonical route.
 */
export async function verifyXiaohongshuAdapterContract(
  create: XiaohongshuContractFactory,
  fixtureUrl: string,
) {
  const urlAdapter = create();
  assert.equal(urlAdapter.validateDraftUrl(fixtureUrl), fixtureUrl);
  for (const unsafe of [
    `${fixtureUrl}?token=secret`,
    `${fixtureUrl}#fragment`,
    fixtureUrl.replace("https://", "https://user:password@"),
    fixtureUrl.replace("creator.xiaohongshu.com", "evil.example"),
    fixtureUrl.replace(
      "creator.xiaohongshu.com",
      "creator.xiaohongshu.com.evil.example",
    ),
  ])
    assert.throws(() => urlAdapter.validateDraftUrl(unsafe));

  const createAdapter = create();
  let checkpoint = "";
  const images = ["01.png", "02.jpg", "03.png"];
  const first = await createAdapter.saveDraft({
    images,
    checkpointDraft: (url) => (checkpoint = url),
  });
  assert.equal(first.verified, true);
  assert.equal(checkpoint, fixtureUrl);
  assert.deepEqual(
    createAdapter.events.filter((event) => event.startsWith("upload:")),
    images.map((image) => `upload:${image}`),
  );
  assert.equal(
    createAdapter.events.some((event) => event === "click:publish"),
    false,
  );
  assert.ok(
    createAdapter.events.indexOf("checkpoint") <
      createAdapter.events.indexOf("verify"),
  );

  const retryAdapter = create();
  const retried = await retryAdapter.saveDraft({
    images,
    checkpoint,
    checkpointDraft: () => assert.fail("重试回读不得建立新checkpoint"),
  });
  assert.equal(retried.verified, true);
  assert.deepEqual(retryAdapter.events, ["open:checkpoint", "verify"]);
}
