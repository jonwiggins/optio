-- The daily digest (docs/notifications.md "The daily digest"). Its choice
-- (on, hour, time zone, email/chat/both) lives in
-- notification_preferences.channels -> 'digest'. Additive: two nullable
-- columns. `digest_sent_on` is the local day the person's last digest was
-- for, claimed atomically so several API instances never send it twice;
-- `digest_sent_at` is when it went, so the next one covers what happened
-- since.
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "digest_sent_on" text;
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "digest_sent_at" timestamptz;
