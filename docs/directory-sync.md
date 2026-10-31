# Directory sync

Optio applies a person's directory groups when they sign in, and a session
lives up to 30 days (sliding by 7). Without more, someone removed from
Active Directory, or taken out of the admin group, would keep their rights,
their API keys for weeks, and their schedules would
keep running because they never sign in again.

The **directory sync** closes that gap for people who sign in with **LDAP /
Active Directory**: on a schedule, Optio reads each of them in the directory
again, applies their groups, and **disables** the ones who left. A
deployment admin can also disable someone by hand ("Disable and sign out
everywhere").

## LDAP / Active Directory

### What a run does

Every interval (15 minutes to a day; 30 by default), one run at a time (the
`directory-sync` lease, held by the run itself, so a scheduled run and a
**Run now** never overlap, on one API instance or several) reads every
person whose account came from the LDAP sign-in, through the LDAP sign-in's
own service account and settings (the same attributes and group reading as
a sign-in; nobody's password). Each run reads everyone first and only then
changes anything.

**Finding each person.** A run looks a person up by the identity Optio
stored at their sign-in, not by name: the entry's `objectGUID` (Active
Directory) or `entryUUID` (OpenLDAP and most others), else its DN, under the
user base DN. A renamed account is still theirs; a deleted one re-created
with the same name or email is not. Then it checks that the sign-in's
**user filter** still finds that entry, because a sign-in finds people only
through it. The name it tries is their username, then the values on their
entry of the attributes the filter matches the sign-in name against (for
`(userPrincipalName={{username}})`, their `userPrincipalName`; for the
default filter, `sAMAccountName`, `uid` and `mail`). If the filter finds the
entry with neither, its other conditions leave them out (an `employeeType`
or `memberOf` test, say): they can't sign in, and count as gone. If their
entry has no value of those attributes at all, the run can't tell, and
lists them as "couldn't be checked" (it changes nothing for them). A
directory that can't be searched by GUID (one that keeps it as text) is
read by username, as before, and the entry found counts only if it has the
stored identity. An entry found by username that shows no `objectGUID` or
`entryUUID` at all while the stored identity is one (a service account
without read access to it: Active Directory then answers the GUID search with
no entry rather than an error) is "couldn't be checked", never gone.

**Still allowed** — the entry is there, Active Directory doesn't mark it
disabled, and the sign-in's own rule (required groups, allowed domains) lets
them in: their groups are applied the way a sign-in applies them.

- **Admin groups**: a member becomes a deployment admin and an admin of the
  organization workspace; someone the groups made one and no longer do
  loses the role (never the last enabled deployment admin: a disabled one
  doesn't count; never one granted by `OPTIO_DEPLOYMENT_ADMINS`).
- **Workspaces their groups open** (`workspaces.access_groups`): they join
  them, as at sign-in. A workspace a group put them in, and which none of
  their groups opens any more, they **leave**.
  Never a membership an admin added by hand, nor one an admin made the
  workspace's admin, nor one made before this version, nor in a workspace
  whose groups were all removed (an admin who stops using groups there
  keeps its people). A new sign-in also re-evaluates these memberships.
  People who sign in with OpenID Connect aren't read by this LDAP sync;
  their provider's next sign-in refreshes their group-made memberships.
- Their **name and email** follow the directory.

**Left** — any of:

| Reason in Optio                           | What the directory says                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| no longer in the directory                | no entry has their objectGUID / entryUUID (or DN) under the user base DN, or the user filter no longer finds it |
| disabled in Active Directory              | `userAccountControl` has ACCOUNTDISABLE (0x2)                                                                   |
| no longer in a group allowed to use Optio | they are in none of the sign-in's **required groups**                                                           |
| their email domain is no longer allowed   | the sign-in's **allowed domains** don't include their email's                                                   |

Such a person is **disabled**:

- Their **sessions**, **API keys** (the CLI's and MCP clients' too) and
  WebSocket tokens are revoked, and Optio refuses the account everywhere
  from then on, should a token have been missed.
- **Their own automations are paused**: work definitions they own
  personally (not a team's) that a schedule or another non-manual trigger
  starts — scheduled Tasks, Jobs, Local automations — and their persistent
  agents. Optio lists each one with the reason, so an admin can see what to
  hand over.
- Work of theirs that is **already running or queued finishes**.
- Admin roles and workspace memberships granted by groups are taken back.

**Coming back.** When the directory lets them in again (back in a required
group, enabled in Active Directory), the next run **enables** the account,
and the automations Optio paused come back on, except ones someone switched
on, edited or deleted meanwhile. Their old sessions and keys stay revoked: they sign in
again. Their own LDAP sign-in does the same at once, without waiting for
the next run. An account a deployment admin disabled by hand is never
enabled by the sync, nor by signing in.

### Safety

- Disabling an account does not terminate already-open WebSockets, running or
  queued work, existing pods, or revoke stored GitHub user tokens. Future
  sessions, token validation and WebSocket upgrades are refused. Deployment
  admins are subject to offboarding too; only the last enabled admin is kept.
- Linking an LDAP identity to a Google or OIDC account makes the entire account
  subject to LDAP sync, including its non-LDAP sign-ins.
- Forced runs persist `forced: true`, the initiating operator and a
  `directory.sync` audit action; they do not bypass lookup errors.
- A directory that can't be reached, or a service account that can't bind,
  **changes nobody**: the run is recorded as failed with the reason.
- A person whose lookup fails (two entries with one identity, say) is
  counted as "couldn't be checked" and left alone. So is someone the user
  filter can't be judged for (above), and someone with neither a stored
  identity Optio can search by nor a username: they are checked after
  their next sign-in.
- A run that would disable **more than 25 %** of the people it checked, and
  more than three, is **held**: it changes nobody, lists who it would
  disable, and waits for a deployment admin to look and run it again with
  **Disable them anyway**. That catches a broken user filter or a wrong base
  DN before it locks everyone out. `OPTIO_DIRECTORY_SYNC_MAX_DISABLE_PERCENT`
  (chart `auth.directorySync.maxDisablePercent`) sets the percentage; 100
  turns the check off.
- The **last enabled deployment admin** is never disabled; the run reports
  it instead ("make someone else one first"). Removing the role by hand
  (Settings → Access → Sign-in) follows the same rule: a disabled admin
  isn't one left.

## Settings → Access → Directory sync

Deployment admins only (an account spans every workspace, and the directory
is the deployment's). The card sits under the Sign-in card:

- **Sync on a schedule** and **Every** (15 minutes to a day). Saved here,
  they win over the deployment's values; **Use the deployment's** puts both
  back.
- **Run now**, and the **last run**: when, scheduled or by hand, and how
  many people were checked, changed, disabled, enabled again and couldn't be
  checked; **Who** lists each person the run did something to. A held run
  shows **Disable them anyway**.
- **Disabled accounts**: who, why, since when and by whom, the automations
  Optio paused for them (named and linked in workspaces you administer;
  counted elsewhere), and **Enable**.
- **Disable and sign out everywhere**: by email, for anyone who signed in
  once, whatever their sign-in. The same as a leaver, with the reason
  "disabled by an administrator"; the directory sync never enables such an
  account. You can't disable yourself, or the last deployment admin.

Without LDAP sign-in the card says so, and Run now is off; disabling by hand
still works.

## Signing in while disabled

A disabled account can't sign in: the LDAP form answers "Your Optio account
is disabled. Ask an Optio administrator if you should still have access.",
and the OpenID Connect callback lands on `/login?error=account_disabled`
with the same words. The one exception is the LDAP sign-in of someone the
**sync** disabled, as the **same directory entry** (the objectGUID /
entryUUID stored at their last sign-in): the directory has just accepted
their password and groups, so the account is enabled on the spot. Another
entry with the same email (the account deleted and re-created, or the
address given to someone new) is refused: whether it takes over the
leaver's account, automations and private work is a deployment admin's
call (**Enable** on the card; the next sign-in then moves the account to
the new entry).

## OpenID Connect only

The sync reads LDAP / Active Directory; a deployment that signs in with
OpenID Connect alone has nothing for it to read (OpenID Connect has no way
to ask about a person who isn't signing in). There:

- The identity provider checks people **at every sign-in**: someone
  disabled there, or out of the required groups (`requiredGroups`), is
  refused at their next sign-in, and their groups are applied again each
  time.
- Between sign-ins, a session lasts up to 30 days. Disable a leaver by hand
  (**Disable and sign out everywhere**) to end it at once, with the same
  revocations and paused automations.
- A site that also has the directory over LDAP can turn LDAP sign-in on
  next to OpenID Connect: the sync reads the people who signed in with LDAP.

## Configuration

| Setting             | In the app         | Environment (chart value)                                                               | Default |
| ------------------- | ------------------ | --------------------------------------------------------------------------------------- | ------- |
| On / off            | Sync on a schedule | `OPTIO_DIRECTORY_SYNC` (`auth.directorySync.enabled`)                                   | off     |
| Interval            | Every              | `OPTIO_DIRECTORY_SYNC_INTERVAL_MINUTES` (`auth.directorySync.intervalMinutes`), 15–1440 | 30      |
| Hold above          | —                  | `OPTIO_DIRECTORY_SYNC_MAX_DISABLE_PERCENT` (`auth.directorySync.maxDisablePercent`)     | 25      |
| How often it checks | —                  | `OPTIO_DIRECTORY_SYNC_TICK_MS`                                                          | 300000  |

The worker wakes every five minutes and runs when the sync is on, LDAP
sign-in is set up and the interval has passed since the last run started (a
Run now counts), so a changed interval holds at once. The directory itself
is the LDAP sign-in's: Settings → Access → Sign-in, or `LDAP_*` /
`auth.ldap.*` ([sign-in.md](sign-in.md)). Its service account needs to read
users and their groups (and `userAccountControl` on Active Directory, which
any account may read by default). TLS to the directory is the LDAP
sign-in's: the CA given in its settings when there is one, else the
deployment's CA bundle (`caBundle`).

## API

| Method | Path                            | What                                                                                      |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/api/admin/directory-sync`     | Settings, whether LDAP is set up, the last run, the disabled accounts and what was paused |
| PUT    | `/api/admin/directory-sync`     | `{ enabled?, intervalMinutes? }` (null = the deployment's value)                          |
| POST   | `/api/admin/directory-sync/run` | Run now (`{ force: true }`: Disable them anyway); answers the run; 409 while one runs     |
| POST   | `/api/admin/users/disable`      | `{ email }` or `{ userId }`: disable and sign out everywhere                              |
| POST   | `/api/admin/users/:id/enable`   | Enable again; the paused automations come back on                                         |

All deployment admins only (403 otherwise).

## Where it lives

| Part                                   | Code                                                                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A run, the settings, the verdicts      | `apps/api/src/services/directory-sync.ts`                                                                                                                                                                                     |
| Disabling, enabling, the sign-in check | `apps/api/src/services/offboarding.ts`                                                                                                                                                                                        |
| Reading the directory                  | `openLdapDirectory`, `usernameKeys`, `objectGuidBytes`, `isAccountDisabled` in `apps/api/src/services/auth/ldap.ts`                                                                                                           |
| Leaving workspaces by group            | `leaveWorkspacesByGroups` in `apps/api/src/services/workspace-groups.ts`                                                                                                                                                      |
| The clock                              | `apps/api/src/workers/directory-sync-worker.ts`                                                                                                                                                                               |
| Routes                                 | `apps/api/src/routes/directory-sync.ts`                                                                                                                                                                                       |
| Hooks in upstream files                | `session-service.ts`, `api-key-service.ts` (refuse a disabled account), `routes/auth.ts` (sign-in), `sign-in-config-service.ts` (`completeSignIn` options; `listDeploymentAdmins({ enabledOnly })` for the last-admin checks) |
| Web                                    | `apps/web/src/components/settings/directory-sync-settings.tsx`, `lib/directory-sync-api.ts`; the login message in `app/login/page.tsx`                                                                                        |
| Tables                                 | `users.disabled_at` / `disabled_reason` / `disabled_by`, `workspace_members.joined_via_groups`, `paused_automations`, `directory_sync_runs` (`1793059204_directory_sync.sql`)                                                 |
| Tests                                  | `services/directory-sync.test.ts`, `services/directory-sync.int.test.ts`, `routes/directory-sync.int.test.ts` (an in-memory directory behind the real LDAP code: `test-utils/fake-ldap.ts`)                                   |

Team mappings, notification emails, gateway-issued keys, and audit events are carried by their separate splits. This split reserves the personal-ownership team columns as null.

## SCIM 2.0 provisioning

An identity provider can push users and groups instead of Optio polling LDAP.
SCIM is off until a deployment admin generates a token in **Settings → Access →
Directory sync → SCIM 2.0 provisioning**. Configure the IdP's SCIM client
(for example Authentik, Microsoft Entra ID or Okta) with the displayed base URL
`https://optio.example.com/api/scim/v2` and bearer token. Use HTTPS.

1. Choose the sign-in provider backed by the same identity provider (OIDC,
   SAML or LDAP, for example) and save it. Its group rules apply to provisioning.
2. Generate a named token and copy it into the IdP. The token is shown once;
   only its SHA-256 hash is stored. Tokens are separate from sessions and PATs.
3. Provision Users and Groups. Map `userName`, a stable `externalId`, `emails`,
   `displayName` (or `name`) and `active`. Map group names to `displayName` and
   group members to SCIM User IDs. Provision a user's required groups before
   expecting them to sign in.
4. Rotate by generating another token, switching the IdP and revoking the old
   token. Revoke all tokens to turn SCIM off. Tokens grant provisioning access
   across the deployment and only deployment admins manage them.

The API supports `ServiceProviderConfig`, `ResourceTypes`, `Schemas`, and
`Users` / `Groups` list, get, POST, PUT, PATCH and DELETE. Requests may use
`application/scim+json` or `application/json`; protocol responses and errors
use `application/scim+json`. Lists support `startIndex` (one-based), `count`
(up to 200) and equality filters such as `userName eq "alice@example.com"`,
`externalId eq "directory-id"` and `displayName eq "Developers"` for groups.
Group membership PATCH supports add/replace/remove and
`members[value eq "<SCIM user ID>"]`. Bulk, password changes, sorting and ETags
are not supported. Resource IDs are stable Optio user/group UUIDs.

A provisioned user is an Optio account. Only the selected sign-in provider can
claim it, matching the email that provider verifies. Matching by username is
limited to OIDC and LDAP, which assert it; a GitHub or GitLab login is a public
handle anyone can register, so those providers must match by verified email.
If a unique account already signed in through that provider (by an email the
account has verified, or by username for OIDC and LDAP), provisioning adopts it;
an unverified address never matches. Other providers cannot
claim it. Claiming adds an identity link and preserves the original identity.
With no provider selected, SCIM only provisions accounts. The provider choice
is stored in deployment settings; an environment default is available as
`OPTIO_SCIM_SIGN_IN_PROVIDER`. Choosing **None** in Settings is stored too and
wins over that default.

SCIM never adopts a deployment admin's account, and never changes, deletes or
deactivates an account whose deployment admin role came from somewhere other
than SCIM: granted by hand, named in `OPTIO_DEPLOYMENT_ADMINS`, or given by
another provider's admin group. Such a request is refused (409 for adoption,
403 otherwise), and a group change leaves those accounts as they are.
Re-provisioning someone after a DELETE reuses the account SCIM made for that
`userName` instead of creating a second one, unless a sign-in claimed that
account: then only the same verified email (or the provider's identity) brings
it back, never the `userName` alone.

SCIM group display names feed the same **admin groups**, **required groups**
and workspace access groups as LDAP and OIDC. Membership changes are applied
immediately and merged into the account's next sign-in. A lost required group
or disallowed email domain disables the account until provisioning satisfies
the provider's access rules again.

**Admin groups and the SCIM token.** A SCIM group named like a configured admin
group would make its members deployment admins. That is off by default: SCIM
groups grant deployment admin only when the operator sets
`OPTIO_SCIM_ALLOW_ADMIN_GROUPS=true` in the deployment's environment (nothing
in a SCIM request or in Settings turns it on). With it on, whoever holds a SCIM
token can make any provisioned or adopted account a deployment admin by adding
it to such a group, so treat the token like an identity-provider admin
credential. SCIM's grants are recorded under their own `scim:` source and
never replace a manual, environment or other provider's grant.

Provisioned email domains are checked as the directory's word, and this check
can only disable an account. A pushed email doesn't count as verified: a new or
changed address stays unverified until a sign-in provider verifies it, and every
sign-in still passes that provider's own domain check.

A change to a required group (PATCH or PUT of its members, a rename, a DELETE)
that would deactivate more than `OPTIO_DIRECTORY_SYNC_MAX_DISABLE_PERCENT`
(25% by default) of the enabled provisioned accounts, and more than three, is
refused with 409 before any membership or account changes, the same hold the
LDAP sync uses. A SCIM token can't force it through; a deployment admin checks
the identity provider's configuration first.

Identity providers deactivate people one request at a time, so unassigning the
app from many people never looks like one big change. SCIM disables people
three ways: `active: false` or DELETE, a group change that takes them out of
every required group, and an email moved outside the allowed domains. All of
them are counted together: a request that, with SCIM's deactivations of the
last 15 minutes, would cross the same hold is refused with 409 and nothing
changes, so removing one member per request from a required group is held like
removing them together. Requests that arrive at once are counted one after
another, under the lock that also protects the last deployment admin, so they
can't all pass together. An account SCIM creates already disabled (inactive, or
outside the required groups or allowed domains from the start) doesn't count.
The identity provider retries; the Settings page shows the hold, and a
deployment admin who has checked the identity provider releases it (**Release
the hold**, or `POST /api/admin/scim/hold/release`), which lets deactivations
and required-group changes through for the next 15 minutes.
`OPTIO_DIRECTORY_SYNC_MAX_DISABLE_PERCENT=100` turns both holds off.

`active: false` and User DELETE use the **same leaver path as LDAP**: disable
the account, revoke sessions, API keys, and pause its own
automations. DELETE removes the SCIM resource
but keeps the disabled Optio account and its work. `active: true` re-enables
only accounts SCIM disabled, including paused automations; it never reverses
an administrator's manual disable or one made by LDAP sync. The last enabled
deployment admin is never disabled, also when several requests arrive at once.
Make someone else a deployment admin first if needed. An IdP must retry failed provisioning requests; errors are returned
with SCIM status and detail fields.

Admin API: `GET/PUT /api/admin/scim`, `POST /api/admin/scim/tokens`,
`DELETE /api/admin/scim/tokens/:id` and `POST /api/admin/scim/hold/release`. Protocol requests require a SCIM bearer
token on every endpoint; an Optio session or PAT does not grant SCIM access.
