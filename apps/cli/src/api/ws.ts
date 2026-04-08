import WebSocket from "ws";

export interface WsOptions {
  url: string;
  token?: string;
  onMessage: (data: string) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (err: Error) => void;
  maxRetries?: number;
}

export function connectWs(opts: WsOptions): WebSocket {
  const protocols: string[] = ["optio-ws-v1"];
  if (opts.token) {
    protocols.push(`optio-auth-${opts.token}`);
  }

  const ws = new WebSocket(opts.url, protocols);

  ws.on("message", (data) => {
    opts.onMessage(data.toString());
  });

  ws.on("close", (code, reason) => {
    opts.onClose?.(code, reason.toString());
  });

  ws.on("error", (err) => {
    opts.onError?.(err);
  });

  return ws;
}
