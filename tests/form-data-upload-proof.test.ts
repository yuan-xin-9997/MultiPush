import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { armFormDataUploadProof } from "../packages/publisher-engine/src/platforms/form-data-upload-proof.ts";

test("FormData上传证明绑定文件哈希和同一响应，拒绝错图、失败响应与重复上传，并恢复原始方法", async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method === "POST") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            base_resp: { ret: request.url === "/fail" ? 1 : 0 },
          }),
        );
      } else {
        response.setHeader("Content-Type", "text/html");
        response.end('<input type="file">');
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    for (const mode of [
      "fetch",
      "xhr",
      "wrong-bytes",
      "response-failed",
      "duplicate",
      "unrelated",
      "raw-fetch",
      "raw-xhr",
    ]) {
      const page = await browser.newPage();
      try {
        await page.goto(origin);
        await page.evaluate(() => {
          (window as unknown as { originalFetch: unknown }).originalFetch =
            window.fetch;
        });
        const payload = {
          name: "proof.png",
          mimeType: "image/png",
          buffer: Buffer.from("expected-image-bytes"),
        };
        const proof = await armFormDataUploadProof(page, payload, origin, mode.startsWith("raw-") ? "xiaohongshu" : "wechat");
        assert.ok(proof);
        const outcome = proof.promise.then(
          () => true,
          () => false,
        );
        await page.evaluate(async (mode) => {
          const form = (body: string, name = "proof.png") => {
            const value = new FormData();
            value.append("file", new File([body], name, { type: "image/png" }));
            return value;
          };
          if (mode === "raw-fetch") {
            await fetch("/ok", { method: "PUT", body: new TextEncoder().encode("expected-image-bytes") });
          } else if (mode === "raw-xhr") {
            await new Promise<void>((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open("PUT", "/ok"); xhr.onload = () => resolve(); xhr.onerror = reject; xhr.send(new Blob(["expected-image-bytes"], { type: "image/png" })); });
          } else if (mode === "xhr") {
            await new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open("POST", "/ok");
              xhr.onload = () => resolve();
              xhr.onerror = reject;
              xhr.send(form("expected-image-bytes"));
            });
          } else {
            if (mode === "unrelated")
              await fetch("/ok", {
                method: "POST",
                body: form("unrelated-image", "other.png"),
              });
            const requests = [
              fetch(mode === "response-failed" ? "/fail" : "/ok", {
                method: "POST",
                body: form(
                  mode === "wrong-bytes"
                    ? "wrong-image-contents"
                    : "expected-image-bytes",
                ),
              }),
            ];
            if (mode === "duplicate")
              requests.push(
                fetch("/ok", {
                  method: "POST",
                  body: form("expected-image-bytes"),
                }),
              );
            await Promise.all(requests);
          }
        }, mode);
        assert.equal(
          await outcome,
          ["fetch", "xhr", "unrelated", "raw-fetch", "raw-xhr"].includes(mode),
          mode,
        );
        await proof.cancel();
        assert.equal(
          await page.evaluate(
            () =>
              window.fetch ===
              (window as unknown as { originalFetch: unknown }).originalFetch,
          ),
          true,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
