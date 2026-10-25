# Directory sync

Optio applies a person's directory groups when they sign in, and a session
lives up to 30 days (sliding by 7). Without more, someone removed from
Active Directory, or taken out of the admin group, would keep their rights,
their team's secrets and their API keys for weeks, and their schedules would
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
stored identity.

**Still allowed** — the entry is there, Active Directory doesn't mark it
disabled, and the sign-in's own rule (required groups, allowed domains) lets
them in: their groups are applied the way a sign-in applies them.

- **Admin groups**: a member becomes a deployment admin and an admin of the
  organization workspace; someone the groups made one and no longer do
  loses the role (never the last enabled deployment admin: a disabled one
  doesn't count; never one granted by `OPTIO_DEPLOYMENT_ADMINS`).
- **Workspaces their groups open** (`workspaces.access_groups`): they join
  them, as at sign-in. A workspace a group put them in, and which none of
  their groups opens any more, they **leave** (with its group-mapped teams).
  Never a membership an admin added by hand, nor one an admin made the
  workspace's admin, nor one made before this version, nor in a workspace
  whose groups were all removed (an admin who stops using groups there
  keeps its people). A sign-in only ever adds; leaving happens at the next
  run. People who sign in with OpenID Connect aren't read by the sync, so
  they keep group-made memberships.
- **Teams mapped to their groups**, in every workspace they are in: they
  join the mapped teams, and leave the mapped ones whose group they lost
  (a membership someone added by hand stays).
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
  from then on, should a token have been missed. The **keys Optio made
  them on the model gateway** are blocked (`docs/model-gateway.md`, "Keys
  that should stop working"); one the gateway can't be reached for is
  blocked by the next key check.
- **Their own automations are paused**: work definitions they own
  personally (not a team's) that a schedule or another non-manual trigger
  starts — scheduled Tasks, Jobs, Local automations — and their persistent
  agents. Optio lists each one with the reason, so an admin can see what to
  hand over.
- Work of theirs that is **already running or queued finishes**. Nothing new
  starts for them: the paused automations don't fire, and they can't sign in
  to start anything. Their **waiting work isn't resumed** either: a comment
  on its Jira ticket isn't taken, and a run that something else asks for (a
  review asking for changes, an @-mention on its merge request) fails at once,
  naming whose work it was and saying to start it again as oneself or as a
  team's work (`services/owner-standing.ts`). A team's work isn't theirs and
  goes on.
- What the directory gave them is taken back: admin roles from the admin
  groups and the group-mapped teams. A **team's work stays the team's**.
- The **admins of every workspace they were in** get an email ("Someone
  left") naming the automations Optio paused there, with links; the email
  opens this Settings card for a deployment admin, and the workspace's
  members (`/workspace-settings`) for the others. The **admins of their
  teams** are told they left, without the names of their private
  automations (only workspace admins may see private work).
- The audit trail records `user.disabled` in each of their workspaces.

**Coming back.** When the directory lets them in again (back in a required
group, enabled in Active Directory), the next run **enables** the account,
and the automations Optio paused come back on, except ones someone switched
on or deleted meanwhile. Their old sessions and keys stay revoked: they sign in
again. Their own LDAP sign-in does the same at once, without waiting for
the next run. An account a deployment admin disabled by hand is never
enabled by the sync, nor by signing in.

### Safety

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
- A run that is **held**, or **fails**, changes nobody, and every run after
  it will too until someone looks. So the deployment admins get an email
  ("Directory sync stopped") when the sync becomes held or failed: once per
  change, not at every run, and not to whoever pressed Run now.

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
  An identity provider that speaks SCIM 2.0 can instead push its users and
  groups to Optio ([SCIM 2.0 provisioning](#scim-20-provisioning)).

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

## Audit and notifications

| Action               | When                                                                                  | Where                                    |
| -------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------- |
| `user.disabled`      | An account is disabled (`reason`, `via`: `directory` / `admin`, `count` paused there) | each of the person's workspaces          |
| `user.enabled`       | Enabled again (`via`: `directory` / `admin` / `sign_in`)                              | each of the person's workspaces          |
| `directory.sync`     | A run (`trigger`, `status`, and the counts)                                           | deployment-wide (deployment admins read) |
| `directory.settings` | The settings changed (`fields`)                                                       | deployment-wide                          |

`user.*` entries are admins' only on the Activity feed. The email kinds are
`user.offboarded` ("Someone left"), to workspace and team admins, and
`directory.sync_stopped` ("Directory sync stopped"), to deployment admins;
each can be turned off under Settings → Notifications → What reaches you
([notifications.md](notifications.md)).

## Where it lives

| Part                                   | Code                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A run, the settings, the verdicts      | `apps/api/src/services/directory-sync.ts`                                                                                                                                                                                                                                              |
| Disabling, enabling, the sign-in check | `apps/api/src/services/offboarding.ts`                                                                                                                                                                                                                                                 |
| Reading the directory                  | `openLdapDirectory`, `usernameKeys`, `objectGuidBytes`, `isAccountDisabled` in `apps/api/src/services/auth/ldap.ts`                                                                                                                                                                    |
| Leaving workspaces by group            | `leaveWorkspacesByGroups` in `apps/api/src/services/workspace-groups.ts`                                                                                                                                                                                                               |
| The clock                              | `apps/api/src/workers/directory-sync-worker.ts`                                                                                                                                                                                                                                        |
| Routes                                 | `apps/api/src/routes/directory-sync.ts`                                                                                                                                                                                                                                                |
| Hooks in upstream files                | `session-service.ts`, `api-key-service.ts` (refuse a disabled account), `routes/auth.ts` (sign-in), `sign-in-config-service.ts` (`completeSignIn` options; `listDeploymentAdmins({ enabledOnly })` for the last-admin checks), `notify/recipients.ts` (no email to a disabled account) |
| Web                                    | `apps/web/src/components/settings/directory-sync-settings.tsx`, `lib/directory-sync-api.ts`; the login message in `app/login/page.tsx`                                                                                                                                                 |
| Tables                                 | `users.disabled_at` / `disabled_reason` / `disabled_by`, `workspace_members.joined_via_groups`, `paused_automations`, `directory_sync_runs` (`1792740000_directory_sync.sql`)                                                                                                          |
| Tests                                  | `services/directory-sync.test.ts`, `services/directory-sync.int.test.ts`, `routes/directory-sync.int.test.ts` (an in-memory directory behind the real LDAP code: `test-utils/fake-ldap.ts`)                                                                                            |

## SCIM 2.0 provisioning

An identity provider can push users and groups instead of Optio polling LDAP.
SCIM is off until a deployment admin generates a token in **Settings → Access →
Directory sync → SCIM 2.0 provisioning**. Configure the IdP's SCIM client
(for example Authentik, Microsoft Entra ID or Okta) with the displayed base URL
`https://optio.example.com/api/scim/v2` and bearer token. Use HTTPS.

1. Choose the sign-in provider backed by the same identity provider (LDAP,
   OIDC or SAML, for example) and save it. Its group rules apply to provisioning.
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
claim it, matching the provider's verified email or username. If a unique
account already signed in through that provider, provisioning adopts it.
Other providers cannot claim it. Claiming adds an identity link and preserves
the original identity. With no provider selected, SCIM only provisions accounts.
The provider choice is stored in deployment settings; an environment default
is available as `OPTIO_SCIM_SIGN_IN_PROVIDER`.

SCIM group display names feed the same **admin groups**, **required groups**,
workspace access groups and team mappings as LDAP, OIDC and SAML. Membership
changes are applied immediately and merged into the account's next sign-in.
A lost required group or disallowed email domain disables the account until
provisioning satisfies the provider's access rules again.

`active: false` and User DELETE use the **same leaver path as LDAP**: disable
the account, revoke sessions, API keys and issued gateway keys, pause its own
automations and notify the relevant admins. DELETE removes the SCIM resource
but keeps the disabled Optio account and its work. `active: true` re-enables
only accounts SCIM disabled, including paused automations; it never reverses
an administrator's manual disable or one made by LDAP sync. The last enabled
deployment admin is protected. Manually enable or transfer that role first if
needed. An IdP must retry failed provisioning requests; errors are returned
with SCIM status and detail fields.

Admin API: `GET/PUT /api/admin/scim`, `POST /api/admin/scim/tokens`, and
`DELETE /api/admin/scim/tokens/:id`. Protocol requests require a SCIM bearer
token on every endpoint; an Optio session or PAT does not grant SCIM access.
