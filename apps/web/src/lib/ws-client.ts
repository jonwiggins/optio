type EventHandler = (event: any) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);

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

    this.ws.onclose = () => {
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

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000";

export function createEventsClient(): WsClient {
  return new WsClient(`${WS_URL}/ws/events`);
}

export function createLogClient(taskId: string): WsClient {
  return new WsClient(`${WS_URL}/ws/logs/${taskId}`);
}

export function createTerminalClient(taskId: string): WsClient {
  return new WsClient(`${WS_URL}/ws/terminal/${taskId}`);
}

export function createSessionTerminalClient(sessionId: string): WsClient {
  return new WsClient(`${WS_URL}/ws/sessions/${sessionId}/terminal`);
}
