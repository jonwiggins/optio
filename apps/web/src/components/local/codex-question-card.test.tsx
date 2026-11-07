// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexQuestionReplies, type CodexQuestion } from "@optio/shared";
import { CodexQuestionCard } from "./codex-question-card";
const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ api: { sendLocalTerminalInput: send } }));
afterEach(() => {
  cleanup();
  send.mockReset();
});
const question: CodexQuestion = {
  id: '["request_user_input_async","call_q",0]',
  title: "Use this approach?",
  options: ["Yes", "No"],
  answer: null,
};
describe("Codex question card", () => {
  it("waits for an explicit choice and prevents double submission", async () => {
    let finish!: () => void;
    send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<CodexQuestionCard question={question} terminalId="terminal" />);
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Yes", exact: true }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(codexQuestionReplies(send.mock.calls[0]![1])?.[0]?.answer).toBe("Yes");
    finish();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Answer sent: Yes"),
    );
  });
  it("preserves an Other draft on failure and retries the exact structured answer", async () => {
    send.mockRejectedValueOnce(new Error("Machine offline")).mockResolvedValueOnce(undefined);
    render(<CodexQuestionCard question={question} terminalId="terminal" />);
    fireEvent.click(screen.getByRole("button", { name: "Other…" }));
    const answer = 'Different "choice"\nwith context';
    fireEvent.change(screen.getByRole("textbox"), { target: { value: answer } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Machine offline"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(answer);
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Answer sent:"));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(codexQuestionReplies(send.mock.calls[1]![1])?.[0]).toEqual({
      answer,
      question: question.title,
      questionItemId: question.id,
    });
  });
});
