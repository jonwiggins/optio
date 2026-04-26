type EventHandler = (event: any) => void;

export type TokenProvider = () => Promise<string | null>;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  private tokenProvider: TokenProvider | null;

  constructor(url: string, tokenProvider?: TokenProvider) {
    this.url = url;
    this.tokenProvider = tokenProvider ?? null;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    // If a token provider is set, fetch a token before connecting.
    // Tokens are sent via the Sec-WebSocket-Protocol header (not URL query params)
    // to prevent leaking into server logs, browser history, and Referer headers.
    if (this.tokenProvider) {
      this.tokenProvider()
        .then((token) => {
          const protocols = token ? ["optio-ws-v1", `optio-auth-${token}`] : undefined;
          this.openSocket(this.url, protocols);
        })
        .catch(() => {
          // Token fetch failed — retry after delay
          this.reconnectTimer = setTimeout(() => this.connect(), 3000);
        });
    } else {
      this.openSocket(this.url);
    }
  }

  private openSocket(url: string, protocols?: string[]): void {
    this.ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);

    this.ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data);
        const type = event.type as string;
        this.handlers.get(type)?.forEach((handler) => handler(event));
        this.handlers.get("*")?.forEach((handler) => handler(event));
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = (ev) => {
      if (ev.code === 4429) return; // connection limit exceeded — retry can't help
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  on(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}

/**
 * Derive the WebSocket base URL at runtime.
 *
 * Priority:
 * 1. NEXT_PUBLIC_WS_URL env var (local dev override via .env.local)
 * 2. PUBLIC_API_URL injected at runtime via window.__OPTIO_CONFIG
 *    (set by the server component in layout.tsx for NodePort / split-origin setups)
 * 3. Derived from the current page URL (production ingress — zero config)
 * 4. SSR fallback
 */
export function getWsBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL;
  }
  if (typeof window === "undefined") {
    return "ws://localhost:4000";
  }
  // Use the runtime-injected PUBLIC_API_URL when web and API are on different origins
  const config = (window as any).__OPTIO_CONFIG as { publicApiUrl?: string } | undefined;
  if (config?.publicApiUrl) {
    const url = new URL(config.publicApiUrl);
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

export function createEventsClient(tokenProvider?: TokenProvider): WsClient {
  return new WsClient(`${getWsBaseUrl()}/ws/events`, tokenProvider);
}

export function createLogClient(taskId: string, tokenProvider?: TokenProvider): WsClient {
  return new WsClient(`${getWsBaseUrl()}/ws/logs/${taskId}`, tokenProvider);
}

export function createTerminalClient(taskId: string, tokenProvider?: TokenProvider): WsClient {
  return new WsClient(`${getWsBaseUrl()}/ws/terminal/${taskId}`, tokenProvider);
}

export function createSessionTerminalClient(sessionId: string): WsClient {
  return new WsClient(`${getWsBaseUrl()}/ws/sessions/${sessionId}/terminal`);
}

export function createWorkflowRunLogClient(
  workflowRunId: string,
  tokenProvider?: TokenProvider,
): WsClient {
  return new WsClient(`${getWsBaseUrl()}/ws/workflow-runs/${workflowRunId}/logs`, tokenProvider);
}

export function createPrReviewLogClient(
  prReviewId: string,
  tokenProvider?: TokenProvider,
): WsClient {
  return new WsClient(`${getWsBaseUrl()}/ws/pr-reviews/${prReviewId}/logs`, tokenProvider);
}

export function createPersistentAgentEventsClient(
  agentId: string,
  tokenProvider?: TokenProvider,
): WsClient {
  return new WsClient(`${getWsBaseUrl()}/ws/persistent-agents/${agentId}/events`, tokenProvider);
}
