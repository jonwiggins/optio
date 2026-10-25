/**
 * Starter prompts: organization prompts an admin adds from the Prompts page
 * ("Add starter prompts") — writing a Claude Code skill, a CLAUDE.md, a
 * review, a README, a safe refactor, a dependency upgrade. Each is written
 * once for every platform: its commands and words come in GitHub and GitLab
 * arms, and the run's repo picks one (`onGitLab` below).
 *
 * They are ordinary prompt_templates rows with no workspace and no owner
 * (every workspace sees them; admins edit or delete them like any other),
 * told apart by `params_schema.starter === true`. The seed is idempotent:
 * it upserts by (no workspace, name) and never duplicates.
 *
 * - At boot (index.ts, after the migrations) it adds them the first time
 *   only when the deployment asks for them (`OPTIO_STARTER_PROMPTS=true`,
 *   chart `prompts.starters`); once there, later boots add only the ones a
 *   newer version brings (`since`), so a starter an admin deleted stays
 *   deleted.
 * - "Add starter prompts" / "Restore starter prompts" (POST
 *   /api/prompt-templates/seed, workspace admins) adds every missing one and
 *   puts edited starters back to their text. A prompt of
 *   someone's own that happens to share a starter's name is never touched.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { promptTemplates } from "../db/schema.js";
import { logger } from "../logger.js";

/** Bumped when a release adds starters; each starter says which version brought it. */
export const STARTER_PROMPTS_VERSION = 1;

export interface StarterPrompt {
  name: string;
  kind: "task" | "review";
  description: string;
  template: string;
  /** The `{{params}}` the prompt takes. */
  params: Record<string, { description: string; required?: boolean }>;
  /** The STARTER_PROMPTS_VERSION that brought it. */
  since: number;
}

/**
 * The words and commands that differ by the repo's platform, as
 * `{{#if GIT_PLATFORM_GITLAB}}…{{else}}…{{/if}}` arms: a repo on GitLab gets
 * `glab` and its merge requests, any other repo `gh` and pull requests. A
 * prompt is rendered with its repo's platform (prompt-template-service.ts
 * `platformTemplateParams`); an arm never holds another `{{#if}}`.
 */
const onGitLab = (gitlab: string, other: string): string =>
  `{{#if GIT_PLATFORM_GITLAB}}${gitlab}{{else}}${other}{{/if}}`;
const MR = onGitLab("merge request", "pull request");
const MRS = onGitLab("merge requests", "pull requests");
const CI_CONFIG = onGitLab(".gitlab-ci.yml", ".github/workflows");

const SKILL = `Create a Claude Code skill for this repository: {{skillName}}.

What the skill is for: {{purpose}}

A skill is a folder under .claude/skills/<skill-name>/ with a SKILL.md that Claude Code loads when a task matches its description. A good skill turns something the team does again and again into instructions an agent can follow without guessing.

## Steps

1. Learn how the team does this today. Search the repository for the scripts, Makefile targets, CI jobs (${CI_CONFIG}), docs and past ${MRS} that touch it. Read them; don't invent a procedure the code doesn't support. If the repository already has skills under .claude/skills/, read two of them and match their shape and tone.

2. Write .claude/skills/<skill-name>/SKILL.md, where <skill-name> is a short kebab-case name:
   - YAML front matter with \`name\` and \`description\`. The description decides when the skill loads, so say plainly what the skill does AND when to use it ("Use when …"), in one or two sentences, with the words a person would type.
   - A short overview: what the skill achieves and what it needs (tools, credentials, services).
   - The procedure as numbered steps, each with the exact command or file to touch. Prefer the repository's own scripts over raw commands.
   - How to check the result worked (a command, a test, an expected output).
   - Pitfalls: what goes wrong in practice and how to recover. Take these from the code and the history, not from imagination.

3. Keep SKILL.md under about 300 lines. Put long reference material (an API table, a full config example) in separate files next to it and link them from SKILL.md, so the agent reads them only when it needs them.

4. If a step is fiddly and deterministic (parsing, templating, a multi-command sequence), add a small script under the skill's folder (scripts/) and call it from SKILL.md instead of describing it.

5. Try the skill: follow your own SKILL.md from the top on this repository, as an agent seeing it for the first time would. Fix every step that was unclear or wrong.

6. Open a ${MR} with the new skill. In the description, say what the skill does, when it loads, and how you tested it.

## Rules

- Nothing secret goes in the skill: no tokens, passwords or internal hostnames that aren't already in the repository.
- The skill must not download anything or call services the repository doesn't already use.
- Don't change application code; this ${MR} adds the skill only.`;

const MCP_NOTE = `Write a connection note for an MCP tool this team's agents use: {{toolName}}.

{{#if purpose}}What it's for: {{purpose}}{{/if}}

Agents here reach databases, files and internal services through MCP servers that an admin connects in Optio (Connections). An agent that knows what a connection offers, and what it must not do with it, uses it well; one that doesn't, guesses. Your job is a short, accurate note an agent reads before using {{toolName}}.

## Steps

1. Find out what the tool really is. Look in this repository for its configuration (.mcp.json, docs, scripts, the code that serves it) and read it. If it's an MCP server defined in this repository, read its tool definitions: their names, parameters and what they return.

2. Write docs/mcp/{{toolName}}.md (or the folder this repository already uses for such notes) with:
   - What it connects to, in one paragraph: the system, the environment (test, staging, production), and whose data it is.
   - Its tools: each tool's name, what it does, its important parameters, and an example call with the result it gives.
   - What it may be used for, and what not. Spell out anything destructive (writes, deletes, migrations) and say when an agent must stop and ask a person first.
   - Limits: rate limits, timeouts, the size of results, data that is sensitive and must not be copied into ${MRS} or logs.
   - How to tell it isn't working (the error you get when the connection is down or the credentials expired) and who owns it.

3. If the repository has a CLAUDE.md, add one line under its tools or integrations section that points at the new note, so agents find it.

4. Check every claim in the note against the code or configuration you read. Where you couldn't confirm something, say so in the note rather than guessing.

5. Open a ${MR} with the note. In the description, list the sources you read.

## Rules

- No credentials, tokens or connection strings in the note. Name the Optio connection or secret instead.
- Don't change the server's code or configuration in this ${MR}.`;

const CLAUDE_MD = `Write or improve the CLAUDE.md of this repository.

CLAUDE.md is the first thing Claude Code reads in a repository. A good one is short, true, and saves every agent the same half hour of discovery: how to build, how to test, where things live, and the few rules that aren't obvious from the code. A long one gets skimmed; a wrong one does damage.

{{#if focus}}Pay particular attention to: {{focus}}{{/if}}

## Steps

1. Read what is there: CLAUDE.md (if any), README, CONTRIBUTING, the package or build files (package.json, pom.xml, go.mod, Makefile…), ${CI_CONFIG}, and the top-level layout. Run the build and the tests once, the way CI does, so the commands you write down are ones you saw work.

2. Write CLAUDE.md at the repository root, aiming for under about 150 lines:
   - One paragraph: what this project is and who uses it.
   - Commands: install, build, run, test (all, one file, one test), lint, format, type-check. Exact commands, copied from what worked.
   - Layout: the main directories and what lives in each, one line apiece.
   - Conventions the code follows that a newcomer would get wrong: naming, error handling, where tests go, how migrations or generated files are made.
   - Rules: what never to do (edit generated files, commit secrets, change a public API without …), and what to always do (run the tests before opening a ${MR}, …).
   - Pointers to deeper docs, rather than copying them in.

3. If a CLAUDE.md exists, keep what is still true, correct what isn't, and cut what is stale or obvious. Don't throw away a rule you can't explain — ask about it in the ${MR} description instead.

4. If one part of the repository needs its own rules (a frontend app, a set of migrations), a short CLAUDE.md in that directory is better than a long section in the root one.

5. Verify every command in the file by running it. Verify every path exists.

6. Open a ${MR} with the new CLAUDE.md. In the description, list what you changed and why, and any rule you weren't sure about.

## Rules

- Only facts you checked in this repository. No generic advice ("write clean code").
- No secrets, internal URLs that aren't already in the repository, or personal names.`;

const REVIEW_THOROUGH = `Review ${onGitLab("merge request !{{mr}}", "pull request #{{mr}}")} thoroughly.

You are reviewing one ${MR}. Do not modify code, push, or review any other ${MR}.

## Steps

1. Read the ${MR} and its discussion:
   ${onGitLab("glab mr view {{mr}} --comments", "gh pr view {{mr}} --comments")}
   ${onGitLab("glab mr diff {{mr}}", "gh pr diff {{mr}}")}

2. Understand what it is meant to do: the description, the linked issue, and the commit messages. If it is unclear what the change is for, that is your first finding.

3. Read the code around the diff — the callers of what changed, the tests that cover it, the types and schemas it touches — until you can say whether the change is right, not only whether it looks right.

4. Check the tests:
   - Run the project's test command{{#if testCommand}} ({{testCommand}}){{/if}}, or read the ${onGitLab(
     "pipeline: glab ci status --branch <the MR's source branch>. A failed job is a finding; read it with glab ci trace.",
     "checks: gh pr checks {{mr}}. A failed check is a finding; read its log with gh run view <run-id> --log-failed.",
   )}
   - Is the new behavior tested? Would the tests fail if the change were reverted?

5. Look for:
   - Correctness: logic errors, off-by-one, wrong conditions, unhandled null or empty cases, error paths that swallow failures.
   - Regressions: callers that now behave differently, changed defaults, removed behavior.
   - Security: injection (SQL, shell, path), missing authorization checks, secrets in code or logs, unsafe deserialization, data leaking across tenants or users.
   - Data: migrations that lock or rewrite large tables, changes that aren't backwards compatible with running versions.
   - Concurrency: races, missing transactions, retries that double-apply.
   - Maintainability: duplication, a simpler existing helper, names that mislead. Mention these briefly; they are not blockers.

6. Post your review on the ${MR}:
   - Each finding: the file and line, what is wrong, why it matters, and a concrete fix. Order them by severity.
   - Separate blockers from suggestions.
${onGitLab(
  `   - If it is good: glab mr approve {{mr}} || (glab mr revoke {{mr}} && glab mr approve {{mr}}) (an approval you already gave is given again, so it counts after any changes you requested since), then glab mr note {{mr}} --message "<summary of what you checked>".
   - If it needs changes: glab mr note {{mr}} --message "**Changes Requested:** <the blockers>".`,
  `   - If it is good: gh pr review {{mr}} --approve --body "<summary of what you checked>".
   - If it needs changes: gh pr review {{mr}} --request-changes --body "<the blockers>".`,
)}

## Rules

- Only real issues. No style nitpicks a formatter would catch.
- Be specific and kind: the author should be able to fix each finding without asking what you meant.`;

const REVIEW_LIGHT = `Give ${onGitLab("merge request !{{mr}}", "pull request #{{mr}}")} a light review.

A light review is a quick second pair of eyes: read the diff, catch what would hurt if it merged, and say it in a few lines. Do not run the tests, explore the codebase, modify code, or review any other ${MR}.

## Steps

1. Read the diff and the description:
   ${onGitLab("glab mr view {{mr}}", "gh pr view {{mr}}")}
   ${onGitLab("glab mr diff {{mr}}", "gh pr diff {{mr}}")}

2. Look for what would hurt in production:
   - A bug: a wrong condition, a missing null check, an error that is swallowed.
   - A regression: behavior that changed for existing callers.
   - A security hole: unchecked input reaching SQL, a shell, a file path; a missing permission check; a secret in the diff.
   - Something irreversible: a destructive migration, a deleted public API.

3. Report at most the three most important findings, each in one or two sentences with the file and line and the fix. Skip style, naming and anything a formatter or linter would catch. If you found nothing that matters, say so in one line.

4. Post it:
${onGitLab(
  `   - Nothing blocking: glab mr approve {{mr}} || (glab mr revoke {{mr}} && glab mr approve {{mr}}), then glab mr note {{mr}} --message "Light review: <one-line summary>".
   - Something blocking: glab mr note {{mr}} --message "**Changes Requested:** <the findings>".`,
  `   - Nothing blocking: gh pr review {{mr}} --approve --body "Light review: <one-line summary>".
   - Something blocking: gh pr review {{mr}} --request-changes --body "<the findings>".`,
)}

Keep the whole review under about ten turns.

## What a good light review looks like

Light review: one blocker, one suggestion.

1. **Blocker** — src/orders/refund.ts:88: the refund amount is taken from the request body without checking it against the order total, so a caller can refund more than was paid. Compare it with order.total and reject anything larger.
2. Suggestion — src/orders/refund.ts:102: the catch block logs and returns 200; return the error so the client can retry.

## When to stop and say so

- The diff is too large to read in a light review (hundreds of files, a generated lockfile, a vendored library): say that it needs a thorough review instead, and approve nothing.
- The change touches authentication, payments, migrations or permissions: point that out in one line even if you found nothing, so a person looks.`;

const SECURITY_REVIEW = `Do a security review of {{target}}.

You are looking for vulnerabilities, not style. Do not modify code or push. Report what you find; a person decides what to fix.

## Steps

1. Read the code in scope. For a ${onGitLab(
  "merge request (!<iid>): glab mr view <iid> --comments and glab mr diff <iid>",
  "pull request (#<number>): gh pr view <number> --comments and gh pr diff <number>",
)}, then the code around the diff. For a part of the code: every file in it, and the callers that feed it input. Note where untrusted input enters (HTTP handlers, message consumers, file uploads, webhooks, CLI arguments, environment) and follow it to where it is used.

2. Check, in order of how often they bite:
   - Injection: SQL built by string concatenation, shell commands with interpolated input, file paths from input (path traversal), template injection, LDAP or header injection.
   - Authorization: every route or operation checks who the caller is AND whether they may act on this object (not just "is logged in"). Look for IDs taken from the request without an ownership check, and for data of one tenant, workspace or user reachable by another.
   - Authentication and sessions: token validation, expiry, cookie flags, password and secret handling, timing-safe comparison.
   - Secrets: credentials in code, config, tests, logs or error messages; secrets sent to the client.
   - Input handling: missing validation or size limits, unsafe deserialization, regular expressions that can hang, unbounded loops or allocations from input.
   - Outbound requests: server-side request forgery (URLs from input), TLS verification turned off.
   - Dependencies: libraries with known vulnerabilities pinned in the lockfile (check the versions you can see; where you can't look them up from here, say what you'd check).
   - Logging: sensitive data written to logs; security events not logged.

3. For each finding, write:
   - Severity (critical, high, medium, low) and why.
   - Where: file and line.
   - How it could be exploited, concretely: which input, which caller.
   - The fix.

4. Write the report. For a ${MR}, post it as ${onGitLab(
  'a note: glab mr note <iid> --message "…"',
  'a comment: gh pr comment <number> --body "…"',
)}. For a part of the code, write SECURITY-REVIEW.md on a new branch and open a ${MR} with it. Start with a one-paragraph summary and the count by severity. Say what you did NOT review.

## Rules

- No working exploit code. Describe the attack, don't build it.
- Mark anything you are not sure of as "to confirm" rather than inflating it.`;

const DOCUMENT_MODULE = `Document the module {{module}}.

The goal is that a developer new to this code can read the documentation and change the module with confidence: what it is for, how it is put together, how to use it, and what not to break.

## Steps

1. Read the module completely: its public interface, its internals, its tests, and its callers elsewhere in the repository (search for its imports). Read the history of its key files (git log --follow) for the reasons behind non-obvious choices.

2. Add or improve the documentation comments on the public interface — every exported function, class, type and constant — in the language's own style (JSDoc, docstrings, Javadoc, GoDoc…). Say what it does, its parameters and return value, the errors it raises, and anything surprising (side effects, ordering, thread safety). Don't restate the name ("getUser gets the user").

3. Write a module overview — a README.md in the module's directory, or the module-level doc comment, whichever this repository already does:
   - Purpose, in a paragraph: the problem it solves and what is out of scope.
   - How it fits in: who calls it, what it depends on. A small diagram in text or Mermaid if it helps.
   - Main concepts and data flow.
   - How to use it: two or three short examples taken from real callers.
   - Invariants and pitfalls: what must stay true, what has broken before.
   - How to test it.

4. Comment the internals only where the code can't speak for itself: the why, not the what.

5. Run the build and the tests; documentation comments can break doc generators and linters.

6. Open a ${MR}. The diff should change comments and docs only — no behavior. In the description, list anything you found that looks like a bug, without fixing it.`;

const API_DOCS = `Generate API documentation for this repository's HTTP API{{#if scope}}, limited to {{scope}}{{/if}}.

The documentation must match the code exactly: every endpoint, parameter and response you write down is one you found in the code.

## Steps

1. Find the API. Look for the route definitions (controllers, routers, handlers), any existing OpenAPI/Swagger spec or generator, and the request and response types or schemas. If the project already generates a spec from code (annotations, a schema library), prefer improving those annotations over writing a spec by hand.

2. For each endpoint, collect from the code:
   - Method and path, and what it does in one sentence.
   - Who may call it: authentication, roles or permissions checked.
   - Path, query and body parameters: name, type, required or optional, defaults, validation rules.
   - Responses: status codes and their bodies, including errors.
   - Side effects: what it writes, what events or jobs it starts.

3. Produce the documentation in the form this repository uses:
   - If there is a generated spec: add the missing descriptions, examples and error responses to the source annotations, regenerate, and commit the result.
   - If not: write an OpenAPI 3 file (openapi.yaml) under docs/, plus a short docs/api.md that explains authentication, pagination, error format and versioning, and links to the spec.

4. Add at least one realistic example request and response per endpoint group, made from the code's own types and test fixtures.

5. Validate the spec if the repository's toolchain has a validator. Check that every path in it exists in the code, and every route in the code is in it.

6. Open a ${MR}. In the description, list endpoints whose behavior looked inconsistent or undocumented in code, without changing them.

## Rules

- Describe what the code does today, even where it looks wrong; flag it rather than documenting the behavior you think was intended.
- Examples use made-up but realistic data — never real customer data, tokens or internal hostnames copied from logs or fixtures.
- Don't change routes, handlers or validation in this ${MR}: documentation and annotations only.`;

const README = `Write a README for this repository{{#if scope}}, for its part {{scope}}{{/if}}.

A README answers, in this order: what is this, why would I use it, how do I run it, how do I work on it. Someone landing here from a link should know within a minute whether this is what they were looking for.

## Steps

1. Read the repository: the code's entry points, the build files, the configuration, ${CI_CONFIG}, existing docs, and the existing README if there is one. Run the install, build and test commands so the ones you write are ones that work.

2. Write README.md with:
   - The name and a one-paragraph description: what it does and for whom.
   - Features or capabilities — only ones you found in the code.
   - Requirements: runtimes and versions, services it needs (database, queue…), access it needs.
   - Getting started: clone, install, configure (the environment variables or config file, with a table of the important settings and their defaults), run. Copy-paste commands.
   - Usage: the main ways to use it, with one or two short examples.
   - Development: how to run the tests, lint, and build; the layout of the repository in a few lines; how to contribute (branch and ${MR} conventions, if the repository has any).
   - Deployment, if the repository deploys something: where it runs and how a release happens (point at the CI job).
   - Where to get help and who owns it, if the repository says.

3. Keep it scannable: short sections, code blocks for commands, a table for configuration. Move long material to docs/ and link it.

4. If a README exists, keep what is still true and correct what isn't. Don't remove sections you can't verify — flag them in the ${MR} description.

5. Open a ${MR} with the README.

## Rules

- No claims you didn't check in the code. No badges or links to services the project doesn't use.`;

const FIX_TICKET = `Fix the bug described in {{ticket}}.

{{#if details}}Details: {{details}}{{/if}}

## Steps

1. Understand the bug. Read the ticket{{#if details}} and the details above{{/if}} carefully: the expected behavior, the actual behavior, the steps to reproduce, the environment, any logs or stack traces. If the ticket is in an issue tracker you can read from here (GitHub, GitLab, Jira), read the comments too.

2. Find the cause, not just the symptom. Locate the code involved (search for the error message, the endpoint, the function in the stack trace). Read it and its history (git log -p on the relevant files) — the change that introduced the bug often explains it.

3. Reproduce it with a test first. Write an automated test that fails because of the bug, in the style of the existing tests next to the code. Run it and see it fail for the reason the ticket describes. If you truly cannot reproduce it, stop and explain in the ${MR} what you tried.

4. Fix it with the smallest change that addresses the cause. Don't refactor around it; don't fix other things you notice (list them in the ${MR} description instead).

5. Check for the same bug elsewhere: the same pattern copied into other places, other callers of the function you fixed.

6. Run the full test suite and the linters. Everything must pass.

7. Commit with a message that names the ticket ({{ticket}}) and says what was wrong and how it is fixed.

8. Open a ${MR}. In the description:
   - Link the ticket ({{ticket}}).
   - Root cause, in two or three sentences.
   - The fix, and why it is the right one.
   - How to verify it: the test you added, and manual steps if useful.
   - Risks, and anything related you noticed but didn't change.`;

const REFACTOR = `Refactor {{target}} safely.

{{#if goal}}The goal: {{goal}}{{/if}}

A refactor changes the structure of the code without changing what it does. Every caller, every test and every output must behave exactly as before.

## Steps

1. Read {{target}} and everything that uses it (search for its imports and references). Write down its current behavior as you understand it, including the odd cases.

2. Make sure the behavior is pinned by tests before you change anything. Run the existing tests that cover it. Where they don't cover a behavior you're about to touch — an edge case, an error path, an output format — add characterization tests that record what the code does today, even if it looks wrong. Commit those tests on their own first.

3. Plan the refactor as a series of small steps, each of which leaves the code building and the tests passing (extract a function, rename, move, replace a conditional, …). Prefer the repository's existing patterns and helpers over new abstractions.

4. Do the steps one at a time. After each, run the build and the tests. Commit at each green step with a message that says what moved, so a reviewer can follow the series.

5. Keep the public interface the same unless changing it is the point of the refactor. If it must change, update every caller in the same ${MR}, and keep an alias or a deprecation path if other repositories use it.

6. Don't fix bugs along the way. If you find one, note it in the ${MR} description (or fix it in a separate commit with its own test, clearly labelled).

7. At the end: the full test suite, linters and type checks pass; the diff shows no behavior change; performance-sensitive paths are no slower.

8. Open a ${MR}. In the description: what changed structurally and why, how you made sure behavior didn't change (which tests pin it), and anything you noticed but left alone.`;

const ADD_TESTS = `Add tests for {{target}}.

{{#if focus}}Focus on: {{focus}}{{/if}}

The goal is tests that would catch a real regression: they fail when the behavior breaks and pass for the right reason, not tests that only raise a coverage number.

## Steps

1. Learn how this repository tests. Find the test framework, the test files next to {{target}} or in the test directory, the fixtures and helpers, and how to run a single test file. Run the existing tests for {{target}} and note what they cover.

2. Read {{target}} and list its behaviors: the main paths, the edge cases (empty, null, boundaries, large inputs, unicode), the error paths, and anything that depends on time, randomness, the network or the database.

3. Write the tests, in the repository's style:
   - One behavior per test, named for the behavior ("rejects an expired token"), not the method.
   - Arrange, act, assert — with assertions on outcomes, not on internal calls, wherever possible.
   - Mock only the boundaries (network, clock, external services); use the repository's existing fakes and factories.
   - Deterministic: no sleeps, no dependence on test order, no real network.

4. For each new test, make sure it can fail: break the code under test on purpose (flip a condition), see the test fail, and put the code back.

5. If you find a bug while testing, don't fix it here: write the test that shows it, mark it as expected to fail (or skip it with a reason) the way this repository does, and describe the bug in the ${MR}.

6. Run the whole suite and the linters; everything must pass.

7. Open a ${MR} that adds tests only. In the description, list the behaviors now covered and any you left out and why.

## Rules

- Don't change the code under test, not even to make it easier to test. If it can't be tested without a change, say what change and why in the description.
- Don't delete or weaken existing tests.
- Keep test data small and readable; no copies of production data.`;

const UPGRADE_DEP = `Upgrade the dependency {{dependency}}{{#if version}} to {{version}}{{/if}}.

## Steps

1. Find where it is declared and used: the manifest (package.json, pom.xml, build.gradle, requirements.txt, go.mod, …), the lockfile, and every import or reference in the code. Note the version in use today.

2. Read what changed between the current version and the one you are upgrading to{{#if version}} ({{version}}){{/if}} — without a version given, the newest the package registry offers: the changelog or release notes and the migration guide, from the package itself or its registry. List the breaking changes and deprecations that affect the code you found in step 1. If the notes aren't available from here, say so rather than guessing.

3. Upgrade it with the project's own tool (npm/pnpm/yarn, mvn/gradle, pip/poetry, go get …) so the lockfile is regenerated, not hand-edited. Upgrade only this dependency and what it strictly requires; don't take the chance to upgrade others.

4. Adapt the code to the breaking changes, one at a time. Replace deprecated calls where the replacement is straightforward.

5. Run the build, the type checks, the linters and the full test suite. Fix every failure the upgrade caused. If a failure is unrelated and was already there, note it and leave it.

6. Check the parts tests don't cover well: start the application if you can, exercise the features that use the dependency, and watch for warnings at startup.

7. Open a ${MR} titled "Upgrade {{dependency}} to <version>". In the description:
   - From and to versions.
   - The breaking changes that applied and how you handled each.
   - Anything that needs a person's attention: configuration to change at deploy time, behavior that changed for users, risks.
   - How you verified it.

## Rules

- One dependency per ${MR}, so a regression points at one change.
- If the upgrade needs a newer runtime, a changed build image, or a major rewrite, stop after step 2 and describe what it would take instead of doing it.`;

export const STARTER_PROMPTS: readonly StarterPrompt[] = [
  {
    name: "Create a Claude Code skill",
    kind: "task",
    description:
      "A .claude/skills/<name>/SKILL.md that turns something the team does often into steps an agent follows.",
    template: SKILL,
    params: {
      skillName: { description: "What to call the skill", required: true },
      purpose: { description: "What the skill is for and when it should load", required: true },
    },
    since: 1,
  },
  {
    name: "Create an MCP tool / connection note",
    kind: "task",
    description:
      "A short, checked note that tells agents what an MCP connection offers and what not to do with it.",
    template: MCP_NOTE,
    params: {
      toolName: { description: "The MCP server or connection's name", required: true },
      purpose: { description: "What it's for (optional)" },
    },
    since: 1,
  },
  {
    name: "Write or improve CLAUDE.md",
    kind: "task",
    description:
      "A short, true CLAUDE.md: commands that work, the layout, and the rules that bite.",
    template: CLAUDE_MD,
    params: { focus: { description: "Anything to pay particular attention to (optional)" } },
    since: 1,
  },
  {
    name: "Code review (thorough)",
    kind: "review",
    description:
      "Reads the diff and the code around it, checks the tests or the pipeline, and posts ranked findings.",
    template: REVIEW_THOROUGH,
    params: {
      mr: { description: "The pull or merge request's number", required: true },
      testCommand: { description: "The test command to run (optional)" },
    },
    since: 1,
  },
  {
    name: "Code review (light)",
    kind: "review",
    description: "The diff only, no tests: the top three findings in under ten turns.",
    template: REVIEW_LIGHT,
    params: { mr: { description: "The pull or merge request's number", required: true } },
    since: 1,
  },
  {
    name: "Security review",
    kind: "review",
    description:
      "Follows untrusted input through a pull or merge request or a part of the code and reports vulnerabilities by severity.",
    template: SECURITY_REVIEW,
    params: {
      target: {
        description: "A pull or merge request (#42, !42) or a part of the code (a path or module)",
        required: true,
      },
    },
    since: 1,
  },
  {
    name: "Document this module",
    kind: "task",
    description:
      "Doc comments on the public interface and an overview a newcomer can change the code from.",
    template: DOCUMENT_MODULE,
    params: { module: { description: "The module's path or name", required: true } },
    since: 1,
  },
  {
    name: "Generate API docs",
    kind: "task",
    description: "An OpenAPI spec and a short guide, every endpoint taken from the code.",
    template: API_DOCS,
    params: { scope: { description: "Which API or service (optional; the whole repository)" } },
    since: 1,
  },
  {
    name: "Write a README",
    kind: "task",
    description:
      "What it is, why use it, how to run it, how to work on it — checked commands only.",
    template: README,
    params: { scope: { description: "A sub-project to write it for (optional)" } },
    since: 1,
  },
  {
    name: "Fix a bug from a ticket",
    kind: "task",
    description:
      "A failing test first, the root cause, the smallest fix, and a pull or merge request that explains it.",
    template: FIX_TICKET,
    params: {
      ticket: {
        description: "The ticket's key or URL (a GitHub or GitLab issue, or Jira)",
        required: true,
      },
      details: { description: "What you know beyond the ticket (optional)" },
    },
    since: 1,
  },
  {
    name: "Refactor safely",
    kind: "task",
    description:
      "Behavior pinned by tests first, then small green steps, and no behavior change in the diff.",
    template: REFACTOR,
    params: {
      target: { description: "The code to refactor (a file, module or function)", required: true },
      goal: { description: "What the refactor should achieve (optional)" },
    },
    since: 1,
  },
  {
    name: "Add tests",
    kind: "task",
    description: "Tests that fail when the behavior breaks, in the repository's own style.",
    template: ADD_TESTS,
    params: {
      target: { description: "The code to test", required: true },
      focus: { description: "Behaviors to concentrate on (optional)" },
    },
    since: 1,
  },
  {
    name: "Upgrade a dependency",
    kind: "task",
    description:
      "One dependency, its breaking changes handled, the lockfile regenerated, and the suite green.",
    template: UPGRADE_DEP,
    params: {
      dependency: { description: "The package to upgrade", required: true },
      version: { description: "The version to go to (optional; the newest available)" },
    },
    since: 1,
  },
];

/** The params_schema a starter is stored with: its params, and the starter mark. */
export function starterParamsSchema(p: StarterPrompt): Record<string, unknown> {
  const required = Object.entries(p.params)
    .filter(([, v]) => v.required)
    .map(([k]) => k);
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(p.params).map(([k, v]) => [k, { type: "string", description: v.description }]),
    ),
    ...(required.length ? { required } : {}),
    starter: true,
    starterVersion: p.since,
  };
}

/** Whether a prompt_templates row is one of the starters (the seed's own). */
export function isStarterRow(row: { paramsSchema?: Record<string, unknown> | null }): boolean {
  return row.paramsSchema?.starter === true;
}

export interface SeedResult {
  created: number;
  restored: number;
  unchanged: number;
}

/**
 * Upsert the starters as organization prompts with no workspace. `restore`
 * (the Prompts page's button) also adds starters deleted earlier and puts
 * edited ones back; without it (boot) only the first seed and newer
 * versions' starters are added.
 */
/** Whether the first boot adds the starter prompts (OPTIO_STARTER_PROMPTS, default off). */
export function starterPromptsAtBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPTIO_STARTER_PROMPTS ?? "").trim().toLowerCase() === "true";
}

export async function seedStarterPrompts(opts: { restore?: boolean } = {}): Promise<SeedResult> {
  const result: SeedResult = { created: 0, restored: 0, unchanged: 0 };
  const names = STARTER_PROMPTS.map((p) => p.name);
  const existing = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        isNull(promptTemplates.workspaceId),
        isNull(promptTemplates.ownerUserId),
        inArray(promptTemplates.name, names),
      ),
    );
  const byName = new Map(existing.map((r) => [r.name, r]));
  // The newest starter version seeded before; none means this is the first seed.
  const seenVersion = existing
    .filter(isStarterRow)
    .reduce<number>((max, r) => Math.max(max, Number(r.paramsSchema?.starterVersion) || 1), 0);
  // A boot adds none until the deployment asks for them or an admin restores them.
  if (!opts.restore && seenVersion === 0 && !starterPromptsAtBoot()) return result;

  for (const p of STARTER_PROMPTS) {
    const row = byName.get(p.name);
    const paramsSchema = starterParamsSchema(p);
    if (!row) {
      if (!opts.restore && seenVersion > 0 && p.since <= seenVersion) {
        // Seeded before and since deleted by an admin: it stays deleted.
        result.unchanged++;
        continue;
      }
      const inserted = await db
        .insert(promptTemplates)
        .values({
          name: p.name,
          template: p.template,
          kind: p.kind,
          description: p.description,
          paramsSchema,
          workspaceId: null,
          ownerUserId: null,
          ownerTeamId: null,
          isDefault: false,
        })
        // Another replica seeding at the same boot: the unique (scope, name) index decides.
        .onConflictDoNothing()
        .returning({ id: promptTemplates.id });
      if (inserted.length > 0) result.created++;
      else result.unchanged++;
      continue;
    }
    if (!isStarterRow(row)) {
      // Someone's own prompt with a starter's name: never touched.
      result.unchanged++;
      continue;
    }
    const differs =
      row.template !== p.template ||
      row.kind !== p.kind ||
      row.description !== p.description ||
      JSON.stringify(row.paramsSchema) !== JSON.stringify(paramsSchema);
    if (opts.restore && differs) {
      await db
        .update(promptTemplates)
        .set({
          template: p.template,
          kind: p.kind,
          description: p.description,
          paramsSchema,
          updatedAt: new Date(),
        })
        .where(eq(promptTemplates.id, row.id));
      result.restored++;
    } else {
      result.unchanged++;
    }
  }
  logger.info({ ...result, restore: !!opts.restore }, "Starter prompts seeded");
  return result;
}
