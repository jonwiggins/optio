-- The conversation behind an Optio Local agent session, distilled by the
-- daemon from the agent CLI's own transcript: every prompt, reply, tool
-- call and result as plain text. The recorded screen only holds a TUI's
-- last redraw; this is the whole exchange, and it reflows to any device.

CREATE TABLE "local_terminal_transcripts" (
  "terminal_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "role" text NOT NULL,
  "kind" text NOT NULL,
  "text" text NOT NULL,
  "detail" text,
  "tool_name" text,
  "tool_use_id" text,
  "is_error" boolean DEFAULT false NOT NULL,
  "at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "local_terminal_transcripts_pk" PRIMARY KEY ("terminal_id", "seq")
);
ALTER TABLE "local_terminal_transcripts" ADD CONSTRAINT "local_terminal_transcripts_terminal_id_local_terminals_id_fk"
  FOREIGN KEY ("terminal_id") REFERENCES "public"."local_terminals"("id") ON DELETE cascade ON UPDATE no action;
