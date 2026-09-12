import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  douyinBrowserRuntime,
  douyinVideoUploadUrl,
  saveDouyinDraft,
  validateDouyinDraftUrl,
  type DouyinDraftRuntime,
} from "../packages/publisher-engine/src/platforms/douyin/draft.ts";

const mp4Header = Buffer.from([
  0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109,
]);

test("抖音持久草稿结果地址只接受无参数的创作平台上传路径", () => {
  assert.equal(
    validateDouyinDraftUrl(douyinVideoUploadUrl),
    douyinVideoUploadUrl,
  );
  for (const url of [
    "https://evil.example/creator-micro/content/upload",
    "https://creator.douyin.com/creator-micro/content/upload?token=x",
    "https://creator.douyin.com/creator-micro/content/post/video?enter_from=upload",
    "https://creator.douyin.com/creator-micro/content/post/video#token",
    "https://user:password@creator.douyin.com/creator-micro/content/post/video",
    "https://creator.douyin.com/creator-micro/content/publish",
  ])
    assert.throws(() => validateDouyinDraftUrl(url), /无效/);
});

test("正式adapter仅执行私密暂存并在继续编辑中全字段回读", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-draft-"));
  try {
    const video = join(dir, "video.mp4");
    await writeFile(video, mp4Header);
    const calls: string[] = [];
    const progress: string[] = [];
    let findCount = 0;
    const runtime: DouyinDraftRuntime = {
      find: async () => {
        calls.push("find");
        return ++findCount === 2;
      },
      populate: async (_page, content) => {
        calls.push(
          `populate:${content.title}:${content.body}:${content.video}`,
        );
      },
      makePrivate: async () => {
        calls.push("private:data-checked=true");
      },
      saveDraft: async () => {
        calls.push("draft:暂存离开");
      },
      settle: async () => {
        calls.push("settle");
      },
      confirmStored: async () => {
        calls.push("confirm:继续编辑入口恢复");
      },
    };
    const result = await saveDouyinDraft(
      { newPage: async () => ({}) as Page },
      {
        type: "video",
        title: "标题",
        body: "正文",
        bodyFormat: "plain",
        images: [],
        video,
        tags: [],
      },
      runtime,
      (event) => progress.push(event.stage),
    );
    assert.deepEqual(calls, [
      "find",
      `populate:标题:正文:${video}`,
      "private:data-checked=true",
      "draft:暂存离开",
      "settle",
      "find",
    ]);
    assert.deepEqual(result, {
      url: douyinVideoUploadUrl,
      verified: true,
      reused: false,
    });
    assert.deepEqual(progress, [
      "session",
      "upload",
      "fields",
      "privacy",
      "save",
      "verify",
    ]);
    assert.equal(
      calls.some((call) => call.includes("公开发布")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("文案完全匹配但视频身份不可验证时保守拒绝复用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-reuse-"));
  try {
    const video = join(dir, "video.mp4");
    await writeFile(video, mp4Header);
    const calls: string[] = [];
    const runtime: DouyinDraftRuntime = {
      find: async () => {
        calls.push("find:继续编辑并逐字段回读");
        return true;
      },
      populate: async () => {
        calls.push("upload");
      },
      makePrivate: async () => {
        calls.push("private");
      },
      saveDraft: async () => {
        calls.push("draft:暂存离开");
      },
      settle: async () => {
        calls.push("settle");
      },
      confirmStored: async () => {
        calls.push("confirm:继续编辑入口恢复");
      },
    };
    await assert.rejects(
      () =>
        saveDouyinDraft(
          { newPage: async () => ({}) as Page },
          {
            type: "video",
            title: "同标题",
            body: "完全相同正文",
            bodyFormat: "plain",
            images: [],
            video,
            tags: [],
          },
          runtime,
        ),
      /不提供可靠的视频身份.*拒绝自动复用/,
    );
    assert.deepEqual(calls, ["find:继续编辑并逐字段回读"]);
    assert.equal(calls.includes("upload"), false);
    assert.equal(
      calls.some((call) => call.includes("发布")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("同标题但字段不匹配时拒绝覆盖且不进入任何写入步骤", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-mismatch-"));
  try {
    const video = join(dir, "video.mp4");
    await writeFile(video, mp4Header);
    const writes: string[] = [];
    const runtime: DouyinDraftRuntime = {
      find: async () => {
        throw new Error(
          "抖音已有未完成草稿与当前内容不一致，请人工核对；禁止覆盖",
        );
      },
      populate: async () => {
        writes.push("upload");
      },
      makePrivate: async () => {
        writes.push("private");
      },
      saveDraft: async () => {
        writes.push("draft");
      },
      settle: async () => {
        writes.push("settle");
      },
      confirmStored: async () => {
        writes.push("confirm");
      },
    };
    await assert.rejects(
      () =>
        saveDouyinDraft(
          { newPage: async () => ({}) as Page },
          {
            type: "video",
            title: "同标题",
            body: "不同正文",
            bodyFormat: "plain",
            images: [],
            video,
            tags: [],
          },
          runtime,
        ),
      /不一致.*禁止覆盖/,
    );
    assert.deepEqual(writes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("暂存后回读失败报告结果未知且不尝试公开发布", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-unknown-"));
  try {
    const video = join(dir, "video.mp4");
    await writeFile(video, mp4Header);
    const calls: string[] = [];
    const runtime: DouyinDraftRuntime = {
      find: async () => {
        calls.push("find");
        return false;
      },
      populate: async () => {
        calls.push("populate");
      },
      makePrivate: async () => {
        calls.push("private");
      },
      saveDraft: async () => {
        calls.push("draft");
      },
      settle: async () => {
        calls.push("settle");
      },
      confirmStored: async () => {
        calls.push("confirm");
      },
    };
    await assert.rejects(
      () =>
        saveDouyinDraft(
          { newPage: async () => ({}) as Page },
          {
            type: "video",
            title: "标题",
            body: "正文",
            bodyFormat: "plain",
            images: [],
            video,
            tags: [],
          },
          runtime,
        ),
      /结果未知.*禁止自动重试/,
    );
    assert.deepEqual(calls, [
      "find",
      "populate",
      "private",
      "draft",
      "settle",
      "find",
    ]);
    assert.equal(
      calls.some((call) => call.includes("发布")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("生产runtime点击私密项外层label，且保存只点击暂存离开不点击发布", async () => {
  const clicks: string[] = [];
  const privateText = {
    count: async () => 1,
    click: async () => {
      throw new Error("内层文字被 label 拦截，不应直接点击");
    },
    locator: (selector: string) => {
      assert.equal(selector, "xpath=ancestor::label[1]");
      return {
        count: async () => 1,
        click: async () => {
          clicks.push("private-label");
        },
      };
    },
  };
  const checked = { filter: () => ({ count: async () => 1 }) };
  const buttons = {
    发布: {
      count: async () => 1,
      click: async () => {
        clicks.push("公开发布");
      },
    },
    暂存离开: {
      count: async () => 1,
      click: async () => {
        clicks.push("暂存离开");
      },
    },
  };
  const page = {
    url: () => "https://creator.douyin.com/creator-micro/content/post/video",
    getByText: (text: string) => {
      assert.equal(text, "仅自己可见");
      return privateText;
    },
    getByRole: (_role: string, options: { name: keyof typeof buttons }) =>
      buttons[options.name],
    locator: (selector: string) => {
      assert.equal(selector, '[data-checked="true"]');
      return checked;
    },
  } as unknown as Page;
  await douyinBrowserRuntime.makePrivate(page);
  await douyinBrowserRuntime.saveDraft(page);
  assert.deepEqual(clicks, ["private-label", "暂存离开"]);
});

function resumedDraftPage(options: {
  body?: string;
  readError?: boolean;
  recoveryFails?: boolean;
}) {
  let url = douyinVideoUploadUrl;
  const clicks: string[] = [];
  const resume = {
    waitFor: async () => undefined,
    count: async () => 1,
    click: async () => {
      clicks.push("继续编辑");
      url =
        "https://creator.douyin.com/creator-micro/content/post/video?enter_from=upload";
    },
  };
  const title = {
    first() {
      return this;
    },
    waitFor: async () => {
      if (options.readError) throw new Error("编辑器结构变化");
    },
    inputValue: async () => "标题",
  };
  const body = {
    first() {
      return this;
    },
    waitFor: async () => undefined,
    inputValue: async () => options.body ?? "正文",
    innerText: async () => options.body ?? "正文",
  };
  const checked = { filter: () => ({ count: async () => 1 }) };
  const publish = {
    count: async () => 1,
    click: async () => clicks.push("公开发布"),
  };
  const draft = {
    count: async () => (options.recoveryFails ? 0 : 1),
    click: async () => {
      clicks.push("暂存离开");
      url = douyinVideoUploadUrl;
    },
  };
  const page = {
    goto: async () => {
      url = douyinVideoUploadUrl;
    },
    url: () => url,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    getByText: (text: string) => {
      assert.equal(text, "继续编辑");
      return resume;
    },
    getByRole: (_role: string, value: { name: string }) =>
      value.name === "发布" ? publish : draft,
    locator: (selector: string) => {
      if (selector.includes("input[placeholder")) return title;
      if (selector.includes("textarea[placeholder")) return body;
      if (selector === '[data-checked="true"]') return checked;
      throw new Error(`unexpected locator: ${selector}`);
    },
  } as unknown as Page;
  return { page, clicks };
}

test("生产find字段不匹配时先重新暂存确认，再保守拒绝覆盖", async () => {
  const { page, clicks } = resumedDraftPage({ body: "另一正文" });
  await assert.rejects(
    () =>
      douyinBrowserRuntime.find(page, {
        type: "video",
        title: "标题",
        body: "正文",
        bodyFormat: "plain",
        images: [],
        video: "C:\\video.mp4",
        tags: [],
      }),
    /原草稿已重新暂存并确认.*禁止覆盖/,
  );
  assert.deepEqual(clicks, ["继续编辑", "暂存离开"]);
  assert.equal(clicks.includes("公开发布"), false);
});

test("生产find回读异常时仍重新暂存确认，并报告已恢复", async () => {
  const { page, clicks } = resumedDraftPage({ readError: true });
  await assert.rejects(
    () =>
      douyinBrowserRuntime.find(page, {
        type: "video",
        title: "标题",
        body: "正文",
        bodyFormat: "plain",
        images: [],
        video: "C:\\video.mp4",
        tags: [],
      }),
    /回读失败.*已重新暂存并确认.*未公开发布/,
  );
  assert.deepEqual(clicks, ["继续编辑", "暂存离开"]);
});

test("生产find无法恢复已消费草稿时报告远端状态未知且绝不发布", async () => {
  const { page, clicks } = resumedDraftPage({
    body: "另一正文",
    recoveryFails: true,
  });
  await assert.rejects(
    () =>
      douyinBrowserRuntime.find(page, {
        type: "video",
        title: "标题",
        body: "正文",
        bodyFormat: "plain",
        images: [],
        video: "C:\\video.mp4",
        tags: [],
      }),
    /重新暂存并确认恢复失败.*状态未知.*禁止自动重试或公开发布/,
  );
  assert.deepEqual(clicks, ["继续编辑"]);
  assert.equal(clicks.includes("公开发布"), false);
});
