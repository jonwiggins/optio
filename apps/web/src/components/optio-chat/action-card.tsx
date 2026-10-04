"use client";

import { useState } from "react";
import { Check, X, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OptioPendingAction } from "@/hooks/use-optio-chat";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

interface ActionCardProps {
  action: OptioPendingAction;
  onApprove: (actionId: string) => void;
  onDeny: (actionId: string, feedback: string) => void;
}

export function ActionCard({ action, onApprove, onDeny }: ActionCardProps) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  const decided = action.decision !== null;
  const approved = action.decision === true;
  const denied = action.decision === false;

  const handleDeny = () => {
    setShowFeedback(true);
  };

  const handleSubmitFeedback = () => {
    onDeny(action.id, feedback.trim() || "No changes specified");
    setShowFeedback(false);
  };

  return (
    <div
      className={cn(
        "rounded-lg border overflow-hidden transition-colors",
        decided
          ? approved
            ? "border-success/30 bg-success/5"
            : "border-error/30 bg-error/5"
          : "border-primary/30 bg-primary/5",
      )}
    >
      <div className="px-3.5 py-3">
        {action.description && <p className="text-sm text-text mb-2">{action.description}</p>}

        <ul className="space-y-1.5">
          {action.items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-text-muted">
              <span className="text-primary mt-0.5 shrink-0">&bull;</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-inherit px-3.5 py-2.5">
        {decided ? (
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs font-medium",
              approved ? "text-success" : "text-error",
            )}
          >
            {approved ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
            {approved ? "Approved" : "Denied"}
          </div>
        ) : showFeedback ? (
          <div className="space-y-2">
            <p className="text-xs text-text-muted">What should I change?</p>
            <div className="flex items-end gap-2">
              <input
                type="text"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmitFeedback();
                }}
                placeholder="Your feedback..."
                autoFocus
                className={inputClass({ size: "sm", className: "flex-1" })}
              />
              <button
                onClick={handleSubmitFeedback}
                className="shrink-0 px-3 py-1.5 rounded-md bg-error/10 text-error text-xs font-medium hover:bg-error/20 transition-colors btn-press"
              >
                Send
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={handleDeny} className="btn-press">
              <MessageSquare />
              Deny
            </Button>
            <Button size="sm" onClick={() => onApprove(action.id)} className="btn-press">
              <Check />
              Approve
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
