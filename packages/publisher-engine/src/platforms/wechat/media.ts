import { armFormDataUploadProof } from "../form-data-upload-proof.ts";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ElementHandle,
  FileChooser,
  Locator,
  Page,
  Request,
} from "playwright";

export type WechatImageDifference =
  | "operation_failed"
  | "reference_fingerprint_failed"
  | "node_snapshot_failed"
  | "cursor_failed"
  | "toolbar_failed"
  | "file_input_failed"
  | "upload_request_timeout"
  | "upload_request_invalid"
  | "upload_response_invalid"
  | "fingerprint_capture_failed"
  | "remote_dimensions_failed"
  | "remote_scroll_failed"
  | "remote_screenshot_failed"
  | "bitmap_decode_failed"
  | "canvas_fingerprint_failed"
  | "remote_url_invalid"
  | "remote_fetch_failed"
  | "remote_response_invalid"
  | "no_new_remote_image"
  | "unexpected_count"
  | "existing_node_changed"
  | "existing_content_changed"
  | "existing_content_reordered"
  | "existing_content_duplicated"
  | "final_resource_timeout"
  | "stability_timeout"
  | "content_mismatch"
  | "duplicate_content";

export interface FingerprintVariant {
  differenceHash: string;
  averageRgb: [number, number, number];
}

export interface ImageFingerprint {
  differenceHash: string;
  averageRgb: [number, number, number];
  alternatives?: FingerprintVariant[];
}

export interface WechatImageDiagnostic {
  phase?:
    | "body_state_read"
    | "reference_fingerprint"
    | "dom_snapshot"
    | "cursor_position"
    | "toolbar_activation"
    | "filechooser_selection"
    | "upload_request"
    | "final_resource_wait"
    | "fingerprint_stability"
    | "content_verification"
    | "unknown";
  samples?: number;
  outerSample?: number;
  prefixSample?: number;
  attempts?: number;
  width?: number;
  height?: number;
  hashDistance?: number;
  rgbDistance?: number;
  reason?: WechatFileChooserFailureReason;
  requestCandidates?: number;
  multipartCandidates?: number;
  multipartBodiesReadable?: number;
  multipartBoundaryFound?: number;
  multipartParts?: number;
  multipartFileFields?: number;
  multipartFilenameMatches?: number;
  multipartRawByteMatches?: number;
  multipartMimeByteMatches?: number;
}

export type WechatFileChooserFailureReason =
  | "previous_round_failed"
  | "timeout"
  | "multiple_events"
  | "late_event"
  | "page_closed"
  | "aborted"
  | "detached"
  | "selector_mismatch"
  | "pre_clear_invalid"
  | "chooser_not_cleared"
  | "pre_set_invalid"
  | "set_failed";

class WechatFileChooserError extends Error {
  readonly reason: WechatFileChooserFailureReason;

  constructor(reason: WechatFileChooserFailureReason) {
    super(
      {
        previous_round_failed:
          "previous WeChat file chooser round expired; page tainted",
        timeout: "WeChat file chooser timed out",
        multiple_events: "WeChat toolbar emitted an invalid chooser count",
        late_event: "late WeChat file chooser event",
        page_closed: "WeChat page closed during file chooser",
        aborted: "WeChat file chooser aborted",
        detached: "WeChat file chooser input detached",
        selector_mismatch: "WeChat file chooser input selector mismatch",
        pre_clear_invalid: "WeChat file input invalid before clear",
        chooser_not_cleared: "WeChat file chooser did not clear input",
        pre_set_invalid: "WeChat file input invalid before set",
        set_failed: "WeChat file input set failed",
      }[reason],
    );
    this.reason = reason;
  }
}

export function isFinalWechatImageResource(image: {
  complete: boolean;
  naturalWidth: number;
  currentSrc?: string;
  src: string;
}) {
  try {
    return (
      image.complete &&
      image.naturalWidth > 0 &&
      new URL(image.currentSrc || image.src).hostname === "mmbiz.qpic.cn"
    );
  } catch {
    return false;
  }
}

export class WechatImageIdentityError extends Error {
  readonly difference: WechatImageDifference;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly diagnostic: WechatImageDiagnostic;

  constructor(
    difference: WechatImageDifference,
    beforeCount: number,
    afterCount: number,
    diagnostic: WechatImageDiagnostic = {},
  ) {
    const metrics = Object.entries(diagnostic)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    super(
      `公众号图片身份核对失败：${difference}（上传前${beforeCount}张，当前${afterCount}张${metrics ? `，${metrics}` : ""}）`,
    );
    this.difference = difference;
    this.beforeCount = beforeCount;
    this.afterCount = afterCount;
    this.diagnostic = diagnostic;
  }
}

const phaseByDifference: Partial<
  Record<WechatImageDifference, WechatImageDiagnostic["phase"]>
> = {
  node_snapshot_failed: "dom_snapshot",
  reference_fingerprint_failed: "reference_fingerprint",
  cursor_failed: "cursor_position",
  toolbar_failed: "toolbar_activation",
  file_input_failed: "filechooser_selection",
  upload_request_timeout: "upload_request",
  upload_request_invalid: "upload_request",
  upload_response_invalid: "upload_request",
  final_resource_timeout: "final_resource_wait",
  stability_timeout: "fingerprint_stability",
  fingerprint_capture_failed: "fingerprint_stability",
  remote_dimensions_failed: "fingerprint_stability",
  remote_scroll_failed: "fingerprint_stability",
  remote_screenshot_failed: "fingerprint_stability",
  bitmap_decode_failed: "fingerprint_stability",
  canvas_fingerprint_failed: "fingerprint_stability",
  content_mismatch: "content_verification",
  duplicate_content: "content_verification",
};

async function safeWechatImageStage<T>(
  difference: WechatImageDifference,
  beforeCount: number,
  action: () => Promise<T>,
  phase = phaseByDifference[difference] ?? "unknown",
) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof WechatImageIdentityError) throw error;
    if (error instanceof WechatFileChooserError)
      throw new WechatImageIdentityError(difference, beforeCount, beforeCount, {
        phase,
        reason: error.reason,
      });
    throw new WechatImageIdentityError(difference, beforeCount, beforeCount, {
      phase,
    });
  }
}

async function fileInputStep<T>(
  reason: WechatFileChooserFailureReason,
  action: () => Promise<T>,
) {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof WechatImageIdentityError ||
      error instanceof WechatFileChooserError
    )
      throw error;
    throw new WechatFileChooserError(reason);
  }
}

export async function imagePayload(path: string) {
  if (!isAbsolute(path)) throw new Error("图片必须使用本地绝对路径");
  const file = await stat(path);
  if (!file.isFile() || file.size > 10 * 1024 * 1024)
    throw new Error("图片必须是10MB以内的本地文件");
  const buffer = await readFile(path);
  const png = buffer
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (!png && !jpeg)
    throw new Error("当前仅支持PNG/JPEG图片，文件内容必须与图片格式一致");
  return {
    name: `turbopush-${randomUUID()}.${png ? "png" : "jpg"}`,
    mimeType: png ? "image/png" : "image/jpeg",
    buffer,
  };
}

export async function uploadBodyImage(
  page: Page,
  payload: Awaited<ReturnType<typeof imagePayload>>,
  previousFingerprints: readonly ImageFingerprint[] = [],
) {
  try {
    return await uploadBodyImageInternal(page, payload, previousFingerprints);
  } catch (error) {
    if (error instanceof WechatImageIdentityError) throw error;
    throw new WechatImageIdentityError("operation_failed", 0, 0, {
      phase: "unknown",
    });
  }
}

async function uploadBodyImageInternal(
  page: Page,
  payload: Awaited<ReturnType<typeof imagePayload>>,
  previousFingerprints: readonly ImageFingerprint[],
) {
  const editor = page.locator(".rich_media_content .ProseMirror");
  const images = editor.locator("img:not(.ProseMirror-separator)");
  const beforeCount = await safeWechatImageStage(
    "node_snapshot_failed",
    0,
    () => images.count(),
    "body_state_read",
  );
  const expected = await safeWechatImageStage(
    "reference_fingerprint_failed",
    beforeCount,
    () => fingerprintImageBuffer(page, payload.buffer, payload.mimeType),
  );
  await safeWechatImageStage("node_snapshot_failed", beforeCount, () =>
    page.evaluate(() => {
      const state = window as unknown as {
        __turbopushWechatImageNodes?: Element[];
      };
      state.__turbopushWechatImageNodes = [
        ...document.querySelectorAll(
          ".rich_media_content .ProseMirror img:not(.ProseMirror-separator)",
        ),
      ];
    }),
  );
  // Trigger the toolbar for each image so WeChat supplies the input associated
  // with this insertion. On the real editor this first click only reveals the
  // hidden file control; clicking that one visible control emits filechooser.
  // The toolbar steals the DOM selection, therefore the append anchor is
  // restored only after the chooser and immediately before the input change.
  await placeWechatCursorAtEnd(editor, beforeCount, true);
  const chooser = await safeWechatImageStage(
    "file_input_failed",
    beforeCount,
    () =>
      captureWechatToolbarFileInput(page, () =>
        safeWechatImageStage("toolbar_failed", beforeCount, () =>
          page.getByText("图片", { exact: true }).first().click(),
        ),
      ),
  );
  const input = chooser.element();
  let uploadRequest: ReturnType<typeof armWechatImageUploadRequest> = null;
  let browserProof: Awaited<ReturnType<typeof armFormDataUploadProof>> = null;
  let chooserSettled = false;
  try {
    await safeWechatImageStage("file_input_failed", beforeCount, async () => {
      const selector = 'input[type="file"][name="file"]:not([disabled])';
      const validAfterChooserClear = await fileInputStep(
        "pre_clear_invalid",
        () =>
          input.evaluate(
            (node, selector) =>
              node.isConnected &&
              (node as Element).matches(selector) &&
              (node as HTMLInputElement).files?.length === 0,
            selector,
          ),
      );
      if (!validAfterChooserClear)
        throw new WechatFileChooserError("chooser_not_cleared");
      // DOM change visibility is not reliable evidence: platform handlers may
      // stop propagation or synchronously clear/replace the input. Re-anchor,
      // validate this exact handle immediately before injection, then require
      // the stronger multipart/response/qpic proof below.
      await placeWechatCursorAtEnd(editor, beforeCount, false);
      const validBeforeSet = await fileInputStep("pre_set_invalid", () =>
        input.evaluate(
          (node, selector) =>
            node.isConnected && (node as Element).matches(selector),
          selector,
        ),
      );
      if (!validBeforeSet) throw new WechatFileChooserError("pre_set_invalid");
    });
    browserProof = await armFormDataUploadProof(
      page,
      payload,
      "https://mp.weixin.qq.com",
    );
    uploadRequest = armWechatImageUploadRequest(
      page,
      payload,
      beforeCount,
      browserProof?.promise,
    );
    await safeWechatImageStage("file_input_failed", beforeCount, async () => {
      // Resolve the one native chooser exactly once with the payload. Resolving
      // it with [] first emits an empty change, which WeChat may treat as the
      // cancellation of this one-shot selection round.
      await fileInputStep("set_failed", () => chooser.setFiles(payload));
      chooserSettled = true;
    });
    if (uploadRequest) await uploadRequest.promise;
  } finally {
    if (!chooserSettled) await chooser.setFiles([]).catch(() => undefined);
    uploadRequest?.cancel();
    await browserProof?.cancel();
  }
  try {
    await page.waitForFunction(
      (beforeCount) => {
        const current = [
          ...document.querySelectorAll(
            ".rich_media_content .ProseMirror img:not(.ProseMirror-separator)",
          ),
        ];
        const state = window as unknown as {
          __turbopushWechatImageNodes?: Element[];
        };
        const before = state.__turbopushWechatImageNodes ?? [];
        return (
          before.length === beforeCount &&
          current.length === beforeCount + 1 &&
          current.every((node) => {
            const image = node as HTMLImageElement;
            try {
              return (
                image.complete &&
                image.naturalWidth > 0 &&
                new URL(image.currentSrc || image.src).hostname ===
                  "mmbiz.qpic.cn"
              );
            } catch {
              return false;
            }
          })
        );
      },
      beforeCount,
      { timeout: 45000 },
    );
  } catch {
    const afterCount = await safeWechatImageStage(
      "node_snapshot_failed",
      beforeCount,
      () => images.count(),
      "body_state_read",
    );
    const difference =
      afterCount === beforeCount
        ? "no_new_remote_image"
        : afterCount !== beforeCount + 1
          ? "unexpected_count"
          : "final_resource_timeout";
    throw new WechatImageIdentityError(difference, beforeCount, afterCount, {
      phase: "final_resource_wait",
    });
  }
  const stable = await stableFingerprintImageElement(
    page,
    () => images.nth(beforeCount),
    expected,
    { images, beforeCount, previousFingerprints },
  );
  if (!stable || "unstable" in stable) {
    const distance = stable
      ? fingerprintDistance(expected, stable.fingerprint)
      : undefined;
    throw new WechatImageIdentityError(
      "stability_timeout",
      beforeCount,
      beforeCount + 1,
      {
        phase: "fingerprint_stability",
        samples: stable?.samples ?? 0,
        width: stable?.width,
        height: stable?.height,
        hashDistance: distance?.hashDistance,
        rgbDistance: distance?.rgbDistance,
      },
    );
  }
  const { fingerprint: actual, ...diagnostic } = stable;
  if (previousFingerprints.some((item) => fingerprintsMatch(item, actual)))
    throw new WechatImageIdentityError(
      "duplicate_content",
      beforeCount,
      beforeCount + 1,
      { ...diagnostic, phase: "content_verification" },
    );
  const distance = fingerprintDistance(expected, actual);
  if (!fingerprintsMatch(expected, actual))
    throw new WechatImageIdentityError(
      "content_mismatch",
      beforeCount,
      beforeCount + 1,
      {
        ...diagnostic,
        phase: "content_verification",
        hashDistance: distance.hashDistance,
        rgbDistance: distance.rgbDistance,
      },
    );
  return actual;
}

async function placeWechatCursorAtEnd(
  editor: Locator,
  beforeCount: number,
  addParagraph: boolean,
) {
  await safeWechatImageStage("cursor_failed", beforeCount, async () => {
    await editor.evaluate((element) => {
      (element as HTMLElement).focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    if (addParagraph) await editor.press("Enter");
  });
}

const taintedWechatChooserPages = new WeakSet<Page>();

export async function captureWechatToolbarFileInput(
  page: Page,
  clickToolbar: () => Promise<unknown>,
  options: {
    visibleTimeoutMs?: number;
    chooserTimeoutMs?: number;
    quiescenceMs?: number;
  } = {},
) {
  return captureWechatFileInput(
    page,
    async (hasChooser) => {
      // Some editor versions open the native chooser on the toolbar click;
      // others merely reveal a file input. Arm before either click so the
      // direct path cannot escape the round and consume its one-shot handler.
      await clickToolbar();
      await page.waitForTimeout(100);
      if (hasChooser()) return;
      const selector = 'input[type="file"][name="file"]:not([disabled])';
      const visibleInputs = page.locator(selector).filter({ visible: true });
      const deadline = Date.now() + (options.visibleTimeoutMs ?? 5000);
      let uniqueSamples = 0;
      while (Date.now() <= deadline) {
        if (hasChooser()) return;
        const count = await visibleInputs.count();
        if (count > 1) throw new WechatFileChooserError("selector_mismatch");
        uniqueSamples = count === 1 ? uniqueSamples + 1 : 0;
        if (uniqueSamples >= 2) {
          if (!hasChooser()) await visibleInputs.click();
          return;
        }
        await page.waitForTimeout(50);
      }
      throw new WechatFileChooserError("selector_mismatch");
    },
    {
      timeoutMs:
        (options.visibleTimeoutMs ?? 5000) +
        (options.chooserTimeoutMs ?? 5000) +
        200,
      quiescenceMs: options.quiescenceMs,
    },
  );
}

export async function captureWechatFileInput(
  page: Page,
  clickToolbar: (hasChooser: () => boolean) => Promise<unknown>,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    quiescenceMs?: number;
  } = {},
) {
  if (taintedWechatChooserPages.has(page))
    throw new WechatFileChooserError("previous_round_failed");
  const selector = 'input[type="file"][name="file"]:not([disabled])';
  const timeoutMs = options.timeoutMs ?? 5000;
  const quiescenceMs = options.quiescenceMs ?? 20;
  const choosers: FileChooser[] = [];
  const chooserResolutions = new Map<FileChooser, Promise<void>>();
  let returnedChooser: FileChooser | undefined;
  let phase: "armed" | "waiting" | "quiescence" | "closed" = "armed";
  let clickSettled = false;
  let lateDuplicate = false;
  let resolveFirst!: () => void;
  const firstChooser = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  let rejectLifecycle!: (error: Error) => void;
  const lifecycle = new Promise<never>((_resolve, reject) => {
    rejectLifecycle = reject;
  });
  // Register before the click. Chromium may deliver the chooser immediately
  // after locator.click() resolves, so the first event remains accepted until
  // the shared round deadline. A short quiescence window then detects extras.
  const onChooser = (chooser: FileChooser) => {
    if (phase === "closed" || phase === "armed") return;
    choosers.push(chooser);
    if (choosers.length === 1) resolveFirst();
    else if (phase === "quiescence" || clickSettled) lateDuplicate = true;
  };
  const failLifecycle = (reason: WechatFileChooserFailureReason) =>
    rejectLifecycle(new WechatFileChooserError(reason));
  const resolveEmpty = (chooser: FileChooser) => {
    const existing = chooserResolutions.get(chooser);
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(() => chooser.setFiles([]))
      .catch((error: unknown) => {
        // Permit the final best-effort cleanup to retry a failed resolution,
        // while concurrent duplicate events share this one in-flight call.
        chooserResolutions.delete(chooser);
        throw error;
      });
    chooserResolutions.set(chooser, pending);
    return pending;
  };
  const onClose = () => failLifecycle("page_closed");
  const onAbort = () => failLifecycle("aborted");
  page.on("filechooser", onChooser);
  page.on("close", onClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => failLifecycle("timeout"), timeoutMs);
  // Lifecycle rejection is always observed, including a synchronous click
  // failure which wins the race below.
  void lifecycle.catch(() => undefined);
  try {
    if (options.signal?.aborted) throw new WechatFileChooserError("aborted");
    phase = "waiting";
    const click = Promise.resolve()
      .then(() => clickToolbar(() => choosers.length > 0))
      .then(
        () => {
          clickSettled = true;
        },
        (error: unknown) => {
          throw error;
        },
      );
    await Promise.race([Promise.all([click, firstChooser]), lifecycle]);
    phase = "quiescence";
    await Promise.race([page.waitForTimeout(quiescenceMs), lifecycle]);
    if (choosers.length !== 1) {
      // Resolve every intercepted native chooser without selecting a file.
      // Otherwise a late empty change can leak into a later upload round.
      await Promise.allSettled(choosers.map(resolveEmpty));
      throw new WechatFileChooserError(
        lateDuplicate ? "late_event" : "multiple_events",
      );
    }
    const chooser = choosers[0]!;
    const input = chooser.element();
    let state: "valid" | "detached" | "selector_mismatch";
    try {
      state = await input.evaluate((node, selector) => {
        if (!node.isConnected) return "detached";
        return (node as Element).matches(selector)
          ? "valid"
          : "selector_mismatch";
      }, selector);
    } catch {
      throw new WechatFileChooserError("detached");
    }
    if (state !== "valid") throw new WechatFileChooserError(state);
    returnedChooser = chooser;
    return chooser;
  } catch (error) {
    taintedWechatChooserPages.add(page);
    throw error;
  } finally {
    phase = "closed";
    if (!returnedChooser) await Promise.allSettled(choosers.map(resolveEmpty));
    clearTimeout(timer);
    page.off("filechooser", onChooser);
    page.off("close", onClose);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function armWechatImageUploadRequest(
  page: Page,
  payload: Awaited<ReturnType<typeof imagePayload>>,
  beforeCount: number,
  browserProof?: Promise<void>,
) {
  // Lightweight fakes used by pure fingerprint tests do not expose events. A
  // real Playwright Page always does, and therefore always takes this strict
  // request/response handshake path.
  if (typeof (page as unknown as { on?: unknown }).on !== "function")
    return null;
  let listener: ((request: Request) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let matched = 0;
  let requestCandidates = 0;
  let multipartCandidates = 0;
  let multipartBodiesReadable = 0;
  let multipartBoundaryFound = 0;
  let multipartParts = 0;
  let multipartFileFields = 0;
  let multipartFilenameMatches = 0;
  let multipartRawByteMatches = 0;
  let multipartMimeByteMatches = 0;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (listener) page.off("request", listener);
    if (error) rejectPromise(error);
    else resolvePromise();
  };
  const failure = (
    difference:
      | "upload_request_timeout"
      | "upload_request_invalid"
      | "upload_response_invalid",
  ) =>
    new WechatImageIdentityError(difference, beforeCount, beforeCount, {
      phase: "upload_request",
      ...(difference === "upload_request_timeout"
        ? {
            requestCandidates,
            multipartCandidates,
            multipartBodiesReadable,
            multipartBoundaryFound,
            multipartParts,
            multipartFileFields,
            multipartFilenameMatches,
            multipartRawByteMatches,
            multipartMimeByteMatches,
          }
        : {}),
    });
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    listener = (request) => {
      if (settled) return;
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        return;
      }
      // Header names and MIME types are case-insensitive, but the multipart
      // boundary parameter is not: it must match the request body byte-for-byte.
      const contentType = request.headers()["content-type"] ?? "";
      if (
        url.origin !== "https://mp.weixin.qq.com" ||
        request.method() !== "POST"
      )
        return;
      requestCandidates += 1;
      // Browser versions may submit this form as a navigation instead of an
      // XHR. Exact multipart bytes and the original frame, not resourceType,
      // provide the upload identity proof.
      if (!/^multipart\/form-data\s*;/i.test(contentType)) return;
      multipartCandidates += 1;
      let body: Buffer | null;
      try {
        body = request.postDataBuffer();
      } catch {
        finish(failure("upload_request_invalid"));
        return;
      }
      if (body) multipartBodiesReadable += 1;
      const multipart = inspectWechatMultipart(
        body ?? Buffer.alloc(0),
        contentType,
        payload,
      );
      multipartBoundaryFound += Number(multipart.boundaryFound);
      multipartParts += multipart.parts;
      multipartFileFields += multipart.fileFields;
      multipartFilenameMatches += multipart.named;
      multipartRawByteMatches += multipart.rawByteMatches;
      multipartMimeByteMatches += multipart.mimeByteMatches;
      if (multipart.named === 0) return;
      try {
        if (request.frame() !== page.mainFrame()) {
          finish(failure("upload_request_invalid"));
          return;
        }
      } catch {
        finish(failure("upload_request_invalid"));
        return;
      }
      if (multipart.named !== 1 || multipart.exact !== 1) {
        finish(failure("upload_request_invalid"));
        return;
      }
      matched += 1;
      if (matched !== 1) {
        finish(failure("upload_request_invalid"));
        return;
      }
      void (async () => {
        try {
          const response = await request.response();
          if (!response || !response.ok()) {
            finish(failure("upload_response_invalid"));
            return;
          }
          const responseError = await response.finished();
          if (responseError) {
            finish(failure("upload_response_invalid"));
            return;
          }
          const declared = Number(response.headers()["content-length"] ?? 0);
          if (declared > 1024 * 1024) {
            finish(failure("upload_response_invalid"));
            return;
          }
          const bytes = await response.body();
          if (bytes.length > 1024 * 1024) {
            finish(failure("upload_response_invalid"));
            return;
          }
          const json = JSON.parse(bytes.toString("utf8")) as Record<
            string,
            unknown
          >;
          if (!json || typeof json !== "object" || Array.isArray(json)) {
            finish(failure("upload_response_invalid"));
            return;
          }
          const base = json.base_resp as Record<string, unknown> | undefined;
          const status = [base?.ret, json.errcode, json.ret].filter(
            (value): value is number => typeof value === "number",
          );
          if (status.length === 0 || status.some((value) => value !== 0)) {
            finish(failure("upload_response_invalid"));
            return;
          }
          // Keep the listener armed for one short turn so two uploads of the
          // same payload cannot be mistaken for a single successful request.
          await page.waitForTimeout(100);
          finish();
        } catch {
          finish(failure("upload_response_invalid"));
        }
      })();
    };
    page.on("request", listener);
    timer = setTimeout(() => finish(failure("upload_request_timeout")), 45000);
  });
  // Chromium omits file-backed multipart bytes. A renderer witness binds the
  // original File hash to its own XHR/fetch response without replaying a request.
  void browserProof?.then(
    () => finish(),
    () => finish(failure("upload_response_invalid")),
  );
  // Attach a handler immediately; input-selection failures must not leave a
  // later timeout as an unhandled rejection.
  void promise.catch(() => undefined);
  return { promise, cancel: () => finish() };
}

export function inspectWechatMultipart(
  body: Buffer,
  contentType: string,
  payload: Awaited<ReturnType<typeof imagePayload>>,
) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  const counts = {
    boundaryFound: false,
    parts: 0,
    fileFields: 0,
    named: 0,
    rawByteMatches: 0,
    mimeByteMatches: 0,
    exact: 0,
  };
  if (!boundary) return counts;
  const delimiter = Buffer.from(`--${boundary}`);
  counts.boundaryFound = body.indexOf(delimiter) >= 0;
  let cursor = 0;
  while (true) {
    const start = body.indexOf(delimiter, cursor);
    if (start < 0) break;
    const headerStart = start + delimiter.length + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) break;
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next < 0) break;
    const headers = body.subarray(headerStart, headerEnd).toString("utf8");
    counts.parts += 1;
    const disposition =
      headers
        .split("\r\n")
        .find((line) => /^content-disposition:/i.test(line)) ?? "";
    const fileField = /(?:^|;)\s*name="file"(?:;|$)/i.test(disposition);
    if (fileField) counts.fileFields += 1;
    const filenameMatches = headers.includes(`filename="${payload.name}"`);
    if (filenameMatches) counts.named += 1;
    const contentEnd = next >= 2 ? next - 2 : next;
    const bytesMatch = body
      .subarray(headerEnd + 4, contentEnd)
      .equals(payload.buffer);
    if (bytesMatch) counts.rawByteMatches += 1;
    const mimeMatches = headers.split("\r\n").some((line) => {
      const colon = line.indexOf(":");
      return (
        colon > 0 &&
        line.slice(0, colon).toLowerCase() === "content-type" &&
        line
          .slice(colon + 1)
          .trim()
          .toLowerCase() === payload.mimeType.toLowerCase()
      );
    });
    if (bytesMatch && mimeMatches) counts.mimeByteMatches += 1;
    if (fileField && filenameMatches && bytesMatch && mimeMatches)
      counts.exact += 1;
    cursor = next;
  }
  return counts;
}

export async function stableFingerprintImageElement(
  page: Page,
  locatorOrFactory: Locator | (() => Locator),
  expected: ImageFingerprint,
  context?: {
    images: Locator;
    beforeCount: number;
    previousFingerprints: readonly ImageFingerprint[];
  },
  beforeSample?: (samples: number) => Promise<void>,
  captureDiagnostic?: Pick<WechatImageDiagnostic, "outerSample">,
) {
  let previous:
    (WechatImageDiagnostic & { fingerprint: ImageFingerprint }) | undefined;
  let consecutive = 0;
  let consecutiveCaptureFailures = 0;
  const maxSamples = 91;
  for (let samples = 1; samples <= maxSamples; samples += 1) {
    await beforeSample?.(samples);
    const locator =
      typeof locatorOrFactory === "function"
        ? locatorOrFactory()
        : locatorOrFactory;
    if (context)
      await assertWechatImageContinuity(
        page,
        context.images,
        context.beforeCount,
        context.previousFingerprints,
        samples,
      );
    let dimensions: { width: number; height: number };
    let resourceUrl: string;
    try {
      const state = await locator.evaluate((node) => {
        const image = node as HTMLImageElement;
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          resourceUrl: image.currentSrc || image.src,
        };
      });
      dimensions = { width: state.width, height: state.height };
      resourceUrl = state.resourceUrl;
    } catch {
      consecutiveCaptureFailures += 1;
      if (consecutiveCaptureFailures < 3) {
        await page.waitForTimeout(500);
        continue;
      }
      throw await captureStageError(
        context,
        "remote_dimensions_failed",
        samples,
        undefined,
        captureDiagnostic,
        consecutiveCaptureFailures,
      );
    }
    let fingerprint: ImageFingerprint;
    try {
      const remote = await fetchTrustedWechatImage(page, resourceUrl);
      fingerprint = await fingerprintImageBuffer(
        page,
        remote.buffer,
        remote.mimeType,
      );
    } catch (error) {
      consecutiveCaptureFailures += 1;
      if (consecutiveCaptureFailures < 3) {
        await page.waitForTimeout(500);
        continue;
      }
      const difference =
        error instanceof TrustedWechatImageError
          ? error.difference
          : error instanceof ImageFingerprintStageError
            ? error.stage
            : "canvas_fingerprint_failed";
      throw await captureStageError(
        context,
        difference,
        samples,
        dimensions,
        captureDiagnostic,
        consecutiveCaptureFailures,
      );
    }
    consecutiveCaptureFailures = 0;
    const current = { fingerprint, ...dimensions, samples };
    if (
      previous &&
      fingerprintSignature(previous.fingerprint) ===
        fingerprintSignature(fingerprint) &&
      previous.width === dimensions.width &&
      previous.height === dimensions.height
    )
      consecutive += 1;
    else consecutive = 1;
    if (consecutive >= 3 && fingerprintsMatch(expected, fingerprint))
      return current;
    previous = current;
    if (samples < maxSamples) await page.waitForTimeout(500);
  }
  return previous && consecutive >= 3
    ? previous
    : previous
      ? { ...previous, unstable: true as const }
      : null;
}

async function assertWechatImageContinuity(
  page: Page,
  images: Locator,
  beforeCount: number,
  previousFingerprints: readonly ImageFingerprint[],
  samples: number,
) {
  const afterCount = await safeImageCount(images, beforeCount);
  if (afterCount !== beforeCount + 1)
    throw new WechatImageIdentityError(
      afterCount === beforeCount ? "no_new_remote_image" : "unexpected_count",
      beforeCount,
      afterCount,
      { phase: "fingerprint_stability", samples },
    );
  let preserved = false;
  try {
    preserved = await page.evaluate((_marker) => {
      const state = window as unknown as {
        __turbopushWechatImageNodes?: Element[];
      };
      const before = state.__turbopushWechatImageNodes ?? [];
      const current = [
        ...document.querySelectorAll(
          ".rich_media_content .ProseMirror img:not(.ProseMirror-separator)",
        ),
      ];
      return before.every((node, index) => current[index] === node);
    }, "check-node-continuity");
  } catch {
    throw new WechatImageIdentityError(
      "node_snapshot_failed",
      beforeCount,
      afterCount,
      { phase: "fingerprint_stability", samples },
    );
  }
  if (preserved) return;
  if (previousFingerprints.length !== beforeCount)
    throw new WechatImageIdentityError(
      "existing_content_changed",
      beforeCount,
      afterCount,
      { phase: "content_verification", samples },
    );
  const actual: ImageFingerprint[] = [];
  try {
    for (let index = 0; index < beforeCount; index += 1) {
      const stable = await stableFingerprintImageElement(
        page,
        () => images.nth(index),
        previousFingerprints[index],
        undefined,
        async (prefixSample) => {
          const currentCount = await safeImageCount(images, beforeCount);
          if (currentCount !== beforeCount + 1)
            throw new WechatImageIdentityError(
              currentCount === beforeCount
                ? "no_new_remote_image"
                : "unexpected_count",
              beforeCount,
              currentCount,
              { phase: "content_verification", samples: prefixSample },
            );
        },
        { outerSample: samples },
      );
      if (!stable || "unstable" in stable)
        throw new Error("unstable prefix fingerprint");
      actual.push(stable.fingerprint);
    }
  } catch (error) {
    if (error instanceof WechatImageIdentityError)
      throw new WechatImageIdentityError(
        error.difference,
        beforeCount,
        await safeImageCount(images, beforeCount),
        { ...error.diagnostic, outerSample: samples },
      );
    throw new WechatImageIdentityError(
      "existing_content_changed",
      beforeCount,
      await safeImageCount(images, beforeCount),
      { phase: "content_verification", samples },
    );
  }
  const matchedIndexes = actual.map((fingerprint) =>
    previousFingerprints.findIndex((expected) =>
      fingerprintsMatch(expected, fingerprint),
    ),
  );
  const duplicate = matchedIndexes.some(
    (match, index) => match >= 0 && matchedIndexes.indexOf(match) !== index,
  );
  const reordered =
    !duplicate &&
    matchedIndexes.every((match) => match >= 0) &&
    matchedIndexes.some((match, index) => match !== index);
  const unchanged = actual.every((fingerprint, index) =>
    fingerprintsMatch(previousFingerprints[index], fingerprint),
  );
  if (!unchanged)
    throw new WechatImageIdentityError(
      duplicate
        ? "existing_content_duplicated"
        : reordered
          ? "existing_content_reordered"
          : "existing_content_changed",
      beforeCount,
      afterCount,
      { phase: "content_verification", samples },
    );
  try {
    await page.evaluate((_marker) => {
      const state = window as unknown as {
        __turbopushWechatImageNodes?: Element[];
      };
      state.__turbopushWechatImageNodes = [
        ...document.querySelectorAll(
          ".rich_media_content .ProseMirror img:not(.ProseMirror-separator)",
        ),
      ].slice(0, -1);
    }, "refresh-node-snapshot");
  } catch {
    throw new WechatImageIdentityError(
      "node_snapshot_failed",
      beforeCount,
      afterCount,
      { phase: "content_verification", samples },
    );
  }
}

async function safeImageCount(images: Locator, fallback: number) {
  try {
    return await images.count();
  } catch {
    return fallback;
  }
}

class TrustedWechatImageError extends Error {
  readonly difference:
    "remote_url_invalid" | "remote_fetch_failed" | "remote_response_invalid";

  constructor(
    difference:
      "remote_url_invalid" | "remote_fetch_failed" | "remote_response_invalid",
  ) {
    super(difference);
    this.difference = difference;
  }
}

function trustedWechatImageUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "mmbiz.qpic.cn" ||
      url.username ||
      url.password
    )
      throw new Error("untrusted");
    return url;
  } catch {
    throw new TrustedWechatImageError("remote_url_invalid");
  }
}

async function fetchTrustedWechatImage(page: Page, value: string) {
  const url = trustedWechatImageUrl(value);
  let response;
  try {
    response = await page.context().request.get(url.toString(), {
      timeout: 10000,
    });
  } catch {
    throw new TrustedWechatImageError("remote_fetch_failed");
  }
  trustedWechatImageUrl(response.url());
  const headers = response.headers();
  const mimeType = headers["content-type"]
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  const declaredLength = headers["content-length"]
    ? Number(headers["content-length"])
    : undefined;
  if (
    !response.ok() ||
    !mimeType ||
    !["image/png", "image/jpeg", "image/webp", "image/avif"].includes(
      mimeType,
    ) ||
    (declaredLength !== undefined &&
      (!Number.isSafeInteger(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > 10 * 1024 * 1024))
  )
    throw new TrustedWechatImageError("remote_response_invalid");
  let buffer: Buffer;
  try {
    buffer = await response.body();
  } catch {
    throw new TrustedWechatImageError("remote_fetch_failed");
  }
  if (buffer.length > 10 * 1024 * 1024)
    throw new TrustedWechatImageError("remote_response_invalid");
  return { buffer, mimeType };
}

async function screenshotLocatorClipFallback(page: Page, locator: Locator) {
  await locator.waitFor({ state: "visible", timeout: 3000 });
  const ready = await locator.evaluate((node) => {
    const image = node as HTMLImageElement;
    try {
      return (
        image.complete &&
        image.naturalWidth > 0 &&
        new URL(image.currentSrc || image.src).hostname === "mmbiz.qpic.cn"
      );
    } catch {
      return false;
    }
  });
  if (!ready) throw new Error("not ready");
  const second = await stableLocatorBox(page, locator);
  const viewport = page.viewportSize();
  if (
    !viewport ||
    second.x < 0 ||
    second.y < 0 ||
    second.x + second.width > viewport.width ||
    second.y + second.height > viewport.height ||
    second.width <= 0 ||
    second.height <= 0 ||
    second.width * second.height > 16_000_000
  )
    throw new Error("unsafe clip");
  return page.screenshot({
    animations: "disabled",
    type: "png",
    timeout: 10000,
    clip: second,
  });
}

async function stableLocatorBox(page: Page, locator: Locator) {
  const first = await locator.boundingBox();
  await page.waitForTimeout(100);
  const second = await locator.boundingBox();
  if (
    !first ||
    !second ||
    Math.abs(first.x - second.x) > 1 ||
    Math.abs(first.y - second.y) > 1 ||
    Math.abs(first.width - second.width) > 1 ||
    Math.abs(first.height - second.height) > 1
  )
    throw new Error("unstable bounds");
  return second;
}

async function captureStageError(
  context:
    | {
        images: Locator;
        beforeCount: number;
        previousFingerprints: readonly ImageFingerprint[];
      }
    | undefined,
  difference:
    | "remote_dimensions_failed"
    | "remote_scroll_failed"
    | "remote_screenshot_failed"
    | "bitmap_decode_failed"
    | "canvas_fingerprint_failed"
    | "remote_url_invalid"
    | "remote_fetch_failed"
    | "remote_response_invalid",
  samples: number,
  dimensions?: { width: number; height: number },
  extraDiagnostic?: Pick<WechatImageDiagnostic, "outerSample">,
  attempts?: number,
) {
  const beforeCount = context?.beforeCount ?? 0;
  const afterCount = context
    ? await safeImageCount(context.images, beforeCount)
    : beforeCount;
  return new WechatImageIdentityError(difference, beforeCount, afterCount, {
    phase: "fingerprint_stability",
    samples,
    ...extraDiagnostic,
    prefixSample:
      extraDiagnostic?.outerSample === undefined ? undefined : samples,
    attempts,
    width: dimensions?.width,
    height: dimensions?.height,
  });
}

function fingerprintSignature(fingerprint: ImageFingerprint) {
  return `${fingerprint.differenceHash}:${fingerprint.averageRgb.join(",")}`;
}

export async function fingerprintImageElement(
  page: Page,
  locator: ReturnType<Page["locator"]>,
) {
  await locator.scrollIntoViewIfNeeded({ timeout: 10000 });
  const screenshot = await locator.screenshot({
    animations: "disabled",
    type: "png",
    timeout: 10000,
  });
  return fingerprintImageBuffer(page, screenshot, "image/png");
}

class ImageFingerprintStageError extends Error {
  readonly stage: "bitmap_decode_failed" | "canvas_fingerprint_failed";

  constructor(stage: "bitmap_decode_failed" | "canvas_fingerprint_failed") {
    super(stage);
    this.stage = stage;
  }
}

export async function fingerprintImageBuffer(
  page: Page,
  buffer: Buffer,
  mimeType: string,
): Promise<ImageFingerprint> {
  const result = await page.evaluate(
    async ({ source, mimeType }) => {
      // Decode directly from bytes. A data: URL is subject to the host page's
      // img-src CSP (WeChat blocks it), while createImageBitmap on an in-memory
      // Blob does not navigate or fetch an external resource.
      const binary = atob(source);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
      let image: ImageBitmap;
      try {
        image = await createImageBitmap(new Blob([bytes], { type: mimeType }));
      } catch {
        return { failure: "bitmap_decode_failed" as const };
      }
      const rendered: FingerprintVariant[] = [];
      try {
        for (const mode of ["stretch", "contain", "cover"] as const) {
          const canvas = document.createElement("canvas");
          canvas.width = 17;
          canvas.height = 16;
          const context = canvas.getContext("2d", {
            willReadFrequently: true,
          });
          if (!context) throw new Error("canvas unavailable");
          context.fillStyle = "white";
          context.fillRect(0, 0, 17, 16);
          let width = 17;
          let height = 16;
          if (mode !== "stretch") {
            const scale =
              mode === "contain"
                ? Math.min(17 / image.width, 16 / image.height)
                : Math.max(17 / image.width, 16 / image.height);
            width = image.width * scale;
            height = image.height * scale;
          }
          context.drawImage(
            image,
            (17 - width) / 2,
            (16 - height) / 2,
            width,
            height,
          );
          const pixels = context.getImageData(0, 0, 17, 16).data;
          const bits: number[] = [];
          const sums = [0, 0, 0];
          for (let y = 0; y < 16; y += 1)
            for (let x = 0; x < 17; x += 1) {
              const offset = (y * 17 + x) * 4;
              sums[0] += pixels[offset];
              sums[1] += pixels[offset + 1];
              sums[2] += pixels[offset + 2];
              if (x < 16) {
                const gray =
                  pixels[offset] * 0.299 +
                  pixels[offset + 1] * 0.587 +
                  pixels[offset + 2] * 0.114;
                const next = offset + 4;
                const nextGray =
                  pixels[next] * 0.299 +
                  pixels[next + 1] * 0.587 +
                  pixels[next + 2] * 0.114;
                bits.push(gray > nextGray ? 1 : 0);
              }
            }
          rendered.push({
            differenceHash: Array.from({ length: 64 }, (_, index) =>
              bits
                .slice(index * 4, index * 4 + 4)
                .reduce((value, bit) => value * 2 + bit, 0)
                .toString(16),
            ).join(""),
            averageRgb: sums.map((sum) => Math.round(sum / 272)) as [
              number,
              number,
              number,
            ],
          });
        }
      } catch {
        return { failure: "canvas_fingerprint_failed" as const };
      } finally {
        image.close();
      }
      const [primary, ...alternatives] = rendered;
      return { fingerprint: { ...primary, alternatives } };
    },
    { source: buffer.toString("base64"), mimeType },
  );
  // Keep browser-side failures as a fixed enum. Never surface page exception
  // messages, source bytes, local names, or paths through progress events.
  if (result.failure) throw new ImageFingerprintStageError(result.failure);
  return "fingerprint" in result
    ? result.fingerprint
    : (result as unknown as ImageFingerprint);
}

function fingerprintDistances(a: ImageFingerprint, b: ImageFingerprint) {
  const variants = (value: ImageFingerprint): FingerprintVariant[] => [
    {
      differenceHash: value.differenceHash,
      averageRgb: value.averageRgb,
    },
    ...(value.alternatives ?? []),
  ];
  return variants(a).flatMap((left) =>
    variants(b).map((right) => {
      let hashDistance = 0;
      for (let index = 0; index < left.differenceHash.length; index += 1) {
        const xor =
          Number.parseInt(left.differenceHash[index], 16) ^
          Number.parseInt(right.differenceHash[index], 16);
        hashDistance += xor.toString(2).replaceAll("0", "").length;
      }
      const rgbDistance = left.averageRgb.reduce(
        (sum, value, index) => sum + Math.abs(value - right.averageRgb[index]),
        0,
      );
      return { hashDistance, rgbDistance };
    }),
  );
}

export function fingerprintDistance(a: ImageFingerprint, b: ImageFingerprint) {
  return fingerprintDistances(a, b).sort(
    (left, right) =>
      Math.max(left.hashDistance / 32, left.rgbDistance / 60) -
        Math.max(right.hashDistance / 32, right.rgbDistance / 60) ||
      left.hashDistance - right.hashDistance ||
      left.rgbDistance - right.rgbDistance,
  )[0];
}

export function fingerprintsMatch(a: ImageFingerprint, b: ImageFingerprint) {
  return fingerprintDistances(a, b).some(
    (distance) => distance.hashDistance <= 32 && distance.rgbDistance <= 60,
  );
}

export async function uploadCover(
  page: Page,
  payload: Awaited<ReturnType<typeof imagePayload>>,
) {
  await page.getByText("拖拽或选择封面", { exact: true }).click();
  await page.getByRole("link", { name: "从图片库选择", exact: true }).click();
  await page
    .locator('input[type=file][accept*="image/bmp"]')
    .setInputFiles(payload);
  const tile = page
    .locator(".weui-desktop-img-picker__item")
    .filter({ has: page.getByText(payload.name, { exact: true }) });
  await tile.waitFor({ timeout: 45000 });
  // Upload may select automatically. Select only if not already selected.
  if (!(await tile.getAttribute("class"))?.includes("selected"))
    await tile.locator("i").click();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.waitForFunction(
    () =>
      !!(
        document.querySelector(
          "#js_cover_area .js_cover_preview_new",
        ) as HTMLElement | null
      )?.style.backgroundImage,
    undefined,
    { timeout: 45000 },
  );
}

export async function verifyWechatMedia(
  page: Page,
  expected: readonly ImageFingerprint[],
  cover: boolean,
) {
  await page.waitForFunction(
    ({ count, cover }) => {
      const images = [
        ...document.querySelectorAll(".rich_media_content .ProseMirror img"),
      ].filter((el) => !el.classList.contains("ProseMirror-separator"));
      return (
        images.length === count &&
        images.every((node) => {
          const image = node as HTMLImageElement;
          try {
            return (
              image.complete &&
              image.naturalWidth > 0 &&
              new URL(image.currentSrc || image.src).hostname ===
                "mmbiz.qpic.cn"
            );
          } catch {
            return false;
          }
        }) &&
        (!cover ||
          !!(
            document.querySelector(
              "#js_cover_area .js_cover_preview_new",
            ) as HTMLElement | null
          )?.style.backgroundImage)
      );
    },
    { count: expected.length, cover },
    { timeout: 20000 },
  );
  const images = page.locator(
    ".rich_media_content .ProseMirror img:not(.ProseMirror-separator)",
  );
  for (let index = 0; index < expected.length; index += 1) {
    const stable = await stableFingerprintImageElement(
      page,
      images.nth(index),
      expected[index],
    );
    if (!stable || "unstable" in stable) {
      const distance = stable
        ? fingerprintDistance(expected[index], stable.fingerprint)
        : undefined;
      throw new WechatImageIdentityError(
        "stability_timeout",
        expected.length,
        expected.length,
        {
          samples: stable?.samples ?? 0,
          width: stable?.width,
          height: stable?.height,
          hashDistance: distance?.hashDistance,
          rgbDistance: distance?.rgbDistance,
        },
      );
    }
    const distance = fingerprintDistance(expected[index], stable.fingerprint);
    if (!fingerprintsMatch(expected[index], stable.fingerprint))
      throw new WechatImageIdentityError(
        "content_mismatch",
        expected.length,
        expected.length,
        {
          samples: stable.samples,
          width: stable.width,
          height: stable.height,
          hashDistance: distance.hashDistance,
          rgbDistance: distance.rgbDistance,
        },
      );
  }
}
