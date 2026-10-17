import { invoke, isTauri } from "@tauri-apps/api/core";

import type { RpcRequest, RpcResponse } from "@turbopush/shared";

export async function rpc<T>(
  method: RpcRequest["method"],

  params?: unknown,
): Promise<T> {
  const request: RpcRequest = { id: crypto.randomUUID(), method, params };

  const response: RpcResponse = isTauri()
    ? await invoke("rpc", { request })
    : await fetch("/__rpc", {
        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify(request),
      }).then((r) => r.json());

  if (response.error) throw new Error(response.error.message);

  return response.result as T;
}

export async function pickImages(multiple: boolean): Promise<string[] | null> {
  if (!isTauri()) return null;

  return invoke<string[]>("pick_images", { multiple });
}

export function isDesktopApp(): boolean {
  return isTauri();
}

export async function choosePortableArchiveDestination(): Promise<
  string | null
> {
  if (!isTauri()) return null;

  return invoke<string | null>("choose_portable_archive_destination");
}

export async function pickPortableArchive(): Promise<string | null> {
  if (!isTauri()) return null;

  return invoke<string | null>("pick_portable_archive");
}

export async function uploadImages(files: File[]): Promise<string[]> {
  if (files.length > 20) throw new Error("最多选择20张图片");

  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) throw new Error("单张图片不得超过10MB");
  }

  const paths: string[] = [];

  for (const file of files) {
    const response = await fetch("/__upload", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });

    const data = await response.json();

    if (!response.ok || data.error)
      throw new Error(data.error?.message ?? "图片上传失败");

    paths.push(data.result);
  }

  return paths;
}
