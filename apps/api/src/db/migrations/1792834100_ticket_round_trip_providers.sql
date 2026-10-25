-- The ticket round trip for every ticket source (docs/ticket-round-trip.md).
-- Additive:
--   - `link_id`: the id of the link a service keeps as a comment or an
--     attachment (GitHub, GitLab, Linear), so the next event of the work
--     updates it instead of adding another; Optio never reads it as an
--     instruction either.
--   - The round trip is off for a provider until it is switched on
--     (`config.roundTrip.enabled`). A provider that already has round-trip
--     settings or writebacks keeps it on, so nothing it did stops.
ALTER TABLE "ticket_writebacks" ADD COLUMN IF NOT EXISTS "link_id" text;

UPDATE "ticket_providers" p
SET "config" = jsonb_set(
  p."config",
  '{roundTrip}',
  (CASE WHEN jsonb_typeof(p."config"->'roundTrip') = 'object' THEN p."config"->'roundTrip' ELSE '{}'::jsonb END)
    || '{"enabled": true}'::jsonb
)
WHERE p."config"->'roundTrip'->'enabled' IS NULL
  AND (
    jsonb_typeof(p."config"->'roundTrip') = 'object'
    OR EXISTS (SELECT 1 FROM "ticket_writebacks" w WHERE w."provider_id" = p."id")
  );
