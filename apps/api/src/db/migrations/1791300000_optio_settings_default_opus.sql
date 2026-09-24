-- The Optio assistant defaults to "opus" — an alias, so it is always the
-- newest Opus the live model list offers — instead of Sonnet. Rows already
-- saved keep the model someone picked.
ALTER TABLE "optio_settings" ALTER COLUMN "model" SET DEFAULT 'opus';
