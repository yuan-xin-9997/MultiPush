import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

for (const mode of ["source", "built"])
  test(
    `${mode} sidecar accepts sequential JSON RPC, isolates malformed messages, and closes on EOF`,
    { timeout: 20_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "turbopush-stdio-"));
      try {
        const args =
          mode === "source"
            ? [
                "--import",
                "tsx",
                resolve("packages/publisher-engine/src/stdio.ts"),
              ]
            : [resolve("packages/publisher-engine/dist/stdio.js")];
        const child = spawn(process.execPath, args, {
          env: { ...process.env, TURBOPUSH_DATA_DIR: directory },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => (stdout += data));
        child.stderr.on("data", (data) => (stderr += data));
        const completion = new Promise<number | null>((done, reject) => {
          child.on("exit", done);
          child.on("error", reject);
        });
        child.stdin.end(
          "invalid-json\n" +
            JSON.stringify({
              id: 1,
              method: "account.create",
              params: { platform: "zhihu", name: "中文账号" },
            }) +
            "\n" +
            JSON.stringify({ id: 2, method: "snapshot" }) +
            "\n",
        );
        assert.equal(await completion, 0, stderr);
        const replies = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(replies.length, 3);
        assert.equal(replies[0].error.code, "INVALID_REQUEST");
        assert.equal(replies[1].id, 1);
        assert.equal(replies[2].result.accounts[0].name, "中文账号");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
