-- Add per-repo secret proxy (Envoy sidecar) for credential isolation in agent pods
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "secret_proxy" boolean DEFAULT false NOT NULL;
