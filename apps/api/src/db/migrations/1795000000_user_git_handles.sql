-- The pull-request panel finds "your" PRs by your handle on each git
-- platform. Sign-in gives one for GitHub / GitLab accounts (users.username);
-- people who sign in another way (Google, OIDC, LDAP) link theirs here.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "git_handles" jsonb;
