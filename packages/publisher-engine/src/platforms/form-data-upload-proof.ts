import { createHash, randomUUID } from "node:crypto";
import type { Page } from "playwright";

/** Observe the original FormData and its own response without changing or replaying the request. */
export async function armFormDataUploadProof(
  page: Page,
  payload: { name: string; mimeType: string; buffer: Buffer },
  origin: string,
  profile: "wechat" | "xiaohongshu" = "wechat",
) {
  const round = randomUUID();
  // tsx's name-preservation helper is otherwise outside serialized callbacks.
  const removeNameHelper = await page.evaluate<boolean>(
    `(() => { if (location.origin !== ${JSON.stringify(origin)} || globalThis.__turbopushUploadProof || '__name' in globalThis) return false; globalThis.__name = value => value; return true; })()`,
  );
  const installed = await page.evaluate(
    ({ round, expected, origin, removeNameHelper, profile }) => {
      const host = window as unknown as {
        __name?: unknown;
        __turbopushUploadProof?: {
          round: string;
          matches: number;
          completed: number;
          invalid: boolean;
          cleanup: () => void;
        };
      };
      if (location.origin !== origin || host.__turbopushUploadProof)
        return false;
      const nameHelper = host.__name;
      const originalFetch = window.fetch;
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      const targets = new WeakMap<
        XMLHttpRequest,
        { method: string; url: string }
      >();
      const state = {
        round,
        matches: 0,
        completed: 0,
        invalid: false,
        cleanup: () => {},
      };
      host.__turbopushUploadProof = state;
      const trusted = (value: string) => {
        const url = new URL(value, location.href);
        if (url.username || url.password) return false;
        return (
          url.origin === origin ||
          (profile === "xiaohongshu" &&
            url.protocol === "https:" &&
            /\.(xiaohongshu\.com|xhscdn\.com|xhsimg\.com|qcloudcos\.com|myqcloud\.com|aliyuncs\.com|qiniup\.com)$/.test(
              url.hostname,
            ))
        );
      };
      const storage = (value: string) => {
        const url = new URL(value, location.href);
        return (
          profile === "xiaohongshu" &&
          trusted(value) &&
          (url.origin !== origin || url.hostname === "127.0.0.1")
        );
      };
      const readableBody = (body: unknown) =>
        body instanceof FormData ||
        (profile === "xiaohongshu" &&
          (body instanceof Blob ||
            body instanceof ArrayBuffer ||
            ArrayBuffer.isView(body)));
      const decodeResponse = (text: string, url: string) => {
        if (text.length > 1_000_000)
          throw new Error("Oversized upload response");
        if (storage(url) && !text.trim()) return null;
        try {
          return JSON.parse(text);
        } catch {
          if (storage(url)) return null;
          throw new Error("Invalid upload response");
        }
      };
      const successful = (status: number, json: unknown, url: string) => {
        if (storage(url) && status >= 200 && status < 300 && json === null)
          return true;
        if (
          status < 200 ||
          status >= 300 ||
          !json ||
          typeof json !== "object" ||
          Array.isArray(json)
        )
          return false;
        if (JSON.stringify(json).length > 1_000_000) return false;
        const value = json as {
          base_resp?: { ret?: unknown };
          errcode?: unknown;
          ret?: unknown;
          code?: unknown;
        };
        const codes = [
          value.base_resp?.ret,
          value.errcode,
          value.ret,
          ...(profile === "xiaohongshu" ? [value.code] : []),
        ].filter((code) => typeof code === "number");
        if (storage(url) && !("error" in value))
          return codes.every((code) => code === 0);
        return codes.length > 0 && codes.every((code) => code === 0);
      };
      const inspect = (
        method: string,
        target: string,
        body: unknown,
        response: Promise<{ status: number; json: unknown }>,
      ) => {
        // Every rejection is handled, including responses belonging to unrelated requests.
        void response.catch(() => undefined);
        let url: URL;
        try {
          url = new URL(target, location.href);
        } catch {
          return;
        }
        if (
          !(profile === "xiaohongshu" ? ["POST", "PUT"] : ["POST"]).includes(
            method.toUpperCase(),
          ) ||
          !trusted(url.href) ||
          !readableBody(body)
        )
          return;
        let files: [string, File][];
        if (body instanceof FormData)
          files = [...body.entries()].filter(
            (entry): entry is [string, File] => entry[1] instanceof File,
          );
        else {
          const part =
            body instanceof Blob || body instanceof ArrayBuffer
              ? body
              : ArrayBuffer.isView(body)
                ? new Uint8Array(
                    body.buffer,
                    body.byteOffset,
                    body.byteLength,
                  ).slice()
                : null;
          if (!part) return;
          files = [
            [
              "file",
              body instanceof File
                ? body
                : new File([part], "", { type: expected.mimeType }),
            ],
          ];
        }
        if (!files.length) return;
        void (async () => {
          const matches = [];
          for (const [field, file] of files) {
            if (
              file.size !== expected.size ||
              (profile === "wechat" &&
                file.type.toLowerCase() !== expected.mimeType.toLowerCase())
            ) {
              if (file.name === expected.name) state.invalid = true;
              continue;
            }
            const digest = [
              ...new Uint8Array(
                await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
              ),
            ]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
            if (digest === expected.hash && field === "file")
              matches.push(file);
            else if (file.name === expected.name) state.invalid = true;
          }
          if (!matches.length) return;
          state.matches += matches.length;
          if (state.matches !== 1) {
            state.invalid = true;
            return;
          }
          const result = await response;
          if (!successful(result.status, result.json, url.href)) {
            state.invalid = true;
            return;
          }
          state.completed++;
        })().catch(() => {
          state.invalid = true;
        });
      };
      const fetchWrapper: typeof fetch = function (this: Window, input, init) {
        const result = Reflect.apply(originalFetch, this, [
          input,
          init,
        ]) as ReturnType<typeof fetch>;
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        const url = input instanceof Request ? input.url : String(input);
        if (readableBody(init?.body))
          inspect(
            method,
            url,
            init?.body,
            result.then(async (response) => {
              if (
                !trusted(response.url) ||
                Number(response.headers.get("content-length") ?? 0) > 1_000_000
              )
                throw new Error("Invalid upload response");
              const text = await response.clone().text();
              if (text.length > 1_000_000)
                throw new Error("Oversized upload response");
              return {
                status: response.status,
                json: decodeResponse(text, response.url),
              };
            }),
          );
        return result;
      };
      const openWrapper = function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ) {
        targets.set(this, { method, url: String(url) });
        return Reflect.apply(originalOpen, this, [method, url, ...rest]);
      } as typeof originalOpen;
      const sendWrapper: typeof originalSend = function (
        this: XMLHttpRequest,
        body,
      ) {
        const target = targets.get(this);
        if (target && readableBody(body)) {
          const response = new Promise<{ status: number; json: unknown }>(
            (resolve, reject) => {
              this.addEventListener(
                "load",
                () => {
                  try {
                    if (
                      !trusted(this.responseURL) ||
                      Number(this.getResponseHeader("content-length") ?? 0) >
                        1_000_000
                    )
                      throw new Error("Invalid upload response");
                    resolve({
                      status: this.status,
                      json:
                        this.responseType === "json"
                          ? this.response
                          : decodeResponse(this.responseText, this.responseURL),
                    });
                  } catch {
                    reject(new Error("Invalid upload response"));
                  }
                },
                { once: true },
              );
              this.addEventListener(
                "error",
                () => reject(new Error("Upload failed")),
                { once: true },
              );
              this.addEventListener(
                "abort",
                () => reject(new Error("Upload aborted")),
                { once: true },
              );
              this.addEventListener(
                "timeout",
                () => reject(new Error("Upload timeout")),
                { once: true },
              );
            },
          );
          inspect(target.method, target.url, body, response);
        }
        return Reflect.apply(originalSend, this, [body]);
      };
      state.cleanup = () => {
        if (window.fetch === fetchWrapper) window.fetch = originalFetch;
        if (XMLHttpRequest.prototype.open === openWrapper)
          XMLHttpRequest.prototype.open = originalOpen;
        if (XMLHttpRequest.prototype.send === sendWrapper)
          XMLHttpRequest.prototype.send = originalSend;
        if (host.__turbopushUploadProof === state)
          delete host.__turbopushUploadProof;
        if (removeNameHelper && host.__name === nameHelper) delete host.__name;
      };
      window.fetch = fetchWrapper;
      XMLHttpRequest.prototype.open = openWrapper;
      XMLHttpRequest.prototype.send = sendWrapper;
      return true;
    },
    {
      round,
      origin,
      removeNameHelper,
      profile,
      expected: {
        name: payload.name,
        size: payload.buffer.length,
        mimeType: payload.mimeType,
        hash: createHash("sha256").update(payload.buffer).digest("hex"),
      },
    },
  );
  if (installed !== true) return null;
  const promise = (async () => {
    await page.waitForFunction(
      (round) => {
        const state = (
          window as unknown as {
            __turbopushUploadProof?: {
              round: string;
              completed: number;
              invalid: boolean;
            };
          }
        ).__turbopushUploadProof;
        return state?.round === round && (state.invalid || state.completed > 0);
      },
      round,
      { timeout: 45000 },
    );
    await page.waitForTimeout(100);
    const valid = await page.evaluate((round) => {
      const state = (
        window as unknown as {
          __turbopushUploadProof?: {
            round: string;
            matches: number;
            completed: number;
            invalid: boolean;
          };
        }
      ).__turbopushUploadProof;
      return (
        state?.round === round &&
        !state.invalid &&
        state.matches === 1 &&
        state.completed === 1
      );
    }, round);
    if (!valid) throw new Error("上传文件或对应响应不能唯一核对");
  })();
  void promise.catch(() => undefined);
  return {
    promise,
    cancel: async () => {
      await page
        .evaluate((round) => {
          const state = (
            window as unknown as {
              __turbopushUploadProof?: { round: string; cleanup: () => void };
            }
          ).__turbopushUploadProof;
          if (state?.round === round) state.cleanup();
        }, round)
        .catch(() => undefined);
    },
  };
}
