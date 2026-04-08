import { loadConfig, getServerUrl, type Config } from "../config/config-store.js";
import { loadCredentials } from "../config/credentials-store.js";
import { ApiError, NetworkError } from "./errors.js";

export interface ClientOptions {
  server?: string;
  apiKey?: string;
  workspaceId?: string;
}

export class ApiClient {
  readonly serverUrl: string;
  private token: string | undefined;
  private workspaceId: string | undefined;

  constructor(opts: ClientOptions = {}) {
    const config = loadConfig();
    const server = getServerUrl(config, opts.server);
    if (!server) {
      throw new Error(
        "No server configured. Run `optio login --server <url>` or set OPTIO_SERVER.",
      );
    }
    this.serverUrl = server;

    // Token priority: flag → env → credentials file
    this.token = opts.apiKey ?? process.env.OPTIO_TOKEN ?? this.tokenFromCredentials(config);

    this.workspaceId = opts.workspaceId ?? this.workspaceFromConfig(config);
  }

  private tokenFromCredentials(config: Config): string | undefined {
    if (!config.currentHost) return undefined;
    const creds = loadCredentials();
    return creds.hosts[config.currentHost]?.token;
  }

  private workspaceFromConfig(config: Config): string | undefined {
    if (!config.currentHost) return undefined;
    return config.hosts[config.currentHost]?.workspaceId;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      h["Authorization"] = `Bearer ${this.token}`;
    }
    if (this.workspaceId) {
      h["x-workspace-id"] = this.workspaceId;
    }
    return h;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new NetworkError(this.serverUrl, err instanceof Error ? err : undefined);
    }

    if (!res.ok) {
      let responseBody: Record<string, unknown>;
      try {
        responseBody = (await res.json()) as Record<string, unknown>;
      } catch {
        responseBody = { error: res.statusText };
      }
      throw new ApiError(res.status, responseBody);
    }

    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  getWsUrl(path: string): string {
    const wsBase = this.serverUrl.replace(/^http/, "ws");
    return `${wsBase}${path}`;
  }

  getToken(): string | undefined {
    return this.token;
  }
}

/** Helper to build a client from commander's global options. */
export function buildClient(opts: {
  server?: string;
  apiKey?: string;
  workspace?: string;
}): ApiClient {
  return new ApiClient({
    server: opts.server ?? process.env.OPTIO_SERVER,
    apiKey: opts.apiKey,
    workspaceId: opts.workspace,
  });
}
