// Types for fake-tape.mjs (see there). Kept by hand: the module is plain
// JavaScript so fake-agent.mjs can run it with node alone.

export const AGENT_EXEC_MARKER: string;
export const COMMAND_RUN_MARKER: string;
export const UNSUPPORTED_AGENT_MARKERS: string[];
export const CURSOR_EXEC_MARKER: string;

export function extractScriptExport(script: string, name: string): string | null;
export function extractPromptText(line: string): string | null;
export function directiveArg(prompt: string, name: string): string | null;
export function collectDirectiveHaystack(script: string, prompt: string): string;

export type TapeLine = { event: Record<string, unknown> } | { raw: string };

export interface CommandPlan {
  lines: TapeLine[];
  exitCode: number;
  /** Whether the exec script expects `__OPTIO_RUN_EXIT__:<code>` on stdout. */
  exitMarker: boolean;
}
export function planCommandRun(script: string): CommandPlan;

export type AgentPlan =
  | { kind: "silent"; sessionId: string }
  | {
      kind: "play";
      sessionId: string;
      init: Record<string, unknown>;
      hang: boolean;
      sleepMs: number;
      /** `[[mock:ticks:N:MS]]`: N numbered assistant text events, MS apart, after init. */
      ticks: { count: number; everyMs: number };
      /** `[[mock:mark:N:TEXT]]`: an assistant text event TEXT right after tick N. */
      mark: { at: number; text: string } | null;
      lines: TapeLine[];
      exitCode: number;
      echoStdin: boolean;
    };
export function planAgentRun(input: {
  script: string;
  prompt: string;
  specEnv?: Record<string, string>;
  prNumber?: number;
  sessionId?: string;
}): AgentPlan;

export function noPromptResult(sessionId: string, timeoutMs: number): Record<string, unknown>;
