import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { Page } from "playwright";
import { uploadWechatDraftMedia } from "../packages/publisher-engine/src/platforms/wechat/draft.ts";
import {
  fingerprintDistance,
  fingerprintsMatch,
  inspectWechatMultipart,
  isFinalWechatImageResource,
  uploadBodyImage,
  verifyWechatMedia,
  WechatImageIdentityError,
  type ImageFingerprint,
} from "../packages/publisher-engine/src/platforms/wechat/media.ts";

type Payload = Parameters<typeof uploadBodyImage>[1];
type Mutation =
  | "append"
  | "duplicate"
  | "thirdDuplicate"
  | "reorder"
  | "urlRewrite"
  | "placeholderThenFinal"
  | "rerenderDuringScroll"
  | "replacePrefixSame"
  | "replacePrefixSameAtSample2"
  | "replacePrefixDuringRevalidation"
  | "replacePrefixReordered"
  | "replacePrefixChanged"
  | "replacePrefixDuplicate"
  | "sameUrlContentChange"
  | "finalResourceTimeout"
  | "unstable";
type FakeNode = {
  content: string;
  url: string;
  complete: true;
  naturalWidth: 100;
};

function fakeFingerprint(content: string): ImageFingerprint {
  const digest = createHash("sha256").update(content).digest();
  return {
    differenceHash: digest.toString("hex"),
    averageRgb: [digest[0], digest[1], digest[2]],
  };
}

class FakeWechatPage {
  readonly fallbackCalls: string[] = [];
  readonly trace: string[] = [];
  readonly nativeChooserIds: number[] = [];
  readonly nodes: FakeNode[] = [];
  selectionPlacements = 0;
  locatorAcquisitions = 0;
  private snapshot: FakeNode[] = [];
  private readonly screenshotCalls = new Map<number, number>();
  private fingerprintEvaluations = 0;
  private transientFailures = 0;
  private prefixScreenshotAttempts = 0;
  private inputMarkerCalls = 0;
  private readonly inputMarkers: string[];
  private capturedInput: unknown;
  private rawActivatedCount = 0;
  private chooserMenuOpen = false;
  inputCaptureActive = false;
  inputCaptureCleanups = 0;
  private readonly requestListeners = new Set<(request: any) => void>();
  private readonly fileChooserListeners = new Set<(chooser: any) => void>();
  private readonly closeListeners = new Set<(...args: any[]) => void>();
  private readonly frame = {};
  private releaseResponseGate: (() => void) | undefined;
  private readonly responseGate = new Promise<void>((resolve) => {
    this.releaseResponseGate = resolve;
  });
  private selectionAtEnd = false;
  private armedChangeRound = "";
  private changeCleanups = 0;
  private requestWasArmedAtEverySet = true;
  private changeRecord:
    | {
        round: string;
        target: unknown;
        name: string;
        size: number;
        type: string;
      }
    | undefined;
  private readonly fallbackInput = {
    elementHandle: async () => this.fallbackInput,
    evaluate: async (_callback: unknown, round: string) => {
      if (round.startsWith('input[type="file"]'))
        return ["activated_detached", "activated_replaced"].includes(
          this.failure,
        )
          ? "detached"
          : "valid";
      this.trace.push("arm-change");
      this.armedChangeRound = round;
      return this.failure !== "change_detached";
    },
    setInputFiles: async (value: Payload | []) => {
      if (this.failure === "fallback_input") this.sensitiveFailure();
      this.fallbackCalls.push(Array.isArray(value) ? "clear" : value.name);
      this.trace.push(Array.isArray(value) ? "clear" : `set-${value.name}`);
      if (!Array.isArray(value)) {
        this.requestWasArmedAtEverySet &&= this.requestListeners.size === 1;
        if (this.failure !== "change_missing")
          this.changeRecord = {
            round: this.armedChangeRound,
            target:
              this.failure === "change_old_target" ? {} : this.fallbackInput,
            name:
              this.failure === "change_wrong_metadata" ? "old.png" : value.name,
            size: value.buffer.length,
            type: value.mimeType,
          };
        this.emitUploadRequest(value);
        this.applyUpload(value);
      }
    },
  };

  constructor(
    private readonly mutation: Mutation = "append",
    private readonly nativeChooser = false,
    private readonly failure = "",
  ) {
    // WeChat can keep more than one enabled, hidden file input in the DOM and
    // reuse one of those nodes after a toolbar click.  Keep this model separate
    // from the singleton happy path so the selector handshake is exercised.
    this.inputMarkers =
      failure === "multiple_reused_inputs" ||
      failure === "multiple_unactivated_inputs"
        ? ["", ""]
        : [""];
  }

  private sensitiveFailure(): never {
    throw new Error(
      "https://mp.weixin.qq.com/?token=secret base64 C:\\private\\secret-file.png",
    );
  }

  waitForEvent() {
    if (!this.nativeChooser)
      return Promise.reject(new Error("fake has no native file chooser"));
    const id = this.nativeChooserIds.length + 1;
    this.nativeChooserIds.push(id);
    return Promise.resolve({
      setFiles: async (value: Payload) => {
        if (this.failure === "filechooser") this.sensitiveFailure();
        this.applyUpload(value);
      },
    });
  }

  on(event: string, listener: (request: any) => void) {
    if (event === "request") this.requestListeners.add(listener);
    if (event === "filechooser") this.fileChooserListeners.add(listener);
    if (event === "close") this.closeListeners.add(listener);
    return this;
  }

  off(event: string, listener: (request: any) => void) {
    if (event === "request") this.requestListeners.delete(listener);
    if (event === "filechooser") this.fileChooserListeners.delete(listener);
    if (event === "close") this.closeListeners.delete(listener);
    return this;
  }

  mainFrame() {
    return this.frame;
  }

  activeRequestListeners() {
    return this.requestListeners.size;
  }

  activeChooserLifecycleListeners() {
    return this.fileChooserListeners.size + this.closeListeners.size;
  }

  inputCaptureState() {
    return {
      active: this.inputCaptureActive,
      cleanups: this.inputCaptureCleanups,
    };
  }

  uploadHandshakeState() {
    return {
      changeCleanups: this.changeCleanups,
      requestWasArmedAtEverySet: this.requestWasArmedAtEverySet,
    };
  }

  releaseUploadResponse() {
    this.releaseResponseGate?.();
  }

  getByText() {
    return {
      first: () => ({
        click: async () => {
          if (this.failure === "toolbar") this.sensitiveFailure();
          this.trace.push("toolbar");
          this.selectionAtEnd = false;
          this.chooserMenuOpen = true;
        },
      }),
    };
  }

  private triggerVisibleFileInput() {
    this.rawActivatedCount =
      this.failure === "multiple_activated_inputs" ? 2 : 1;
    if (this.failure === "zero_activated_inputs") this.rawActivatedCount = 0;
    if (
      ![
        "multiple_activated_inputs",
        "zero_activated_inputs",
        "activated_detached",
        "activated_replaced",
      ].includes(this.failure)
    )
      this.capturedInput = this.fallbackInput;
    const chooser = {
      element: () => this.fallbackInput,
      setFiles: async (files: Payload | []) => {
        if (!Array.isArray(files))
          await this.fallbackInput.setInputFiles(files);
      },
    };
    if (this.failure === "page_close") {
      for (const listener of this.closeListeners) listener();
    } else if (this.failure === "late_filechooser") {
      setTimeout(() => {
        for (const listener of this.fileChooserListeners) listener(chooser);
      }, 0);
    } else if (this.failure !== "zero_activated_inputs") {
      const count = this.failure === "multiple_activated_inputs" ? 2 : 1;
      for (let index = 0; index < count; index += 1)
        for (const listener of this.fileChooserListeners) listener(chooser);
    }
  }

  locator(selector: string): any {
    const imageLocator = {
      count: async () => {
        if (this.failure === "body_state") this.sensitiveFailure();
        return this.nodes.length;
      },
      nth: (index: number) => {
        this.locatorAcquisitions += 1;
        return {
          waitFor: async () => {},
          boundingBox: async () => ({
            x: 0,
            y: 0,
            width: 1200,
            height: 800,
          }),
          evaluate: async () => {
            if (this.failure === "dimensions" && index === 1)
              this.sensitiveFailure();
            return {
              width: 100,
              height: 80,
              resourceUrl:
                this.failure === "credential_url"
                  ? "https://user:password@mmbiz.qpic.cn/private"
                  : this.nodes[index].url,
            };
          },
          scrollIntoViewIfNeeded: async () => {
            if (this.failure === "scroll" && index === 1)
              this.sensitiveFailure();
            if (this.mutation === "rerenderDuringScroll" && index === 1)
              this.nodes[index] = { ...this.nodes[index] };
            if (
              this.mutation === "replacePrefixDuringRevalidation" &&
              index === 0 &&
              this.nodes.length === 2
            )
              this.nodes[0] = { ...this.nodes[0] };
          },
          screenshot: async () => {
            if (this.failure === "screenshot" && index === 1)
              this.sensitiveFailure();
            if (index === 0 && this.nodes.length === 2) {
              const prefixFailureLimit =
                this.failure === "prefix_screenshot"
                  ? Number.POSITIVE_INFINITY
                  : this.failure === "prefix_screenshot_twice"
                    ? 2
                    : this.failure === "prefix_screenshot_once"
                      ? 1
                      : 0;
              this.prefixScreenshotAttempts += 1;
              if (this.prefixScreenshotAttempts <= prefixFailureLimit)
                this.sensitiveFailure();
            }
            if (
              this.failure === "screenshot_once" &&
              index === 1 &&
              this.transientFailures++ === 0
            )
              this.sensitiveFailure();
            const call = (this.screenshotCalls.get(index) ?? 0) + 1;
            this.screenshotCalls.set(index, call);
            if (this.mutation === "placeholderThenFinal" && call === 1)
              return Buffer.from("placeholder");
            if (this.mutation === "unstable")
              return Buffer.from(call % 2 ? "temporary-a" : "temporary-b");
            return Buffer.from(this.nodes[index].content);
          },
        };
      },
    };
    if (
      selector ===
      ".rich_media_content .ProseMirror img:not(.ProseMirror-separator)"
    )
      return imageLocator;
    if (selector === ".rich_media_content .ProseMirror")
      return {
        locator: () => imageLocator,
        evaluate: async () => {
          if (this.failure === "cursor") this.sensitiveFailure();
          this.selectionPlacements += 1;
          this.trace.push("anchor-end");
          this.selectionAtEnd = true;
        },
        press: async () => {
          if (this.failure === "cursor") this.sensitiveFailure();
          this.trace.push("enter");
        },
      };
    if (
      selector === "input[type=file][name=file]:not([disabled])" ||
      selector === 'input[type="file"][name="file"]:not([disabled])'
    )
      return {
        filter: ({ visible }: { visible?: boolean }) => {
          if (!visible) throw new Error("fake only supports visible filter");
          return {
            count: async () => (this.chooserMenuOpen ? 1 : 0),
            click: async () => {
              if (!this.chooserMenuOpen)
                throw new Error("chooser menu was not opened");
              this.triggerVisibleFileInput();
            },
          };
        },
        last: () => this.fallbackInput,
        nth: () => this.fallbackInput,
        elementHandle: async () => this.fallbackInput,
        evaluateAll: async (_callback: unknown, marker: string) => {
          if (this.failure === "multiple_reused_inputs") {
            if (this.inputMarkerCalls++ === 0) {
              this.inputMarkers.fill(marker);
              return;
            }
            const fresh = this.inputMarkers
              .map((value, index) => ({ value, index }))
              .filter(({ value }) => value !== marker);
            return fresh.length === 1
              ? fresh[0]!.index
              : fresh.length === 0 && this.inputMarkers.length === 1
                ? 0
                : -1;
          }
          return this.inputMarkerCalls++ % 2 === 0 ? undefined : 0;
        },
      };
    throw new Error(`unexpected selector: ${selector}`);
  }

  async evaluate(_callback: unknown, argument?: unknown) {
    if (
      typeof argument === "object" &&
      argument !== null &&
      "action" in argument
    ) {
      const action = (argument as { action: string }).action;
      if (action === "arm") this.inputCaptureActive = true;
      if (action === "cleanup") {
        this.inputCaptureActive = false;
        this.inputCaptureCleanups += 1;
      }
      return;
    }
    if (
      typeof argument === "object" &&
      argument !== null &&
      "cleanupChangeRound" in argument
    ) {
      if (
        this.changeRecord?.round ===
        (argument as { cleanupChangeRound: string }).cleanupChangeRound
      )
        this.changeRecord = undefined;
      this.changeCleanups += 1;
      return;
    }
    if (typeof argument === "string" && argument.startsWith("input-round:"))
      return;
    if (
      typeof argument === "object" &&
      argument !== null &&
      "source" in argument
    ) {
      this.fingerprintEvaluations += 1;
      if (
        this.failure === "reference_fingerprint" ||
        (this.failure === "remote_canvas" && this.fingerprintEvaluations > 1)
      )
        this.sensitiveFailure();
      if (this.nodes.length === 2 && this.failure === "bitmap_decode")
        return { failure: "bitmap_decode_failed" };
      if (this.nodes.length === 2 && this.failure === "canvas")
        return { failure: "canvas_fingerprint_failed" };
      return {
        fingerprint: fakeFingerprint(
          Buffer.from(String(argument.source), "base64").toString(),
        ),
      };
    }
    if (
      argument === "check-node-continuity" &&
      this.mutation === "replacePrefixSameAtSample2" &&
      this.nodes.length === 2 &&
      (this.screenshotCalls.get(1) ?? 0) === 1 &&
      this.snapshot[0] === this.nodes[0]
    )
      this.nodes[0] = { ...this.nodes[0] };
    if (argument === "check-node-continuity")
      return this.snapshot.every((node, index) => this.nodes[index] === node);
    if (argument === "refresh-node-snapshot") {
      this.snapshot = this.nodes.slice(0, -1);
      return;
    }
    if (this.failure === "snapshot") this.sensitiveFailure();
    this.snapshot = [...this.nodes];
  }

  async evaluateHandle(_callback: unknown, _argument: unknown) {
    return {
      asElement: () => this.capturedInput,
      dispose: async () => {},
    };
  }

  async waitForFunction(_callback: unknown, argument: unknown) {
    if (argument === 'input[type="file"][name="file"]:not([disabled])') {
      if (!this.chooserMenuOpen) throw new Error("chooser menu was not opened");
      return true;
    }
    if (
      typeof argument === "object" &&
      argument !== null &&
      "previousRound" in argument
    ) {
      if (this.failure === "input_selector")
        throw new Error("fake selector failed");
      if (this.rawActivatedCount !== 1 || !this.capturedInput)
        throw new Error("fake current input activation timed out");
      return;
    }
    if (
      typeof argument === "object" &&
      argument !== null &&
      "changeRound" in argument
    ) {
      const expected = argument as {
        changeRound: string;
        input: unknown;
        name: string;
        size: number;
        type: string;
      };
      const change = this.changeRecord;
      if (
        !change ||
        change.round !== expected.changeRound ||
        change.target !== expected.input ||
        change.name !== expected.name ||
        change.size !== expected.size ||
        change.type !== expected.type
      )
        throw new Error("fake change handshake timed out");
      return;
    }
    if (typeof argument === "number") {
      if (this.mutation === "finalResourceTimeout")
        throw new Error("fake final resource timed out");
      const valid =
        this.snapshot.length === argument && this.nodes.length === argument + 1;
      if (!valid) throw new Error("fake wait timed out");
      return;
    }
    if (this.nodes.length !== (argument as { count: number }).count)
      throw new Error("fake verify timed out");
  }

  async waitForTimeout() {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  context() {
    return {
      request: {
        get: async (url: string) => {
          const index = this.nodes.findIndex((node) => node.url === url);
          const prefixFailureLimit =
            this.failure === "prefix_screenshot"
              ? Number.POSITIVE_INFINITY
              : this.failure === "prefix_screenshot_twice"
                ? 2
                : this.failure === "prefix_screenshot_once"
                  ? 1
                  : 0;
          if (index === 0 && this.nodes.length === 2 && prefixFailureLimit) {
            this.prefixScreenshotAttempts += 1;
            if (this.prefixScreenshotAttempts <= prefixFailureLimit)
              this.sensitiveFailure();
          }
          if (
            index < 0 ||
            (this.failure === "remote_fetch" && index === 1) ||
            (this.failure === "screenshot_once" &&
              index === 1 &&
              this.transientFailures++ === 0)
          )
            this.sensitiveFailure();
          const call = (this.screenshotCalls.get(index) ?? 0) + 1;
          this.screenshotCalls.set(index, call);
          const content =
            this.mutation === "placeholderThenFinal" && call === 1
              ? "placeholder"
              : this.mutation === "unstable"
                ? call % 2
                  ? "temporary-a"
                  : "temporary-b"
                : this.nodes[index].content;
          return {
            url: () =>
              this.failure === "redirect_offsite"
                ? "https://evil.example/image.png?token=secret"
                : url,
            ok: () => this.failure !== "http_error",
            headers: () => ({
              "content-type":
                this.failure === "non_image" ? "text/html" : "image/png",
              "content-length":
                this.failure === "declared_oversize"
                  ? String(10 * 1024 * 1024 + 1)
                  : String(Buffer.byteLength(content)),
            }),
            body: async () =>
              this.failure === "actual_oversize"
                ? Buffer.alloc(10 * 1024 * 1024 + 1)
                : Buffer.from(content),
          };
        },
      },
    };
  }

  viewportSize() {
    return { width: 1600, height: 1000 };
  }

  async screenshot() {
    const prefixFailureLimit =
      this.failure === "prefix_screenshot"
        ? Number.POSITIVE_INFINITY
        : this.failure === "prefix_screenshot_twice"
          ? 2
          : this.failure === "prefix_screenshot_once"
            ? 1
            : 0;
    if (this.prefixScreenshotAttempts <= prefixFailureLimit)
      this.sensitiveFailure();
    return Buffer.from(this.nodes[0].content);
  }

  private applyUpload(value: Payload) {
    if (this.mutation === "urlRewrite")
      this.nodes.forEach(
        (node, index) =>
          (node.url = `https://mmbiz.qpic.cn/rewritten-${index}-${randomUUID()}`),
      );
    const requested = value.buffer.toString();
    const content =
      (this.mutation === "duplicate" && this.nodes.length) ||
      (this.mutation === "thirdDuplicate" && this.nodes.length === 2)
        ? this.nodes.at(-1)!.content
        : requested;
    const node = {
      content,
      url: `https://mmbiz.qpic.cn/${randomUUID()}`,
      complete: true,
      naturalWidth: 100,
    } as FakeNode;
    if (this.selectionAtEnd) this.nodes.push(node);
    else this.nodes.unshift(node);
    if (this.mutation === "reorder" && this.nodes.length > 1)
      this.nodes.reverse();
    if (
      this.mutation === "replacePrefixSame" ||
      this.mutation === "replacePrefixDuringRevalidation"
    )
      for (let index = 0; index < this.nodes.length - 1; index += 1)
        this.nodes[index] = { ...this.nodes[index] };
    if (this.nodes.length === 3 && this.mutation === "replacePrefixReordered")
      [this.nodes[0], this.nodes[1]] = [
        { ...this.nodes[1] },
        { ...this.nodes[0] },
      ];
    if (this.nodes.length === 3 && this.mutation === "replacePrefixChanged")
      this.nodes[0] = { ...this.nodes[0], content: "03.png" };
    if (this.nodes.length === 3 && this.mutation === "replacePrefixDuplicate")
      this.nodes[0] = { ...this.nodes[1] };
    if (this.nodes.length === 3 && this.mutation === "sameUrlContentChange")
      this.nodes[0] = { ...this.nodes[0], content: "03.png" };
  }

  private emitUploadRequest(value: Payload) {
    const boundary =
      this.failure === "upload_mixed_boundary" ? "MiXeD-BOUNDARY" : "fake";
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${value.name}"\r\nContent-Type: ${value.mimeType}\r\n\r\n`,
      ),
      this.failure === "upload_wrong_bytes"
        ? Buffer.from("wrong bytes")
        : value.buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = {
      ok: () => this.failure !== "upload_http",
      finished: async () => {
        if (this.failure === "upload_delayed") await this.responseGate;
        return this.failure === "upload_finished" ? new Error("failed") : null;
      },
      headers: () => ({
        "content-length": String(this.failure === "upload_no_status" ? 2 : 23),
      }),
      body: async () =>
        Buffer.from(
          this.failure === "upload_no_status"
            ? "{}"
            : JSON.stringify({ base_resp: { ret: 0 } }),
        ),
    };
    const request = {
      url: () => "https://mp.weixin.qq.com/cgi-bin/uploadimg2cdn",
      method: () => "POST",
      resourceType: () =>
        this.failure === "upload_document" ? "document" : "xhr",
      headers: () => ({
        "content-type": `Multipart/Form-Data; boundary=${boundary}`,
      }),
      frame: () => this.frame,
      postDataBuffer: () => multipart,
      response: async () => response,
    };
    for (const listener of [...this.requestListeners]) listener(request);
    if (this.failure === "upload_duplicate_request")
      for (const listener of [...this.requestListeners]) listener(request);
  }
}

function payload(name: string): Payload {
  return { name, mimeType: "image/png", buffer: Buffer.from(name) };
}

test("公众号multipart离线分类仅输出计数且改写身份不能通过", () => {
  const expected = payload("01.png");
  const makeBody = (field: string, filename: string, bytes: Buffer) =>
    Buffer.concat([
      Buffer.from(
        `--MiXeD\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from("\r\n--MiXeD--\r\n"),
    ]);
  const type = "Multipart/Form-Data; boundary=MiXeD";
  assert.deepEqual(
    inspectWechatMultipart(
      makeBody("file", expected.name, expected.buffer),
      type,
      expected,
    ),
    {
      boundaryFound: true,
      parts: 1,
      fileFields: 1,
      named: 1,
      rawByteMatches: 1,
      mimeByteMatches: 1,
      exact: 1,
    },
  );
  assert.equal(
    inspectWechatMultipart(
      makeBody("pic", expected.name, expected.buffer),
      type,
      expected,
    ).exact,
    0,
  );
  assert.equal(
    inspectWechatMultipart(
      makeBody("file", "renamed.png", expected.buffer),
      type,
      expected,
    ).exact,
    0,
  );
  assert.equal(
    inspectWechatMultipart(
      makeBody("file", expected.name, Buffer.from("changed")),
      type,
      expected,
    ).exact,
    0,
  );
  assert.deepEqual(
    inspectWechatMultipart(
      makeBody("file", expected.name, expected.buffer),
      "multipart/form-data; boundary=mixed",
      expected,
    ),
    {
      boundaryFound: false,
      parts: 0,
      fileFields: 0,
      named: 0,
      rawByteMatches: 0,
      mimeByteMatches: 0,
      exact: 0,
    },
  );
});

test("公众号按输入内容顺序追加并使用DOM节点连续性锁定", async () => {
  const page = new FakeWechatPage();
  const fingerprints: ImageFingerprint[] = [];
  for (const name of ["01.png", "02.png", "03.png"])
    fingerprints.push(
      await uploadBodyImage(
        page as unknown as Page,
        payload(name),
        fingerprints,
      ),
    );
  assert.deepEqual(
    page.nodes.map((node) => node.content),
    ["01.png", "02.png", "03.png"],
  );
  assert.equal(page.selectionPlacements, 6);
  assert.equal(
    new Set(fingerprints.map((item) => item.differenceHash)).size,
    3,
  );
  await verifyWechatMedia(page as unknown as Page, fingerprints, false);
});

test("公众号URL整体重写但DOM节点和内容未变时继续上传", async () => {
  const page = new FakeWechatPage("urlRewrite");
  const fingerprints: ImageFingerprint[] = [];
  for (const name of ["01.png", "02.png", "03.png"])
    fingerprints.push(
      await uploadBodyImage(
        page as unknown as Page,
        payload(name),
        fingerprints,
      ),
    );
  assert.deepEqual(
    page.nodes.map((node) => node.content),
    ["01.png", "02.png", "03.png"],
  );
});

test("公众号不同URL承载重复内容时按内容指纹阻断", async () => {
  const page = new FakeWechatPage("duplicate");
  const first = await uploadBodyImage(
    page as unknown as Page,
    payload("01.png"),
  );
  await assert.rejects(
    uploadBodyImage(page as unknown as Page, payload("02.png"), [first]),
    /duplicate_content（上传前1张，当前2张，width=100,height=80,samples=91,phase=content_verification）/,
  );
  assert.notEqual(page.nodes[0].url, page.nodes[1].url);
});

test("公众号内容错序或既有DOM节点换位时阻断", async () => {
  const page = new FakeWechatPage("reorder");
  const first = await uploadBodyImage(
    page as unknown as Page,
    payload("01.png"),
  );
  await assert.rejects(
    uploadBodyImage(page as unknown as Page, payload("02.png"), [first]),
    /existing_content_changed（上传前1张，当前2张，phase=content_verification,samples=1）/,
  );
});

test("公众号以本轮chooser一次提交payload并贯穿上传证明", async () => {
  const native = new FakeWechatPage("append", true);
  const fallback = new FakeWechatPage();
  for (const name of ["01.png", "02.png", "03.png"]) {
    await uploadBodyImage(native as unknown as Page, payload(name));
    await uploadBodyImage(fallback as unknown as Page, payload(name));
  }
  assert.deepEqual(native.nativeChooserIds, []);
  assert.deepEqual(native.fallbackCalls, ["01.png", "02.png", "03.png"]);
  assert.deepEqual(fallback.fallbackCalls, ["01.png", "02.png", "03.png"]);
  assert.deepEqual(fallback.trace, [
    "anchor-end",
    "enter",
    "toolbar",
    "anchor-end",
    "set-01.png",
    "anchor-end",
    "enter",
    "toolbar",
    "anchor-end",
    "set-02.png",
    "anchor-end",
    "enter",
    "toolbar",
    "anchor-end",
    "set-03.png",
  ]);
  assert.deepEqual(
    fallback.nodes.map((node) => node.content),
    ["01.png", "02.png", "03.png"],
  );
  assert.equal(fallback.uploadHandshakeState().requestWasArmedAtEverySet, true);
  assert.equal(fallback.activeChooserLifecycleListeners(), 0);
});

test("公众号保留多个旧input时锁定本轮工具栏实际激活的同一节点", async () => {
  const page = new FakeWechatPage("append", false, "multiple_reused_inputs");
  await uploadBodyImage(page as unknown as Page, payload("01.png"));
  assert.deepEqual(page.fallbackCalls, ["01.png"]);
  assert.equal(page.activeRequestListeners(), 0);
  assert.deepEqual(
    page.nodes.map((node) => node.content),
    ["01.png"],
  );
});

test("公众号本轮多激活或零激活时拒绝选择且不设置文件", async () => {
  for (const failure of [
    "multiple_activated_inputs",
    "zero_activated_inputs",
  ]) {
    const page = new FakeWechatPage("append", false, failure);
    await assert.rejects(
      uploadBodyImage(page as unknown as Page, payload("01.png")),
      /file_input_failed（上传前0张，当前0张，phase=filechooser_selection,reason=(multiple_events|timeout)）/,
    );
    assert.deepEqual(page.fallbackCalls, []);
    assert.equal(page.activeRequestListeners(), 0);
    assert.deepEqual(page.nodes, []);
    assert.deepEqual(page.inputCaptureState(), { active: false, cleanups: 0 });
  }
});

test("本轮激活节点随后detach或被替换时拒绝换handle", async () => {
  for (const failure of ["activated_detached", "activated_replaced"]) {
    const page = new FakeWechatPage("append", false, failure);
    await assert.rejects(
      uploadBodyImage(page as unknown as Page, payload("01.png")),
      /file_input_failed（上传前0张，当前0张，phase=filechooser_selection,reason=detached）/,
    );
    assert.deepEqual(page.fallbackCalls, []);
    assert.deepEqual(page.nodes, []);
    assert.deepEqual(page.inputCaptureState(), { active: false, cleanups: 0 });
  }
});

test("光标或工具栏异常均清理本轮filechooser监听", async () => {
  for (const failure of ["cursor", "toolbar"]) {
    const page = new FakeWechatPage("append", false, failure);
    await assert.rejects(
      uploadBodyImage(page as unknown as Page, payload("01.png")),
    );
    assert.deepEqual(page.fallbackCalls, []);
    assert.deepEqual(page.inputCaptureState(), { active: false, cleanups: 0 });
    assert.equal(page.activeChooserLifecycleListeners(), 0);
  }
});

test("平台DOM change不可见或改写时仍以multipart和最终指纹裁决", async () => {
  for (const failure of [
    "change_missing",
    "change_old_target",
    "change_wrong_metadata",
    "change_detached",
  ]) {
    const page = new FakeWechatPage("append", false, failure);
    await uploadBodyImage(page as unknown as Page, payload("01.png"));
    assert.deepEqual(page.fallbackCalls, ["01.png"]);
    assert.deepEqual(
      page.nodes.map((node) => node.content),
      ["01.png"],
    );
    assert.equal(page.activeRequestListeners(), 0);
  }
});

test("公众号浏览器form导航型multipart仍按精确字节和成功响应证明", async () => {
  const page = new FakeWechatPage("append", false, "upload_document");
  await uploadBodyImage(page as unknown as Page, payload("01.png"));
  assert.deepEqual(
    page.nodes.map((node) => node.content),
    ["01.png"],
  );
  assert.equal(page.activeRequestListeners(), 0);
});

test("公众号multipart混合大小写boundary保留原值并匹配精确文件字节", async () => {
  const page = new FakeWechatPage("append", false, "upload_mixed_boundary");
  await uploadBodyImage(page as unknown as Page, payload("01.png"));
  assert.deepEqual(
    page.nodes.map((node) => node.content),
    ["01.png"],
  );
  assert.equal(page.activeRequestListeners(), 0);
});

test("第三轮新URL复用第二张字节时不报告3/3且封面与整组回验不可达", async () => {
  const page = new FakeWechatPage("thirdDuplicate");
  const progress: number[] = [];
  let coverCalls = 0;
  let verifyCalls = 0;
  await assert.rejects(
    uploadWechatDraftMedia(
      page as unknown as Page,
      [payload("01.png"), payload("02.png"), payload("03.png")],
      payload("cover.png"),
      (event) => {
        if (event.stage === "upload" && event.current !== undefined)
          progress.push(event.current);
      },
      {
        uploadBodyImage,
        uploadCover: async () => {
          coverCalls += 1;
        },
        verifyMedia: async () => {
          verifyCalls += 1;
        },
      },
    ),
    /duplicate_content.*上传前2张，当前3张/,
  );
  assert.equal(new Set(page.nodes.map((node) => node.url)).size, 3);
  assert.equal(progress.includes(3), false);
  assert.equal(verifyCalls, 0);
  assert.equal(coverCalls, 0);
});

test("本轮multipart必须携带精确payload且响应明确成功，失败后解绑监听", async () => {
  const cases = [
    ["upload_wrong_bytes", "upload_request_invalid"],
    ["upload_duplicate_request", "upload_request_invalid"],
    ["upload_http", "upload_response_invalid"],
    ["upload_finished", "upload_response_invalid"],
    ["upload_no_status", "upload_response_invalid"],
  ] as const;
  for (const [failure, difference] of cases) {
    const page = new FakeWechatPage("append", false, failure);
    await assert.rejects(
      uploadBodyImage(page as unknown as Page, payload("01.png")),
      new RegExp(`${difference}.*phase=upload_request`),
    );
    assert.equal(page.activeRequestListeners(), 0);
  }
});

test("上传协议失败时整组回验、封面及后续保存均不可达", async () => {
  const page = new FakeWechatPage("append", false, "upload_wrong_bytes");
  let verifyCalls = 0;
  let coverCalls = 0;
  await assert.rejects(
    uploadWechatDraftMedia(
      page as unknown as Page,
      [payload("01.png")],
      payload("cover.png"),
      undefined,
      {
        uploadBodyImage,
        uploadCover: async () => {
          coverCalls += 1;
        },
        verifyMedia: async () => {
          verifyCalls += 1;
        },
      },
    ),
    /upload_request_invalid/,
  );
  assert.equal(verifyCalls, 0);
  assert.equal(coverCalls, 0);
});

test("请求响应未finished前当前图片不完成且下一轮不可开始", async () => {
  const page = new FakeWechatPage("append", false, "upload_delayed");
  let completed = false;
  const upload = uploadBodyImage(
    page as unknown as Page,
    payload("01.png"),
  ).then(() => {
    completed = true;
  });
  for (
    let attempts = 0;
    attempts < 50 && page.activeRequestListeners() === 0;
    attempts += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(completed, false);
  assert.equal(page.activeRequestListeners(), 1);
  page.releaseUploadResponse();
  await upload;
  assert.equal(completed, true);
  assert.equal(page.activeRequestListeners(), 0);
});

test("正文完成与封面完成后分别执行整组有序内容回验", async () => {
  const calls: string[] = [];
  const fingerprints = [fakeFingerprint("01"), fakeFingerprint("02")];
  let index = 0;
  await uploadWechatDraftMedia(
    {} as Page,
    [payload("01.png"), payload("02.png")],
    payload("cover.png"),
    undefined,
    {
      uploadBodyImage: async () => {
        calls.push(`body-${index + 1}`);
        return fingerprints[index++];
      },
      uploadCover: async () => {
        calls.push("cover");
      },
      verifyMedia: async (_page, expected, cover) => {
        assert.deepEqual(expected, fingerprints);
        calls.push(`verify-${cover ? "cover" : "body"}`);
      },
    },
  );
  assert.deepEqual(calls, [
    "body-1",
    "body-2",
    "verify-body",
    "cover",
    "verify-cover",
  ]);
});

test("最后一轮晚到改写在正文整组回验阻断封面和保存", async () => {
  let coverCalls = 0;
  let saveCalls = 0;
  await assert.rejects(async () => {
    await uploadWechatDraftMedia(
      {} as Page,
      [payload("01.png"), payload("02.png"), payload("03.png")],
      payload("cover.png"),
      undefined,
      {
        uploadBodyImage: async (_page, image) =>
          fakeFingerprint(image.buffer.toString()),
        uploadCover: async () => {
          coverCalls += 1;
        },
        verifyMedia: async () => {
          throw new WechatImageIdentityError("content_mismatch", 3, 3, {
            phase: "content_verification",
          });
        },
      },
    );
    saveCalls += 1;
  }, /content_mismatch/);
  assert.equal(coverCalls, 0);
  assert.equal(saveCalls, 0);
});

test("封面后的晚到改写在第二次整组回验阻断保存", async () => {
  let verifyCalls = 0;
  let coverCalls = 0;
  let saveCalls = 0;
  await assert.rejects(async () => {
    await uploadWechatDraftMedia(
      {} as Page,
      [payload("01.png")],
      payload("cover.png"),
      undefined,
      {
        uploadBodyImage: async () => fakeFingerprint("01.png"),
        uploadCover: async () => {
          coverCalls += 1;
        },
        verifyMedia: async () => {
          verifyCalls += 1;
          if (verifyCalls === 2)
            throw new WechatImageIdentityError("content_mismatch", 1, 1, {
              phase: "content_verification",
            });
        },
      },
    );
    saveCalls += 1;
  }, /content_mismatch/);
  assert.equal(verifyCalls, 2);
  assert.equal(coverCalls, 1);
  assert.equal(saveCalls, 0);
});

test("内容指纹容忍小范围感知差异但拒绝明显不同内容", () => {
  const source = fakeFingerprint("source");
  const close = {
    ...source,
    averageRgb: source.averageRgb.map((value) => value + 1) as [
      number,
      number,
      number,
    ],
  };
  assert.equal(fingerprintsMatch(source, close), true);
  assert.equal(fingerprintsMatch(source, fakeFingerprint("other")), false);
});

test("替代指纹选择任一同时满足阈值的组合并报告最小违约距离", () => {
  const source: ImageFingerprint = {
    differenceHash: "0".repeat(64),
    averageRgb: [0, 0, 0],
  };
  const rendered: ImageFingerprint = {
    differenceHash: `ffc${"0".repeat(61)}`,
    averageRgb: [100, 0, 0],
    alternatives: [
      {
        differenceHash: `fffff${"0".repeat(59)}`,
        averageRgb: [20, 0, 0],
      },
    ],
  };
  assert.equal(fingerprintsMatch(source, rendered), true);
  assert.deepEqual(fingerprintDistance(source, rendered), {
    hashDistance: 20,
    rgbDistance: 20,
  });
});

test("自然尺寸已就绪但仍为blob或data资源时禁止开始指纹", () => {
  assert.equal(
    isFinalWechatImageResource({
      complete: true,
      naturalWidth: 100,
      src: "blob:https://mp.weixin.qq.com/temporary",
    }),
    false,
  );
  assert.equal(
    isFinalWechatImageResource({
      complete: true,
      naturalWidth: 100,
      src: "data:image/png;base64,AAAA",
    }),
    false,
  );
  assert.equal(
    isFinalWechatImageResource({
      complete: true,
      naturalWidth: 100,
      src: "https://mmbiz.qpic.cn/final-image",
    }),
    true,
  );
});

test("临时内容切换为最终图后须连续三次稳定才通过", async () => {
  const page = new FakeWechatPage("placeholderThenFinal");
  await uploadBodyImage(page as unknown as Page, payload("01.png"));
});

test("远端图片内容持续来回切换时分类为稳定性超时", async () => {
  const page = new FakeWechatPage("unstable");
  await assert.rejects(
    uploadBodyImage(page as unknown as Page, payload("01.png")),
    /stability_timeout（上传前0张，当前1张，phase=fingerprint_stability,samples=91,width=100,height=80,hashDistance=\d+,rgbDistance=\d+）/,
  );
});

test("最终qpic资源等待超时与DOM节点变化分开分类", async () => {
  const page = new FakeWechatPage("finalResourceTimeout");
  await assert.rejects(
    uploadBodyImage(page as unknown as Page, payload("01.png")),
    /final_resource_timeout（上传前0张，当前1张，phase=final_resource_wait）/,
  );
});

test("图片失败诊断不泄露URL、token、base64、文件名或本地路径", async () => {
  const page = new FakeWechatPage("unstable");
  let message = "";
  try {
    await uploadBodyImage(page as unknown as Page, payload("secret-file.png"));
  } catch (error) {
    message = (error as Error).message;
  }
  assert.match(message, /samples=91,width=100,height=80/);
  assert.doesNotMatch(
    message,
    /https?:|token|base64|secret-file|[A-Z]:\\|[A-Za-z]:\//i,
  );
});

test("公众号上传外围各阶段异常均映射固定脱敏phase", async () => {
  const cases = [
    ["body_state", false, "node_snapshot_failed", "body_state_read"],
    [
      "reference_fingerprint",
      false,
      "reference_fingerprint_failed",
      "reference_fingerprint",
    ],
    ["snapshot", false, "node_snapshot_failed", "dom_snapshot"],
    ["cursor", false, "cursor_failed", "cursor_position"],
    ["toolbar", false, "toolbar_failed", "toolbar_activation"],
    ["fallback_input", false, "file_input_failed", "filechooser_selection"],
    [
      "remote_canvas",
      false,
      "canvas_fingerprint_failed",
      "fingerprint_stability",
    ],
  ] as const;

  for (const [failure, nativeChooser, difference, phase] of cases) {
    const page = new FakeWechatPage("append", nativeChooser, failure);
    let message = "";
    await assert.rejects(
      async () => {
        try {
          await uploadBodyImage(page as unknown as Page, payload("01.png"));
        } catch (error) {
          message = (error as Error).message;
          throw error;
        }
      },
      new RegExp(`${difference}.*phase=${phase}`),
    );
    assert.doesNotMatch(
      message,
      /https?:|token|base64|secret-file|[A-Z]:\\|[A-Za-z]:\//i,
    );
  }
});

test("第二张图片采样各阶段失败均报告真实计数、sample和脱敏分类", async () => {
  const cases = [
    ["dimensions", "remote_dimensions_failed"],
    ["remote_fetch", "remote_fetch_failed"],
    ["bitmap_decode", "bitmap_decode_failed"],
    ["canvas", "canvas_fingerprint_failed"],
  ] as const;
  for (const [failure, difference] of cases) {
    const page = new FakeWechatPage("append", false, failure);
    const first = await uploadBodyImage(
      page as unknown as Page,
      payload("01.png"),
    );
    let message = "";
    await assert.rejects(
      async () => {
        try {
          await uploadBodyImage(page as unknown as Page, payload("02.png"), [
            first,
          ]);
        } catch (error) {
          message = (error as Error).message;
          throw error;
        }
      },
      new RegExp(
        `${difference}（上传前1张，当前2张，phase=fingerprint_stability,samples=3`,
      ),
    );
    assert.doesNotMatch(
      message,
      /https?:|token|base64|secret-file|[A-Z]:\\|[A-Za-z]:\//i,
    );
  }
});

test("每个采样重新解析目标节点且新节点重渲染不破坏旧节点前缀顺序", async () => {
  const page = new FakeWechatPage("rerenderDuringScroll");
  const first = await uploadBodyImage(
    page as unknown as Page,
    payload("01.png"),
  );
  const originalFirstNode = page.nodes[0];
  await uploadBodyImage(page as unknown as Page, payload("02.png"), [first]);
  assert.equal(page.nodes[0], originalFirstNode);
  assert.deepEqual(
    page.nodes.map((node) => node.content),
    ["01.png", "02.png"],
  );
  assert.ok(page.locatorAcquisitions >= 6);
});

test("第二张响应取流瞬态失败后重新定位并恢复", async () => {
  const page = new FakeWechatPage("append", false, "screenshot_once");
  const first = await uploadBodyImage(
    page as unknown as Page,
    payload("01.png"),
  );
  await uploadBodyImage(page as unknown as Page, payload("02.png"), [first]);
  assert.deepEqual(
    page.nodes.map((node) => node.content),
    ["01.png", "02.png"],
  );
});

test("旧图片节点全部替换但内容同序时按受信前缀回验并刷新快照", async () => {
  const page = new FakeWechatPage("replacePrefixSame");
  const fingerprints: ImageFingerprint[] = [];
  for (const name of ["01.png", "02.png", "03.png"])
    fingerprints.push(
      await uploadBodyImage(
        page as unknown as Page,
        payload(name),
        fingerprints,
      ),
    );
  assert.deepEqual(
    page.nodes.map((node) => node.content),
    ["01.png", "02.png", "03.png"],
  );
});

test("sample2发生旧节点替换时回验后继续当前图片稳定采样", async () => {
  const page = new FakeWechatPage("replacePrefixSameAtSample2");
  const first = await uploadBodyImage(
    page as unknown as Page,
    payload("01.png"),
  );
  await uploadBodyImage(page as unknown as Page, payload("02.png"), [first]);
  assert.deepEqual(
    page.nodes.map((node) => node.content),
    ["01.png", "02.png"],
  );
});

test("旧前缀回验期间节点再次替换仍按索引重新定位且有界完成", async () => {
  const page = new FakeWechatPage("replacePrefixDuringRevalidation");
  const first = await uploadBodyImage(
    page as unknown as Page,
    payload("01.png"),
  );
  await uploadBodyImage(page as unknown as Page, payload("02.png"), [first]);
  assert.deepEqual(
    page.nodes.map((node) => node.content),
    ["01.png", "02.png"],
  );
  assert.ok(page.locatorAcquisitions < 20);
});

test("第二张节点替换后旧前缀取流失败仍报告外层真实计数且脱敏", async () => {
  const page = new FakeWechatPage(
    "replacePrefixSameAtSample2",
    false,
    "prefix_screenshot",
  );
  const first = await uploadBodyImage(
    page as unknown as Page,
    payload("01.png"),
  );
  let message = "";
  await assert.rejects(async () => {
    try {
      await uploadBodyImage(page as unknown as Page, payload("02.png"), [
        first,
      ]);
    } catch (error) {
      message = (error as Error).message;
      throw error;
    }
  }, /remote_fetch_failed（上传前1张，当前2张，phase=fingerprint_stability,samples=3,outerSample=2,prefixSample=3,attempts=3/);
  assert.doesNotMatch(
    message,
    /https?:|token|base64|secret-file|[A-Z]:\\|[A-Za-z]:\//i,
  );
});

test("sample2旧前缀响应取流连续失败一至两次后恢复", async () => {
  for (const failure of ["prefix_screenshot_once", "prefix_screenshot_twice"]) {
    const page = new FakeWechatPage(
      "replacePrefixSameAtSample2",
      false,
      failure,
    );
    const first = await uploadBodyImage(
      page as unknown as Page,
      payload("01.png"),
    );
    await uploadBodyImage(page as unknown as Page, payload("02.png"), [first]);
    assert.deepEqual(
      page.nodes.map((node) => node.content),
      ["01.png", "02.png"],
    );
  }
});

test("旧前缀重建后错序、内容变化或重复均拒绝", async () => {
  const cases = [
    ["replacePrefixReordered", "existing_content_reordered"],
    ["replacePrefixChanged", "existing_content_changed"],
    ["replacePrefixDuplicate", "existing_content_duplicated"],
  ] as const;
  for (const [mutation, difference] of cases) {
    const page = new FakeWechatPage(mutation);
    const fingerprints: ImageFingerprint[] = [];
    for (const name of ["01.png", "02.png"])
      fingerprints.push(
        await uploadBodyImage(
          page as unknown as Page,
          payload(name),
          fingerprints,
        ),
      );
    let message = "";
    await assert.rejects(
      async () => {
        try {
          await uploadBodyImage(
            page as unknown as Page,
            payload("03.png"),
            fingerprints,
          );
        } catch (error) {
          message = (error as Error).message;
          throw error;
        }
      },
      new RegExp(
        `${difference}（上传前2张，当前3张，phase=content_verification,samples=1`,
      ),
    );
    assert.doesNotMatch(
      message,
      /https?:|token|base64|secret-file|[A-Z]:\\|[A-Za-z]:\//i,
    );
  }
});

test("qpic响应地址、状态、MIME及声明和实际大小均严格受限且脱敏", async () => {
  const cases = [
    ["credential_url", "remote_url_invalid"],
    ["redirect_offsite", "remote_url_invalid"],
    ["http_error", "remote_response_invalid"],
    ["non_image", "remote_response_invalid"],
    ["declared_oversize", "remote_response_invalid"],
    ["actual_oversize", "remote_response_invalid"],
  ] as const;
  for (const [failure, difference] of cases) {
    const page = new FakeWechatPage("append", false, failure);
    let message = "";
    await assert.rejects(
      async () => {
        try {
          await uploadBodyImage(page as unknown as Page, payload("01.png"));
        } catch (error) {
          message = (error as Error).message;
          throw error;
        }
      },
      new RegExp(`${difference}（上传前0张，当前1张`),
    );
    assert.doesNotMatch(
      message,
      /https?:|token|base64|secret-file|evil|user|password|[A-Z]:\\|[A-Za-z]:\//i,
    );
  }
});

test("相同qpic地址内容变化时不能由URL自证旧前缀", async () => {
  const page = new FakeWechatPage("sameUrlContentChange");
  const fingerprints: ImageFingerprint[] = [];
  for (const name of ["01.png", "02.png"])
    fingerprints.push(
      await uploadBodyImage(
        page as unknown as Page,
        payload(name),
        fingerprints,
      ),
    );
  await assert.rejects(
    uploadBodyImage(page as unknown as Page, payload("03.png"), fingerprints),
    /existing_content_changed/,
  );
});

test("正文上传异常后封面、保存和checkpoint均不可达", async () => {
  let coverCalls = 0;
  let saveCalls = 0;
  let checkpointCalls = 0;
  await assert.rejects(async () => {
    await uploadWechatDraftMedia(
      {} as Page,
      [payload("01.png")],
      payload("cover.png"),
      undefined,
      {
        uploadBodyImage: async () => {
          throw new WechatImageIdentityError("remote_screenshot_failed", 0, 1, {
            phase: "fingerprint_stability",
            samples: 1,
          });
        },
        uploadCover: async () => {
          coverCalls += 1;
        },
        verifyMedia: async () => {},
      },
    );
    saveCalls += 1;
    checkpointCalls += 1;
  }, /remote_screenshot_failed/);
  assert.equal(coverCalls, 0);
  assert.equal(saveCalls, 0);
  assert.equal(checkpointCalls, 0);
});
