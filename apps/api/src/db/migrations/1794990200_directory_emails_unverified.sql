-- LDAP and SAML addresses no longer count as verified unless the provider's
-- `trustEmail` setting (new, default off) says the directory's addresses are
-- authoritative: until then they grant nothing by email (OPTIO_DEPLOYMENT_ADMINS,
-- joining workspaces by domain, account linking). Accounts made by those
-- providers were stored as verified; clear it, and the next sign-in sets it
-- again where the deployment trusts the directory (docs/sign-in.md).
UPDATE "users" SET "email_verified" = false WHERE "provider" IN ('ldap', 'saml') AND "email_verified";
