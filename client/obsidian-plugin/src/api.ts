import { requestUrl } from "obsidian";
import type { ChangesPage, DeviceInfo, HermesQueueItem, NoteVersionInfo, NoteVersionPayload, PushChange, PushResponse } from "./types";

interface ChangePageOptions {
  limit?: number;
  cursor?: number;
  checkpoint?: string;
}

export class SyncApi {
  constructor(private readonly getServerUrl: () => string, private readonly getToken: () => string) {}

  async register(vaultName: string, password: string, deviceName: string, platform: string, clientInstanceId: string): Promise<{ vault_id: string; device_id: string; token: string }> {
    return this.request("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ vault_name: vaultName, password, device_name: deviceName, platform, client_instance_id: clientInstanceId }),
      auth: false
    });
  }

  async login(vaultId: string, password: string, deviceName: string, platform: string, clientInstanceId: string): Promise<{ device_id: string; token: string }> {
    return this.request("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ vault_id: vaultId, password, device_name: deviceName, platform, client_instance_id: clientInstanceId }),
      auth: false
    });
  }

  async changes(since: string, options: ChangePageOptions = {}): Promise<ChangesPage> {
    const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
    if (since) {
      params.set("since", since);
    }
    if (typeof options.cursor === "number") {
      params.set("cursor", String(options.cursor));
    }
    if (options.checkpoint) {
      params.set("until", options.checkpoint);
    }
    return this.request<ChangesPage>(`/api/v1/sync/changes?${params.toString()}`, { method: "GET" });
  }

  async push(changes: PushChange[]): Promise<PushResponse> {
    return this.request("/api/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({ changes })
    });
  }

  async history(pathHash: string): Promise<NoteVersionInfo[]> {
    const params = new URLSearchParams({ path_hash: pathHash });
    const response = await this.request<{ versions: NoteVersionInfo[] }>(`/api/v1/sync/history?${params.toString()}`);
    return response.versions;
  }

  async historyPayload(versionId: number): Promise<NoteVersionPayload> {
    return this.request(`/api/v1/sync/history/${versionId}`);
  }

  async restoreVersion(versionId: number): Promise<void> {
    await this.request(`/api/v1/sync/history/${versionId}/restore`, { method: "POST" });
  }

  async devices(): Promise<DeviceInfo[]> {
    const response = await this.request<{ devices: DeviceInfo[] }>("/api/v1/devices");
    return response.devices;
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.request(`/api/v1/devices/${deviceId}`, { method: "DELETE" });
  }

  async hermesQueue(): Promise<HermesQueueItem[]> {
    const params = new URLSearchParams({ status: "pending", limit: "20" });
    const response = await this.request<{ items: HermesQueueItem[] }>(`/api/v1/hermes/queue?${params.toString()}`);
    return response.items;
  }

  async completeHermesQueueItem(itemId: number): Promise<void> {
    await this.request(`/api/v1/hermes/queue/${itemId}/complete`, { method: "POST" });
  }

  async request<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    if (init.auth !== false) {
      const token = this.getToken();
      if (!token) {
        throw new Error("Missing sync token");
      }
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await requestUrl({
      url: `${this.getServerUrl().replace(/\/$/, "")}${path}`,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : undefined,
      headers
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Sync API ${response.status}: ${response.text}`);
    }
    return response.json as T;
  }
}
