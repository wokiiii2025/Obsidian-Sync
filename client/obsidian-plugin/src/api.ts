import type { PushChange, PushResponse, RemoteChange } from "./types";

export class SyncApi {
  constructor(private readonly getServerUrl: () => string, private readonly getToken: () => string) {}

  async register(vaultName: string, password: string, deviceName: string, platform: string): Promise<{ vault_id: string; device_id: string; token: string }> {
    return this.request("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ vault_name: vaultName, password, device_name: deviceName, platform }),
      auth: false
    });
  }

  async login(vaultId: string, password: string, deviceName: string, platform: string): Promise<{ device_id: string; token: string }> {
    return this.request("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ vault_id: vaultId, password, device_name: deviceName, platform }),
      auth: false
    });
  }

  async changes(since: string, limit = 100): Promise<RemoteChange[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (since) {
      params.set("since", since);
    }
    const response = await this.request<{ changes: RemoteChange[] }>(`/api/v1/sync/changes?${params.toString()}`, { method: "GET" });
    return response.changes;
  }

  async push(changes: PushChange[]): Promise<PushResponse> {
    return this.request("/api/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({ changes })
    });
  }

  private async request<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (init.auth !== false) {
      const token = this.getToken();
      if (!token) {
        throw new Error("Missing sync token");
      }
      headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetch(`${this.getServerUrl().replace(/\/$/, "")}${path}`, {
      ...init,
      headers
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sync API ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
  }
}
