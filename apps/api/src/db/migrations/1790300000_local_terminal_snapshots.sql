-- The final screen of an exited Optio Local terminal: the tail of the
-- daemon's output ring plus the PTY grid it was drawn for, so a finished
-- session replays at the size it ran at instead of a 12-line text preview.

CREATE TABLE "local_terminal_snapshots" (
  "terminal_id" uuid PRIMARY KEY NOT NULL,
  "data" bytea NOT NULL,
  "cols" integer NOT NULL,
  "rows" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "local_terminal_snapshots" ADD CONSTRAINT "local_terminal_snapshots_terminal_id_local_terminals_id_fk"
  FOREIGN KEY ("terminal_id") REFERENCES "public"."local_terminals"("id") ON DELETE cascade ON UPDATE no action;
