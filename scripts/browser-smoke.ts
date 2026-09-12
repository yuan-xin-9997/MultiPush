import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Real browser, local fixture only. Never uses or modifies personal browser profiles.
const directory = await mkdtemp(join(tmpdir(), "turbopush-browser-"));
const server = createServer((_req, res) =>
  res.end(
    "<!doctype html><title>Profile fixture</title><p>Local profile verification</p>",
  ),
);
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No local fixture port");
const url = `http://127.0.0.1:${address.port}`;
const channel = process.env.TURBOPUSH_BROWSER_CHANNEL;
const options = { headless: true, ...(channel ? { channel } : {}) };
let context:
  Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
try {
  context = await chromium.launchPersistentContext(
    join(directory, "account-a"),
    options,
  );
  await context.pages()[0].goto(url);
  await context.pages()[0].evaluate(() => localStorage.setItem("account", "a"));
  await context.addCookies([
    {
      name: "session",
      value: "fixture-a",
      url,
      expires: Date.now() / 1000 + 3600,
    },
  ]);
  await context.close();
  context = undefined;
  context = await chromium.launchPersistentContext(
    join(directory, "account-a"),
    options,
  );
  await context.pages()[0].goto(url);
  assert.equal(
    await context.pages()[0].evaluate(() => localStorage.getItem("account")),
    "a",
  );
  assert.equal(
    (await context.cookies()).find((c) => c.name === "session")?.value,
    "fixture-a",
  );
  await context.close();
  context = undefined;
  context = await chromium.launchPersistentContext(
    join(directory, "account-b"),
    options,
  );
  await context.pages()[0].goto(url);
  assert.equal(
    await context.pages()[0].evaluate(() => localStorage.getItem("account")),
    null,
  );
  assert.equal((await context.cookies()).length, 0);
  console.log(
    "PASS: persistent profile and cookies survive restart; another account remains isolated",
  );
} finally {
  await context?.close();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  await rm(directory, { recursive: true, force: true });
}
