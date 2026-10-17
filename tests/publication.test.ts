import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Service,
  type ServiceOptions,
} from "../packages/publisher-engine/src/service.ts";
import { validateZhihuPublishedUrl } from "../packages/publisher-engine/src/platforms/zhihu/publish.ts";

async function fixture(
  executor: ServiceOptions["publishExecutor"],
  action: (
    service: Service,
    params: { id: string; accountId: string; title: string; confirmed: true },
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-publication-"));
  const service = new Service(directory, { publishExecutor: executor });
  try {
    const account = service.store.createAccount({
      platform: "zhihu",
      name: "公开测试账号",
    });
    const content = service.store.createContent({
      type: "article",
      title: "开发测试文章",
      body: "开发测试正文",
    });
    const task = service.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0];
    service.store.checkpointDraft(
      task.id,
      "https://zhuanlan.zhihu.com/p/12345/edit",
    );
    service.store.transition(task.id, "draft_saved", "测试草稿已回读");
    await action(service, {
      id: task.id,
      accountId: account.id,
      title: content.title,
      confirmed: true,
    });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const call = (service: Service, params: unknown) =>
  service.dispatch({ id: 1, method: "task.publish", params });

test("公开发布必须确认相同账号和任务快照标题；缺少确认零调用", async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      throw Error("不应调用");
    },
    async (service, params) => {
      for (const invalid of [
        { ...params, confirmed: false },
        { ...params, title: "另一篇" },
        { ...params, accountId: "00000000-0000-4000-8000-000000000000" },
      ]) {
        assert.ok((await call(service, invalid)).error);
      }
      assert.equal(calls, 0);
      assert.equal(service.store.task(params.id).status, "draft_saved");
    },
  );
});

test("提交前失败保留草稿；已提交失败进入人工介入且禁止重试", async () => {
  for (const submitted of [false, true]) {
    let calls = 0;
    await fixture(
      async (_task, markSubmitted) => {
        calls++;
        if (submitted) markSubmitted();
        throw Error("超时");
      },
      async (service, params) => {
        assert.ok((await call(service, params)).error);
        assert.equal(
          service.store.task(params.id).status,
          submitted ? "intervention_required" : "draft_saved",
        );
        if (submitted) {
          assert.ok((await call(service, params)).error);
          assert.equal(calls, 1);
        }
      },
    );
  }
});

test("回读成功才记succeeded，记录同ID公开链接并拒绝重复发布", async () => {
  let calls = 0;
  await fixture(
    async (_task, markSubmitted) => {
      calls++;
      markSubmitted();
      return { url: "https://zhuanlan.zhihu.com/p/12345" };
    },
    async (service, params) => {
      assert.equal((await call(service, params)).error, undefined);
      assert.equal(service.store.task(params.id).status, "succeeded");
      assert.equal(
        service.store.task(params.id).resultUrl,
        "https://zhuanlan.zhihu.com/p/12345",
      );
      assert.ok((await call(service, params)).error);
      assert.equal(calls, 1);
    },
  );
});

test("适配器未标记提交或回传其他文章地址均不能假报成功", async () => {
  for (const marked of [false, true]) {
    await fixture(
      async (_task, markSubmitted) => {
        if (marked) markSubmitted();
        return { url: "https://zhuanlan.zhihu.com/p/999" };
      },
      async (service, params) => {
        assert.ok((await call(service, params)).error);
        assert.notEqual(service.store.task(params.id).status, "succeeded");
        assert.equal(
          service.store.task(params.id).resultUrl,
          "https://zhuanlan.zhihu.com/p/12345/edit",
        );
      },
    );
  }
});

test("同账号并发发布被拒绝；关闭服务等待已开始的公开发布结算", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await fixture(
    async (_task, markSubmitted) => {
      markSubmitted();
      await pending;
      return { url: "https://zhuanlan.zhihu.com/p/12345" };
    },
    async (service, params) => {
      const first = call(service, params);
      assert.ok((await call(service, params)).error);
      let closed = false;
      const closing = service.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(closed, false);
      release();
      assert.equal((await first).error, undefined);
      await closing;
      assert.equal(closed, true);
    },
  );
});

test("公开结果链接拒绝凭据、参数、编辑页、不同ID和非受信域名", () => {
  const draft = "https://zhuanlan.zhihu.com/p/12345/edit";
  for (const url of [
    "https://zhuanlan.zhihu.com/p/12345?token=secret",
    draft,
    "https://evil.example/p/12345",
    "https://zhuanlan.zhihu.com/p/99999",
    "https://user@zhuanlan.zhihu.com/p/12345",
  ])
    assert.throws(() => validateZhihuPublishedUrl(url, draft));
});

test("公开提交检查点跨重启保留，不能通过草稿或预检入口绕过", async () => {
  await fixture(
    async (_task, markSubmitted) => {
      markSubmitted();
      throw Error("结果未知");
    },
    async (service, params) => {
      await call(service, params);
      const directory = service.store.directory;
      await service.close();
      const restored = new Service(directory, {
        publishExecutor: async () => {
          throw Error("不应进入适配器");
        },
      });
      try {
        assert.equal(restored.store.hasPublicationAttempt(params.id), true);
        for (const method of [
          "task.saveDraft",
          "task.enqueueDraft",
          "task.preflight",
        ]) {
          const result = await restored.dispatch({
            id: 1,
            method,
            params: { id: params.id },
          });
          assert.match(result.error?.message ?? "", /已提交过公开发布/);
        }
        restored.store.transition(params.id, "draft_saved", "模拟手动修改状态");
        assert.match(
          (await call(restored, params)).error?.message ?? "",
          /已提交过公开发布/,
        );
      } finally {
        await restored.close();
      }
    },
  );
});

test("待发表会话重启后进入人工核对，禁止恢复后自动发表", async () => {
  await fixture(
    async () => {
      throw Error("不应提交");
    },
    async (service, params) => {
      service.store.transition(params.id, "publication_ready", "编辑器已准备");
      const directory = service.store.directory;
      await service.close();
      const restored = new Service(directory);
      try {
        assert.equal(
          restored.store.task(params.id).status,
          "intervention_required",
        );
        assert.match(
          restored.store.task(params.id).message,
          /编辑器会话已中断/,
        );
        assert.ok((await call(restored, params)).error);
      } finally {
        await restored.close();
      }
    },
  );
});

test("只读发布核对拒绝未提交任务、账号不一致和非受信链接且不改变状态", async () => {
  await fixture(
    async (_task, markSubmitted) => {
      markSubmitted();
      throw Error("未知");
    },
    async (service, params) => {
      const verify = (extra: Record<string, unknown> = {}) =>
        service.dispatch({
          id: 1,
          method: "task.verifyPublication",
          params: { id: params.id, accountId: params.accountId, ...extra },
        });
      assert.match((await verify()).error?.message ?? "", /任务未提交/);
      await call(service, params);
      assert.ok(
        (await verify({ accountId: "00000000-0000-4000-8000-000000000000" }))
          .error,
      );
      assert.ok((await verify({ url: "https://evil.example/p/12345" })).error);
      assert.equal(
        service.store.task(params.id).status,
        "intervention_required",
      );
      assert.ok(service.store.hasPublicationAttempt(params.id));
    },
  );
});

test("人工发布核对必须有提交和公开链接证据，成功事件明确标注人工确认", async () => {
  await fixture(
    async (_task, markSubmitted) => {
      markSubmitted();
      throw Error("未知");
    },
    async (service, params) => {
      const confirm = (extra: Record<string, unknown> = {}) =>
        service.dispatch({
          id: 1,
          method: "task.confirmPublicationReview",
          params: { ...params, ...extra },
        });
      assert.ok((await confirm()).error);
      await call(service, params);
      assert.ok((await confirm()).error);
      service.store.transition(
        params.id,
        "intervention_required",
        "公开结果链接待回读：https://zhuanlan.zhihu.com/p/12345",
      );
      assert.ok((await confirm({ title: "错误标题" })).error);
      assert.ok((await confirm({ confirmed: false })).error);
      assert.equal((await confirm()).error, undefined);
      assert.equal(service.store.task(params.id).status, "succeeded");
      assert.match(service.store.task(params.id).message, /用户人工确认/);
      assert.ok((await call(service, params)).error);
    },
  );
});
