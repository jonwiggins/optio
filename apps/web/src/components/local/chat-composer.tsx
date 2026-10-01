"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { ChatComposer } from "@/components/chat-box";
import { cn } from "@/lib/utils";

/**
 * The reply box under a Local session's Chat face: what you type goes to the
 * agent's terminal as if typed there, then Enter (`\r`) submits it. Sent over
 * the REST input endpoint — the Chat face has no terminal stream open.
 * Multi-line text goes as typed. Only for a running session (the endpoint
 * 409s otherwise).
 */
export function LocalChatComposer({
  terminalId,
  working,
  className,
}: {
  terminalId: string;
  /** The agent is mid-turn: say the message will wait for it. */
  working: boolean;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = value;
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await api.sendLocalTerminalInput(terminalId, `${text}\r`);
      setValue("");
    } catch (err) {
      toast.error("Couldn't send your message", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={cn("shrink-0 border-t border-border bg-bg-card/60 px-3 sm:px-4 py-2", className)}
      data-testid="local-chat-composer"
    >
      <div className="max-w-3xl mx-auto flex flex-col gap-1.5">
        {working && (
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
            <Loader2 className="w-3 h-3 animate-spin" />
            The agent is working — your message will queue
          </div>
        )}
        <ChatComposer
          value={value}
          onChange={setValue}
          onSend={send}
          sending={sending}
          placeholder="Reply to the agent…"
        />
      </div>
    </div>
  );
}
