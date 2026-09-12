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

export async function choosePortableArchiveDestination(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("choose_portable_archive_destination");
}

export async function pickPortableArchive(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("pick_portable_archive");
}
