import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_NAME = ".turbopush-engine.lock";

interface LockMetadata {
  version: 1;
  owner: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export interface InstanceLock {
  readonly path: string;
  readonly owner: string;
  release(): void;
}

export function acquireInstanceLock(directory: string): InstanceLock {
  const dataDirectory = resolve(directory);
  mkdirSync(dataDirectory, { recursive: true });
  const path = resolve(dataDirectory, LOCK_NAME);
  const metadata: LockMetadata = {
    version: 1,
    owner: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(metadata)}\n`, "utf8");
      closeSync(fd);
      fd = undefined;
      return ownedLock(path, metadata.owner);
    } catch (error) {
      if (fd !== undefined) {
        closeSync(fd);
        try {
          unlinkSync(path);
        } catch {
          // Preserve the original creation error.
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readMetadata(path);
      if (attempt > 0 || !existing || !isDefinitelyStale(existing))
        throw new Error(
          `此数据目录已有 TurboPush 引擎运行（PID ${existing?.pid ?? "未知"}），请关闭后重试`,
        );
      // Only same-host ESRCH is considered stale. EPERM, malformed metadata,
      // foreign hosts and PID reuse all fail closed rather than killing a lock.
      const current = readMetadata(path);
      if (!current || current.owner !== existing.owner)
        throw new Error("引擎锁在检查期间已改变，请重试");
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
          throw unlinkError;
      }
    }
  }
  throw new Error("无法取得 TurboPush 引擎锁");
}

function ownedLock(path: string, owner: string): InstanceLock {
  let released = false;
  return {
    path,
    owner,
    release() {
      if (released) return;
      released = true;
      const current = readMetadata(path);
      if (!current || current.owner !== owner) return;
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function readMetadata(path: string): LockMetadata | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockMetadata>;
    if (
      value.version !== 1 ||
      typeof value.owner !== "string" ||
      !value.owner ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.hostname !== "string" ||
      typeof value.createdAt !== "string"
    )
      return null;
    return value as LockMetadata;
  } catch {
    return null;
  }
}

function isDefinitelyStale(metadata: LockMetadata | null) {
  if (!metadata || metadata.hostname !== hostname()) return false;
  try {
    process.kill(metadata.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
