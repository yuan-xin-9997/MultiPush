import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { importImages } from "../packages/publisher-engine/src/assets.ts";

test("managed images preserve bytes, deduplicate, and survive source removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-assets-"));
  try {
    const bytes = await readFile(
      resolve("apps/desktop/src-tauri/icons/icon.png"),
    );
    const source = join(directory, "source.png");
    await writeFile(source, bytes);
    const [target] = await importImages(directory, [source]);
    assert.deepEqual(await readFile(source), bytes);
    assert.deepEqual(await importImages(directory, [source]), [target]);
    await rm(source);
    assert.deepEqual(await readFile(target), bytes);
    await writeFile(target, "corrupt");
    await writeFile(source, bytes);
    await assert.rejects(importImages(directory, [source]), /已损坏/);
    assert.equal(await readFile(target, "utf8"), "corrupt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed images reject non-images and relative paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-assets-"));
  try {
    const source = join(directory, "fake.png");
    await writeFile(source, "not an image");
    await assert.rejects(importImages(directory, [source]), /PNG\/JPEG/);
    await assert.rejects(importImages(directory, ["relative.png"]), /绝对路径/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed image import validates the whole batch before copying", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-assets-"));
  try {
    const valid = resolve("apps/desktop/src-tauri/icons/icon.png");
    const invalid = join(directory, "invalid.jpg");
    await writeFile(invalid, "not a jpeg");
    await assert.rejects(importImages(directory, [valid, invalid]), /PNG\/JPEG/);
    await assert.rejects(readFile(join(directory, "assets")), /EISDIR|ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed image names are content addressed and preserve input order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-assets-"));
  try {
    const source = resolve("apps/desktop/src-tauri/icons/icon.png");
    const imported = await importImages(directory, [source, source]);
    assert.equal(imported.length, 2);
    assert.equal(imported[0], imported[1]);
    assert.equal(resolve(imported[0]), imported[0]);
    assert.equal(resolve(imported[0], ".."), resolve(directory, "assets"));
    assert.match(imported[0], /[\\/]assets[\\/][a-f0-9]{64}\.png$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
