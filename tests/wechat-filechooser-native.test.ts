import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { chromium, type Page } from "playwright";
import {
  captureWechatFileInput,
  captureWechatToolbarFileInput,
} from "../packages/publisher-engine/src/platforms/wechat/media.ts";

class FakeInput {
  constructor(
    readonly id: string,
    private readonly valid = true,
  ) {}

  async evaluate(
    callback: (
      node: { isConnected: boolean; matches: () => boolean },
      selector: string,
    ) => boolean,
    selector: string,
  ) {
    assert.equal(selector, 'input[type="file"][name="file"]:not([disabled])');
    return callback(
      { isConnected: this.valid, matches: () => this.valid },
      selector,
    );
  }
}

class FakeChooser {
  cleared = false;
  clearCalls = 0;
  payloadCalls = 0;
  constructor(readonly input: FakeInput) {}
  element() {
    return this.input;
  }
  async setFiles(
    files: [] | { name: string; mimeType: string; buffer: Buffer },
  ) {
    if (Array.isArray(files)) {
      assert.deepEqual(files, []);
      this.clearCalls += 1;
      this.cleared = true;
    } else {
      this.payloadCalls += 1;
    }
  }
}

class FakePage extends EventEmitter {
  async waitForTimeout(milliseconds: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}

function asPage(page: FakePage) {
  return page as unknown as Page;
}

test("filechooser监听先于点击注册，并返回事件携带的精确input handle", async () => {
  const page = new FakePage();
  const oldInput = new FakeInput("old");
  const activatedInput = new FakeInput("activated");
  const chooser = new FakeChooser(activatedInput);
  const returned = await captureWechatFileInput(
    asPage(page),
    async () => {
      assert.equal(page.listenerCount("filechooser"), 1);
      page.emit("filechooser", chooser);
    },
    { timeoutMs: 100 },
  );
  assert.equal(returned, chooser);
  assert.equal(returned.element(), activatedInput);
  assert.notEqual(returned.element(), oldInput);
  assert.equal(chooser.cleared, false);
  assert.equal(page.listenerCount("filechooser"), 0);
  assert.equal(page.listenerCount("close"), 0);
});

test("filechooser零事件、多事件及迟到第二事件全部拒绝并清理", async (t) => {
  await t.test("zero", async () => {
    const page = new FakePage();
    await assert.rejects(
      captureWechatFileInput(asPage(page), async () => {}, { timeoutMs: 5 }),
      /timed out/,
    );
    assert.equal(page.listenerCount("filechooser"), 0);
    assert.equal(page.listenerCount("close"), 0);
  });

  await t.test("multiple synchronous", async () => {
    const page = new FakePage();
    const first = new FakeChooser(new FakeInput("a"));
    const second = new FakeChooser(new FakeInput("b"));
    await assert.rejects(
      captureWechatFileInput(
        asPage(page),
        async () => {
          page.emit("filechooser", first);
          page.emit("filechooser", second);
        },
        { timeoutMs: 100 },
      ),
      /invalid chooser count/,
    );
    assert.equal(first.cleared, true);
    assert.equal(second.cleared, true);
    assert.equal(page.listenerCount("filechooser"), 0);
  });

  await t.test("same chooser emitted twice resolves only once", async () => {
    const page = new FakePage();
    const chooser = new FakeChooser(new FakeInput("same"));
    await assert.rejects(
      captureWechatFileInput(
        asPage(page),
        async () => {
          page.emit("filechooser", chooser);
          page.emit("filechooser", chooser);
        },
        { timeoutMs: 100 },
      ),
      /invalid chooser count/,
    );
    assert.equal(chooser.cleared, true);
    assert.equal(chooser.clearCalls, 1);
    assert.equal(page.listenerCount("filechooser"), 0);
  });

  await t.test("late second", async () => {
    const page = new FakePage();
    await assert.rejects(
      captureWechatFileInput(
        asPage(page),
        async () => {
          page.emit("filechooser", new FakeChooser(new FakeInput("a")));
          setTimeout(
            () => page.emit("filechooser", new FakeChooser(new FakeInput("b"))),
            0,
          );
        },
        { timeoutMs: 100 },
      ),
      /late WeChat file chooser event/,
    );
    assert.equal(page.listenerCount("filechooser"), 0);
  });
});

test("click失败、page close和abort均立即拒绝并清理监听", async (t) => {
  await t.test("click failure", async () => {
    const page = new FakePage();
    await assert.rejects(
      captureWechatFileInput(
        asPage(page),
        async () => {
          throw new Error("click failed");
        },
        { timeoutMs: 100 },
      ),
      /click failed/,
    );
    assert.equal(page.listenerCount("filechooser"), 0);
    assert.equal(page.listenerCount("close"), 0);
  });

  await t.test("click failure after chooser", async () => {
    const page = new FakePage();
    const chooser = new FakeChooser(new FakeInput("activated"));
    await assert.rejects(
      captureWechatFileInput(
        asPage(page),
        async () => {
          page.emit("filechooser", chooser);
          throw new Error("click failed after chooser");
        },
        { timeoutMs: 100 },
      ),
      /click failed after chooser/,
    );
    assert.equal(chooser.cleared, true);
    assert.equal(page.listenerCount("filechooser"), 0);
    assert.equal(page.listenerCount("close"), 0);
  });

  await t.test("page close", async () => {
    const page = new FakePage();
    await assert.rejects(
      captureWechatFileInput(asPage(page), async () => page.emit("close"), {
        timeoutMs: 100,
      }),
      /page closed/,
    );
    assert.equal(page.listenerCount("filechooser"), 0);
    assert.equal(page.listenerCount("close"), 0);
  });

  await t.test("abort", async () => {
    const page = new FakePage();
    const controller = new AbortController();
    await assert.rejects(
      captureWechatFileInput(asPage(page), async () => controller.abort(), {
        timeoutMs: 100,
        signal: controller.signal,
      }),
      /aborted/,
    );
    assert.equal(page.listenerCount("filechooser"), 0);
    assert.equal(page.listenerCount("close"), 0);
  });
});

test("错误属性、detach或替换节点不能降级到另一个input", async () => {
  for (const id of ["wrong-attrs", "detached", "replaced"]) {
    const page = new FakePage();
    const replacement = new FakeInput(`${id}-replacement`);
    const chooserInput = new FakeInput(id, false);
    await assert.rejects(
      captureWechatFileInput(
        asPage(page),
        async () => {
          page.emit("filechooser", new FakeChooser(chooserInput));
          void replacement;
        },
        { timeoutMs: 100 },
      ),
      /input detached/,
    );
  }
});

test("超时轮次的迟到chooser不能被下一轮接收", async () => {
  const page = new FakePage();
  const stale = new FakeInput("stale");
  await assert.rejects(
    captureWechatFileInput(asPage(page), async () => {}, { timeoutMs: 5 }),
    /timed out/,
  );
  await assert.rejects(
    captureWechatFileInput(
      asPage(page),
      async () => {
        page.emit("filechooser", new FakeChooser(stale));
      },
      { timeoutMs: 100 },
    ),
    /expired|stale|tainted|previous/i,
  );
});

for (const browser of [
  {
    name: "bundled Chromium",
    launch: () =>
      chromium.launch({
        executablePath: `${process.env.LOCALAPPDATA}\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe`,
        headless: true,
      }),
  },
  {
    name: "local Edge",
    launch: () => chromium.launch({ channel: "msedge", headless: true }),
  },
]) {
  test(`真实${browser.name}：无需观察input click且两个常驻input只操作工具栏实际激活节点`, async () => {
    const instance = await browser.launch();
    try {
      const page = await instance.newPage();
      await page.setContent(`
        <button id="toolbar">图片</button>
        <input id="old" type="file" name="file" hidden>
        <input id="active" type="file" name="file" hidden>
        <script>
          document.querySelector('#toolbar').addEventListener('click', () => {
            document.querySelector('#active').click();
          });
        </script>
      `);
      const chooser = await captureWechatFileInput(
        page,
        () => page.locator("#toolbar").click(),
        { timeoutMs: 1000 },
      );
      const input = chooser.element();
      assert.equal(await input.getAttribute("id"), "active");
      assert.equal(await page.locator("input").count(), 2);
      await chooser.setFiles({
        name: "round.png",
        mimeType: "image/png",
        buffer: Buffer.from("exact-round-bytes"),
      });
      assert.deepEqual(
        await page.locator("input").evaluateAll((nodes) =>
          nodes.map((node) => {
            const file = (node as HTMLInputElement).files?.item(0);
            return file
              ? { name: file.name, type: file.type, size: file.size }
              : null;
          }),
        ),
        [null, { name: "round.png", type: "image/png", size: 17 }],
      );
    } finally {
      await instance.close();
    }
  });

  test(`真实${browser.name}：两步展开只点击Playwright判定的唯一可见input`, async () => {
    const instance = await browser.launch();
    try {
      const page = await instance.newPage();
      await page.setContent(`
        <button id="toolbar">图片</button>
        <input id="old" type="file" name="file" hidden>
        <input id="collapsed" type="file" name="file" style="visibility:collapse">
        <input id="active" type="file" name="file" hidden>
        <script>
          document.querySelector('#toolbar').addEventListener('click', () => {
            document.querySelector('#active').hidden = false;
          });
        </script>
      `);
      const chooser = await captureWechatToolbarFileInput(
        page,
        () => page.locator("#toolbar").click(),
        {
          visibleTimeoutMs: 1000,
          chooserTimeoutMs: 1000,
          quiescenceMs: 20,
        },
      );
      assert.equal(await chooser.element().getAttribute("id"), "active");

      await page.setContent(`
        <button id="toolbar">图片</button>
        <input id="first" type="file" name="file">
        <input id="second" type="file" name="file">
      `);
      await assert.rejects(
        captureWechatToolbarFileInput(
          page,
          () => page.locator("#toolbar").click(),
          { visibleTimeoutMs: 100 },
        ),
        /selector mismatch/,
      );
    } finally {
      await instance.close();
    }
  });

  test(`真实${browser.name}：工具栏直接弹出chooser时不再次点击常驻input`, async () => {
    const instance = await browser.launch();
    try {
      const page = await instance.newPage();
      await page.setContent(`
        <button id="toolbar">图片</button>
        <input id="active" type="file" name="file" hidden>
        <input id="decoy" type="file" name="file">
        <script>
          window.changes = [];
          document.querySelector('#toolbar').onclick = () => {
            document.querySelector('#active').click();
          };
          for (const input of document.querySelectorAll('input'))
            input.onchange = () => window.changes.push(input.id);
        </script>
      `);
      const chooser = await captureWechatToolbarFileInput(
        page,
        () => page.locator("#toolbar").click(),
        { chooserTimeoutMs: 1000, quiescenceMs: 20 },
      );
      assert.equal(await chooser.element().getAttribute("id"), "active");
      await chooser.setFiles({
        name: "first.png",
        mimeType: "image/png",
        buffer: Buffer.from("first-round"),
      });
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { changes: string[] }).changes,
        ),
        ["active"],
      );
    } finally {
      await instance.close();
    }
  });

  test(`真实${browser.name}：空change消费one-shot回调而直接chooser payload保留本轮`, async () => {
    const instance = await browser.launch();
    try {
      const page = await instance.newPage();

      // Model a platform one-shot selection callback. Resolving the native
      // chooser with [] consumes that callback as a cancellation; setting the
      // element afterwards cannot revive the same business round.
      await page.setContent(`
        <input id="raw" type="file" name="file">
        <script>
          window.changes = [];
          document.querySelector('#raw').addEventListener('change', (event) => {
            window.changes.push(
              [...event.currentTarget.files].map((file) => file.name),
            );
          }, { once: true });
        </script>
      `);
      const rawChooserPromise = page.waitForEvent("filechooser");
      await page.locator("#raw").click();
      const rawChooser = await rawChooserPromise;
      await page.waitForTimeout(100);
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { changes: string[][] }).changes,
        ),
        [],
      );
      await rawChooser.setFiles([]);
      await rawChooser.element().setInputFiles({
        name: "too-late.png",
        mimeType: "image/png",
        buffer: Buffer.from("too-late-bytes"),
      });
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { changes: string[][] }).changes,
        ),
        [[]],
      );

      // The production path keeps the chooser pending and resolves it exactly
      // once with the payload, so the platform callback receives the file.
      await page.setContent(`
        <button id="toolbar">图片</button>
        <input id="active" type="file" name="file" hidden>
        <script>
          window.changes = [];
          document.querySelector('#active').addEventListener('change', (event) => {
            window.changes.push(
              [...event.currentTarget.files].map((file) => file.name),
            );
          }, { once: true });
          document.querySelector('#toolbar').addEventListener('click', () => {
            document.querySelector('#active').hidden = false;
          });
        </script>
      `);
      const chooser = await captureWechatToolbarFileInput(
        page,
        () => page.locator("#toolbar").click(),
        {
          visibleTimeoutMs: 1000,
          chooserTimeoutMs: 1000,
          quiescenceMs: 20,
        },
      );
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { changes: string[][] }).changes,
        ),
        [],
      );
      await chooser.setFiles({
        name: "payload.png",
        mimeType: "image/png",
        buffer: Buffer.from("payload-bytes"),
      });
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { changes: string[][] }).changes,
        ),
        [["payload.png"]],
      );
    } finally {
      await instance.close();
    }
  });
}
