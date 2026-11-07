"use client";

import { useRef, useState } from "react";
import { codexQuestionReplyText, type CodexQuestion } from "@optio/shared";
import { api } from "@/lib/api-client";

export function CodexQuestionCard({
  question,
  terminalId,
}: {
  question: CodexQuestion;
  terminalId: string;
}) {
  const [other, setOther] = useState(false);
  const [value, setValue] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const send = async (answer: string) => {
    if (!answer.trim() || inFlight.current || sent !== null) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      await api.sendLocalTerminalInput(terminalId, codexQuestionReplyText(question, answer) + "\r");
      setSent(answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send your answer. Try again.");
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  return (
    <fieldset
      className="min-w-0 rounded-xl border border-primary/25 bg-primary/5 p-3"
      disabled={sending || sent !== null}
    >
      <legend className="px-1 text-xs font-medium text-primary">Question from Codex</legend>
      <p className="mb-3 whitespace-pre-wrap break-words text-sm text-text-heading">
        {question.title}
      </p>
      {sent !== null ? (
        <p role="status" className="text-sm text-text-muted">
          Answer sent: {sent}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {question.options.map((option, index) => (
              <button
                key={index}
                type="button"
                onClick={() => void send(option)}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-left text-sm text-text hover:border-primary hover:bg-primary/10 disabled:opacity-50"
              >
                {option}
              </button>
            ))}
            {question.options.length > 0 && (
              <button
                type="button"
                aria-expanded={other}
                onClick={() => setOther(!other)}
                className="rounded-lg border border-border px-3 py-2 text-sm text-text-muted hover:text-text"
              >
                Other…
              </button>
            )}
          </div>
          {(other || question.options.length === 0) && (
            <form
              className="mt-2 flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send(value);
              }}
            >
              <textarea
                aria-label={`Answer: ${question.title}`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                rows={2}
                className="min-w-0 flex-1 rounded-lg border border-border bg-bg p-2 text-sm text-text"
              />
              <button
                type="submit"
                disabled={!value.trim() || sending}
                className="rounded-lg bg-primary px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                Send answer
              </button>
            </form>
          )}
          {sending && (
            <p role="status" className="mt-2 text-xs text-text-muted">
              Sending answer…
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-sm text-error">
              {error}
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
