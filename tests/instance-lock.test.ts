import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostname } from "node:os";
import { acquireInstanceLock } from "../packages/publisher-engine/src/instance-lock.ts";
import { Service } from "../packages/publisher-engine/src/service.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "turbopush-lock-"));
  return {
    directory,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("second engine instance is rejected and release permits reopening", () => {
  const f = fixture();
  try {
    const first = acquireInstanceLock(f.directory);
    assert.throws(() => acquireInstanceLock(f.directory), /已有.*引擎运行/);
    first.release();
    const second = acquireInstanceLock(f.directory);
    second.release();
  } finally {
    f.close();
  }
});

test("an owner never deletes a lock that has been replaced", () => {
  const f = fixture();
  try {
    const lock = acquireInstanceLock(f.directory);
    const replacement = {
      version: 1,
      owner: "replacement-owner",
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(lock.path, JSON.stringify(replacement));
    lock.release();
    assert.equal(JSON.parse(readFileSync(lock.path, "utf8")).owner, replacement.owner);
  } finally {
    f.close();
  }
});

test("definitely dead same-host locks are reclaimed conservatively", () => {
  const f = fixture();
  try {
    const path = join(f.directory, ".turbopush-engine.lock");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        owner: "dead-owner",
        pid: 2_147_483_647,
        hostname: hostname(),
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const lock = acquireInstanceLock(f.directory);
    assert.notEqual(lock.owner, "dead-owner");
    lock.release();

    writeFileSync(path, "not-json");
    assert.throws(() => acquireInstanceLock(f.directory), /PID 未知/);
  } finally {
    f.close();
  }
});

test("Service holds the directory lock for its full lifecycle", async () => {
  const f = fixture();
  const first = new Service(f.directory);
  try {
    assert.throws(() => new Service(f.directory), /已有.*引擎运行/);
    await first.close();
    const reopened = new Service(f.directory);
    await reopened.close();
  } finally {
    await first.close();
    f.close();
  }
});
