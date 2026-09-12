import { createInterface } from "node:readline";
import { resolve } from "node:path";
import pino from "pino";
import { Service } from "./service.ts";

// stdout is exclusively JSON RPC; operational logs go to stderr.
const logger = pino({ level: "info" }, pino.destination(2));
const service = new Service(resolve(process.env.TURBOPUSH_DATA_DIR ?? ".data"));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
logger.info("Engine started");
try {
  for await (const line of input) {
    try {
      if (Buffer.byteLength(line) > 1_000_000) throw new Error("请求过大");
      const response = await service.dispatch(JSON.parse(line));
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ id: null, error: { code: "INVALID_REQUEST", message: "请求不是有效JSON，或超过1MB限制" } })}\n`,
      );
    }
  }
} finally {
  await service.close();
  logger.info("Engine stopped");
}
