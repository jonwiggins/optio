/**
 * REST surface for Optio Local (hosts, terminals, blueprints, triggers).
 * All resources are user-scoped: hosts are personal machines, and every
 * ownership miss is a 404. See docs/optio-local.md.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { repos } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { parseRepoUrl, type LocalTerminalSpec } from "@optio/shared";
import { logger } from "../logger.js";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema, EmptyResponseSchema } from "../schemas/common.js";
import {
  LocalBlueprintSchema,
  LocalHostDirSchema,
  LocalHostSchema,
  LocalTerminalSchema,
  LocalTerminalSpecSchema,
  LocalTranscriptEntrySchema,
  LocalTriggerSchema,
} from "../schemas/local.js";
import * as hostService from "../services/local-host-service.js";
import * as relay from "../services/local-relay.js";
import * as terminalService from "../services/local-terminal-service.js";
import * as blueprintService from "../services/local-blueprint-service.js";
import * as triggerService from "../services/trigger-service.js";
import {
  CreateTriggerBodySchema,
  UpdateTriggerBodySchema,
  replyTriggerError,
} from "../schemas/trigger.js";
import { getGitPlatformForRepo } from "../services/git-token-service.js";
import { buildTicketPrompt } from "../services/ticket-context.js";
import { getPromptTemplateById } from "../services/prompt-template-service.js";

const registerHostSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    hostname: z.string().min(1).max(255),
    platform: z.string().min(1).max(50),
    arch: z.string().max(50).optional(),
    daemonVersion: z.string().max(50).optional(),
    dirs: z.array(LocalHostDirSchema).max(200).default([]),
  })
  .describe("Daemon host registration (upsert by user + hostname)");

const createTerminalSchema = z
  .object({
    hostId: z.string().uuid(),
    dir: z.string().min(1).max(1000).optional(),
    title: z.string().max(200).optional(),
    spec: LocalTerminalSpecSchema.optional(),
    ticket: z
      .object({
        repoId: z.string().min(1),
        issueNumber: z.number().int().positive(),
        title: z.string().min(1),
        body: z.string().optional(),
        agentType: z.string().optional(),
      })
      .optional()
      .describe("Start the terminal seeded with an issue's context"),
  })
  .describe("Spawn a terminal on a local host");

const blueprintBodySchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    hostId: z.string().uuid().optional(),
    dir: z.string().max(1000).optional(),
    repoUrl: z.string().max(500).optional(),
    baseBranch: z
      .string()
      .max(200)
      .nullish()
      .describe("Agent spawns work on a new branch off this base and open a PR; null = as-is"),
    commandTemplate: z
      .string()
      .max(4000)
      .describe("Inline prompt / command template; may be empty when promptTemplateId is set"),
    runTitle: z
      .string()
      .max(200)
      .nullish()
      .describe(
        "Name each run gets: a {{param}} template rendered with the trigger's params; null = the definition's name",
      ),
    promptTemplateId: z
      .string()
      .uuid()
      .nullish()
      .describe(
        "Saved prompt (Prompts library) used as the agent prompt instead of commandTemplate",
      ),
    agent: z
      .enum(["claude-code", "codex", "cursor", "gemini", "opencode"])
      .nullish()
      .describe("Run the rendered template as this agent (gets attention hooks); null = shell"),
    spawnMode: z.enum(["auto", "hold"]).optional(),
    sessionMode: z
      .enum(["interactive", "headless"])
      .optional()
      .describe("Agent spawns: stay open for chat (default) or exit when the turn is done"),
  })
  .describe("Local automation (blueprint) definition");

const HostResponse = z.object({ host: LocalHostSchema });
const HostsResponse = z.object({ hosts: z.array(LocalHostSchema) });
const TerminalResponse = z.object({ terminal: LocalTerminalSchema });
const TerminalsResponse = z.object({ terminals: z.array(LocalTerminalSchema) });
const BlueprintResponse = z.object({ blueprint: LocalBlueprintSchema });
const BlueprintsResponse = z.object({ blueprints: z.array(LocalBlueprintSchema) });
const TriggerResponse = z.object({ trigger: LocalTriggerSchema });
const TriggersResponse = z.object({ triggers: z.array(LocalTriggerSchema) });

/**
 * Cross-field checks the Zod body can't express: a prompt must come from
 * somewhere, a linked saved prompt must exist, and a pinned host must be the
 * caller's own machine (a member could otherwise run commands on a
 * teammate's laptop by guessing its host id).
 */
async function checkBlueprintBody(
  body: {
    commandTemplate?: string;
    promptTemplateId?: string | null;
    hostId?: string | null;
  },
  userId: string | null | undefined,
): Promise<string | null> {
  if (!body.commandTemplate?.trim() && !body.promptTemplateId) {
    return "Give the automation a prompt / command, or pick a saved prompt";
  }
  if (body.promptTemplateId) {
    const saved = await getPromptTemplateById(body.promptTemplateId);
    if (!saved) return "Saved prompt not found";
  }
  if (body.hostId) {
    const host = await hostService.getHost(body.hostId);
    if (!host || !hostService.canAccessHost(host, userId)) return "Host not found";
  }
  return null;
}

export async function localRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const member = { preHandler: [requireRole("member")] };

  // ── Hosts ────────────────────────────────────────────────────────────────

  app.get(
    "/api/local/hosts",
    {
      schema: {
        operationId: "listLocalHosts",
        summary: "List the caller's paired local hosts",
        tags: ["Local"],
        response: { 200: HostsResponse },
      },
    },
    async (req, reply) => {
      const hosts = await hostService.listHosts(req.user?.id ?? null);
      reply.send({
        hosts: hosts.map((h) => ({
          ...h,
          claudeCredentials: relay.hostHasClaudeCredentials(h.id),
        })),
      });
    },
  );

  app.post(
    "/api/local/hosts/register",
    {
      ...member,
      schema: {
        operationId: "registerLocalHost",
        summary: "Register (or refresh) a local host",
        description:
          "Called by the `optio local` daemon on startup. Upserts by " +
          "(user, hostname) and replaces the advertised directory allowlist.",
        tags: ["Local"],
        body: registerHostSchema,
        response: { 200: HostResponse },
      },
    },
    async (req, reply) => {
      const host = await hostService.registerHost({
        userId: req.user?.id ?? null,
        workspaceId: req.user?.workspaceId ?? null,
        ...req.body,
      });
      reply.send({ host });
    },
  );

  app.delete(
    "/api/local/hosts/:id",
    {
      ...member,
      schema: {
        operationId: "deleteLocalHost",
        summary: "Unpair a local host (and delete its terminals)",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: EmptyResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const host = await hostService.getHost(req.params.id);
      if (!host || !hostService.canAccessHost(host, req.user?.id)) {
        return reply.status(404).send({ error: "Host not found" });
      }
      await hostService.deleteHost(host.id);
      reply.send({});
    },
  );

  // ── Terminals ────────────────────────────────────────────────────────────

  app.get(
    "/api/local/terminals",
    {
      schema: {
        operationId: "listLocalTerminals",
        summary: "List the caller's local terminals",
        tags: ["Local"],
        querystring: z.object({
          hostId: z.string().uuid().optional(),
          state: z.enum(["pending", "launching", "running", "exited", "error"]).optional(),
        }),
        response: { 200: TerminalsResponse },
      },
    },
    async (req, reply) => {
      const terminals = await terminalService.listTerminals(req.user?.id ?? null, req.query);
      reply.send({ terminals });
    },
  );

  app.post(
    "/api/local/terminals",
    {
      ...member,
      schema: {
        operationId: "createLocalTerminal",
        summary: "Spawn a terminal on a local host",
        description:
          "Spawns a shell, raw command, or agent CLI in an allowlisted " +
          "directory. With `ticket`, the prompt is seeded from the issue " +
          "(body + comments), the terminal is linked to it, and a " +
          "'working on this' comment is posted.",
        tags: ["Local"],
        body: createTerminalSchema,
        response: {
          201: TerminalResponse,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const host = await hostService.getHost(body.hostId);
      if (!host || !hostService.canAccessHost(host, req.user?.id)) {
        return reply.status(404).send({ error: "Host not found" });
      }

      let spec: LocalTerminalSpec = body.spec ?? { kind: "shell" };
      let dir = body.dir ?? null;
      let title = body.title;
      let ticketMeta: { source: string; externalId: string; url?: string } | undefined;
      let announceTicket: (() => Promise<void>) | null = null;

      if (body.ticket) {
        const t = body.ticket;
        const [repo] = await db.select().from(repos).where(eq(repos.id, t.repoId));
        if (!repo) return reply.status(404).send({ error: "Repo not found" });
        const wsId = req.user?.workspaceId;
        if (wsId && repo.workspaceId !== wsId) {
          return reply.status(404).send({ error: "Repo not found" });
        }
        const ri = parseRepoUrl(repo.repoUrl);
        if (!ri) return reply.status(400).send({ error: "Cannot parse repo URL" });

        dir = dir ?? hostService.findHostDirForRepo(host, repo.repoUrl);
        if (!dir) {
          return reply.status(400).send({
            error: `No directory on host "${host.name}" has a git remote matching ${repo.repoUrl}. Run \`optio local add <dir>\` on that machine.`,
          });
        }

        const { platform } = await getGitPlatformForRepo(repo.repoUrl, {
          userId: req.user?.id,
          server: !req.user,
        }).catch(() => ({ platform: null }));

        let comments: Array<{ author: string; createdAt: string; body: string }> = [];
        if (platform) {
          comments = await platform
            .getIssueComments(ri, t.issueNumber)
            .catch(() => [] as typeof comments);
        }
        const prompt = buildTicketPrompt({ title: t.title, body: t.body, comments });
        const agent = normalizeLocalAgent(t.agentType ?? repo.defaultAgentType);
        spec = { kind: "agent", agent, prompt };

        const ticketSource = ri.platform === "gitlab" ? "gitlab" : "github";
        const issueUrl =
          ri.platform === "gitlab"
            ? `https://${ri.host}/${ri.owner}/${ri.repo}/-/issues/${t.issueNumber}`
            : `https://${ri.host}/${ri.owner}/${ri.repo}/issues/${t.issueNumber}`;
        ticketMeta = { source: ticketSource, externalId: String(t.issueNumber), url: issueUrl };
        title = title ?? `#${t.issueNumber} ${t.title}`.slice(0, 200);

        if (platform) {
          const p = platform;
          announceTicket = async () => {
            await p.createIssueComment(
              ri,
              t.issueNumber,
              `**Optio Local**: a terminal session was started for this issue on \`${host.name}\`.`,
            );
          };
        }
      }

      if (!dir) return reply.status(400).send({ error: "dir is required" });

      let terminal;
      try {
        terminal = await terminalService.createTerminal({
          host,
          userId: req.user?.id ?? null,
          workspaceId: req.user?.workspaceId ?? null,
          dir,
          spec,
          title,
          spawnedBy: body.ticket ? "ticket" : "manual",
          ticket: ticketMeta,
        });
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      if (announceTicket) {
        announceTicket().catch((err) => logger.warn({ err }, "local: failed to comment on ticket"));
      }
      reply.status(201).send({ terminal });
    },
  );

  app.get(
    "/api/local/terminals/:id",
    {
      schema: {
        operationId: "getLocalTerminal",
        summary: "Get a local terminal",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: TerminalResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const terminal = await terminalService.getTerminal(req.params.id);
      if (!terminal || !terminalService.canAccessTerminal(terminal, req.user?.id)) {
        return reply.status(404).send({ error: "Terminal not found" });
      }
      reply.send({ terminal });
    },
  );

  app.get(
    "/api/local/terminals/:id/transcript",
    {
      schema: {
        operationId: "getLocalTerminalTranscript",
        summary: "The conversation of an agent session (prompts, replies, tool calls)",
        description:
          "Distilled by the daemon from the agent CLI's own transcript, so it covers the whole session — not just the last screen — and reads on any device. Grows while the session runs; `after` fetches only entries past a seq.",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          after: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(5000).default(2000),
        }),
        response: {
          200: z.object({
            entries: z.array(LocalTranscriptEntrySchema),
            /** True when fewer than `limit` entries came back, i.e. the caller has everything stored. */
            complete: z.boolean(),
          }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const terminal = await terminalService.getTerminal(req.params.id);
      if (!terminal || !terminalService.canAccessTerminal(terminal, req.user?.id)) {
        return reply.status(404).send({ error: "Terminal not found" });
      }
      const entries = await terminalService.getTranscript(
        terminal.id,
        req.query.after,
        req.query.limit,
      );
      reply.send({ entries, complete: entries.length < req.query.limit });
    },
  );

  app.patch(
    "/api/local/terminals/:id",
    {
      ...member,
      schema: {
        operationId: "updateLocalTerminal",
        summary: "Rename a terminal",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ title: z.string().min(1).max(200) }),
        response: { 200: TerminalResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const terminal = await terminalService.getTerminal(req.params.id);
      if (!terminal || !terminalService.canAccessTerminal(terminal, req.user?.id)) {
        return reply.status(404).send({ error: "Terminal not found" });
      }
      reply.send({ terminal: await terminalService.renameTerminal(terminal, req.body.title) });
    },
  );

  app.post(
    "/api/local/terminals/:id/start",
    {
      ...member,
      schema: {
        operationId: "startLocalTerminal",
        summary: "Start a pending (held or parked) terminal",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: TerminalResponse, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const terminal = await terminalService.getTerminal(req.params.id);
      if (!terminal || !terminalService.canAccessTerminal(terminal, req.user?.id)) {
        return reply.status(404).send({ error: "Terminal not found" });
      }
      try {
        const updated = await terminalService.startTerminal(terminal);
        reply.send({ terminal: updated });
      } catch (err) {
        reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post(
    "/api/local/terminals/:id/kill",
    {
      ...member,
      schema: {
        operationId: "killLocalTerminal",
        summary: "Kill a running terminal",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        // nullish: a bodiless POST reaches the validator as null, not undefined,
        // so .default({}) alone would 400 every curl/CLI kill without a body.
        body: z
          .object({ signal: z.enum(["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP"]).optional() })
          .nullish(),
        response: { 200: EmptyResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const terminal = await terminalService.getTerminal(req.params.id);
      if (!terminal || !terminalService.canAccessTerminal(terminal, req.user?.id)) {
        return reply.status(404).send({ error: "Terminal not found" });
      }
      try {
        await terminalService.killTerminal(terminal, req.body?.signal);
        reply.send({});
      } catch (err) {
        reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post(
    "/api/local/terminals/:id/resume",
    {
      ...member,
      schema: {
        operationId: "resumeLocalTerminal",
        summary: "Resume an agent session as a new interactive terminal",
        description:
          "Opens a fresh interactive terminal in the same directory that resumes the " +
          "agent's own session (`claude --resume <id>`). Works for headless runs that " +
          "already exited and for sessions still open. The agent must have reported a " +
          "session id (Claude Code / Codex).",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        // nullish: a bodiless POST reaches the validator as null (see kill).
        body: z.object({}).nullish(),
        response: { 201: TerminalResponse, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const terminal = await terminalService.getTerminal(req.params.id);
      if (!terminal || !terminalService.canAccessTerminal(terminal, req.user?.id)) {
        return reply.status(404).send({ error: "Terminal not found" });
      }
      try {
        const resumed = await terminalService.resumeTerminal(terminal);
        reply.status(201).send({ terminal: resumed });
      } catch (err) {
        reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post(
    "/api/local/terminals/:id/snooze",
    {
      ...member,
      schema: {
        operationId: "snoozeLocalTerminal",
        summary: 'Snooze a terminal ("Later"): drop it from the needs-you queue for a while',
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({ minutes: z.number().int().min(1).max(1440).optional() })
          .nullish()
          .describe("Snooze length in minutes (1–1440, default 15)"),
        response: { 200: TerminalResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const terminal = await terminalService.getTerminal(req.params.id);
      if (!terminal || !terminalService.canAccessTerminal(terminal, req.user?.id)) {
        return reply.status(404).send({ error: "Terminal not found" });
      }
      const updated = await terminalService.snoozeTerminal(terminal, req.body?.minutes ?? 15);
      reply.send({ terminal: updated });
    },
  );

  app.delete(
    "/api/local/terminals/:id/snooze",
    {
      ...member,
      schema: {
        operationId: "unsnoozeLocalTerminal",
        summary: "Clear a terminal's snooze so it re-enters the needs-you queue",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: TerminalResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const terminal = await terminalService.getTerminal(req.params.id);
      if (!terminal || !terminalService.canAccessTerminal(terminal, req.user?.id)) {
        return reply.status(404).send({ error: "Terminal not found" });
      }
      const updated = await terminalService.unsnoozeTerminal(terminal);
      reply.send({ terminal: updated });
    },
  );

  app.post(
    "/api/local/terminals/:id/input",
    {
      ...member,
      schema: {
        operationId: "sendLocalTerminalInput",
        summary: "Write to a terminal's stdin (REST fallback; prefer the stream WS)",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ data: z.string().max(65536) }),
        response: { 200: EmptyResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const terminal = await terminalService.getTerminal(req.params.id);
      if (!terminal || !terminalService.canAccessTerminal(terminal, req.user?.id)) {
        return reply.status(404).send({ error: "Terminal not found" });
      }
      if (terminal.state !== "running") {
        return reply.status(409).send({ error: `Terminal is ${terminal.state}` });
      }
      const { sendToHost } = await import("../services/local-relay.js");
      const sent = sendToHost(terminal.hostId, {
        type: "input",
        terminalId: terminal.id,
        dataB64: Buffer.from(req.body.data, "utf-8").toString("base64"),
      });
      if (!sent) return reply.status(409).send({ error: "Host is offline" });
      reply.send({});
    },
  );

  app.delete(
    "/api/local/terminals/:id",
    {
      ...member,
      schema: {
        operationId: "deleteLocalTerminal",
        summary: "Delete a non-running terminal record",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: EmptyResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const terminal = await terminalService.getTerminal(req.params.id);
      if (!terminal || !terminalService.canAccessTerminal(terminal, req.user?.id)) {
        return reply.status(404).send({ error: "Terminal not found" });
      }
      try {
        await terminalService.deleteTerminal(terminal);
        reply.send({});
      } catch (err) {
        reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Blueprints ───────────────────────────────────────────────────────────

  app.get(
    "/api/local/blueprints",
    {
      schema: {
        operationId: "listLocalBlueprints",
        summary: "List the caller's local blueprints",
        tags: ["Local"],
        response: { 200: BlueprintsResponse },
      },
    },
    async (req, reply) => {
      const blueprints = await blueprintService.listBlueprints(req.user?.id ?? null);
      reply.send({ blueprints });
    },
  );

  app.post(
    "/api/local/blueprints",
    {
      ...member,
      schema: {
        operationId: "createLocalBlueprint",
        summary: "Create a local blueprint",
        tags: ["Local"],
        body: blueprintBodySchema,
        response: { 201: BlueprintResponse, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const problem = await checkBlueprintBody(req.body, req.user?.id);
      if (problem) return reply.status(400).send({ error: problem });
      try {
        const blueprint = await blueprintService.createBlueprint({
          userId: req.user?.id ?? null,
          workspaceId: req.user?.workspaceId ?? null,
          ...req.body,
        });
        reply.status(201).send({ blueprint });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get(
    "/api/local/blueprints/:id",
    {
      schema: {
        operationId: "getLocalBlueprint",
        summary: "Get a local blueprint",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: BlueprintResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const blueprint = await blueprintService.getBlueprint(req.params.id);
      if (!blueprint || !blueprintService.canAccessBlueprint(blueprint, req.user?.id)) {
        return reply.status(404).send({ error: "Blueprint not found" });
      }
      reply.send({ blueprint });
    },
  );

  app.patch(
    "/api/local/blueprints/:id",
    {
      ...member,
      schema: {
        operationId: "updateLocalBlueprint",
        summary: "Update a local blueprint",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        body: blueprintBodySchema.partial().extend({
          enabled: z.boolean().optional(),
          description: z.string().max(2000).nullable().optional(),
          hostId: z.string().uuid().nullable().optional(),
          dir: z.string().max(1000).nullable().optional(),
          repoUrl: z.string().max(500).nullable().optional(),
        }),
        response: { 200: BlueprintResponse, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const blueprint = await blueprintService.getBlueprint(req.params.id);
      if (!blueprint || !blueprintService.canAccessBlueprint(blueprint, req.user?.id)) {
        return reply.status(404).send({ error: "Blueprint not found" });
      }
      const problem = await checkBlueprintBody(
        {
          commandTemplate: req.body.commandTemplate ?? blueprint.commandTemplate,
          promptTemplateId:
            req.body.promptTemplateId === undefined
              ? blueprint.promptTemplateId
              : req.body.promptTemplateId,
          hostId: req.body.hostId === undefined ? blueprint.hostId : req.body.hostId,
        },
        req.user?.id,
      );
      if (problem) return reply.status(400).send({ error: problem });
      const updated = await blueprintService.updateBlueprint(blueprint.id, req.body);
      reply.send({ blueprint: updated! });
    },
  );

  app.delete(
    "/api/local/blueprints/:id",
    {
      ...member,
      schema: {
        operationId: "deleteLocalBlueprint",
        summary: "Delete a local blueprint and its triggers",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: EmptyResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const blueprint = await blueprintService.getBlueprint(req.params.id);
      if (!blueprint || !blueprintService.canAccessBlueprint(blueprint, req.user?.id)) {
        return reply.status(404).send({ error: "Blueprint not found" });
      }
      await blueprintService.deleteBlueprint(blueprint.id);
      reply.send({});
    },
  );

  app.post(
    "/api/local/blueprints/:id/spawn",
    {
      ...member,
      schema: {
        operationId: "spawnLocalBlueprint",
        summary: "Spawn a terminal from a blueprint",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ params: z.record(z.unknown()).optional() }).nullish(),
        response: { 201: TerminalResponse, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const blueprint = await blueprintService.getBlueprint(req.params.id);
      if (!blueprint || !blueprintService.canAccessBlueprint(blueprint, req.user?.id)) {
        return reply.status(404).send({ error: "Blueprint not found" });
      }
      try {
        const terminal = await blueprintService.spawnFromBlueprint(blueprint, {
          params: req.body?.params,
          spawnedBy: "blueprint",
        });
        reply.status(201).send({ terminal });
      } catch (err) {
        reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Blueprint triggers ───────────────────────────────────────────────────

  app.get(
    "/api/local/blueprints/:id/triggers",
    {
      schema: {
        operationId: "listLocalBlueprintTriggers",
        summary: "List a blueprint's triggers",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: TriggersResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const blueprint = await blueprintService.getBlueprint(req.params.id);
      if (!blueprint || !blueprintService.canAccessBlueprint(blueprint, req.user?.id)) {
        return reply.status(404).send({ error: "Blueprint not found" });
      }
      const triggers = await triggerService.listTriggers("local_blueprint", blueprint.id);
      reply.send({ triggers });
    },
  );

  app.post(
    "/api/local/blueprints/:id/triggers",
    {
      ...member,
      schema: {
        operationId: "createLocalBlueprintTrigger",
        summary: "Attach a trigger to a blueprint",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid() }),
        body: CreateTriggerBodySchema,
        response: {
          201: TriggerResponse,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const blueprint = await blueprintService.getBlueprint(req.params.id);
      if (!blueprint || !blueprintService.canAccessBlueprint(blueprint, req.user?.id)) {
        return reply.status(404).send({ error: "Blueprint not found" });
      }
      const configError = triggerService.validateTriggerConfig(req.body.type, req.body.config);
      if (configError) return reply.status(400).send({ error: configError });
      try {
        const trigger = await triggerService.createTrigger({
          targetType: "local_blueprint",
          targetId: blueprint.id,
          ...req.body,
        });
        reply.status(201).send({ trigger });
      } catch (err) {
        if (replyTriggerError(reply, err, req.body)) return;
        throw err;
      }
    },
  );

  app.patch(
    "/api/local/blueprints/:id/triggers/:triggerId",
    {
      ...member,
      schema: {
        operationId: "updateLocalBlueprintTrigger",
        summary: "Update a blueprint trigger",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid(), triggerId: z.string().uuid() }),
        body: UpdateTriggerBodySchema,
        response: {
          200: TriggerResponse,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const blueprint = await blueprintService.getBlueprint(req.params.id);
      if (!blueprint || !blueprintService.canAccessBlueprint(blueprint, req.user?.id)) {
        return reply.status(404).send({ error: "Blueprint not found" });
      }
      const existing = await triggerService.getTriggerFor(
        "local_blueprint",
        blueprint.id,
        req.params.triggerId,
      );
      if (!existing) {
        return reply.status(404).send({ error: "Trigger not found" });
      }
      if (req.body.config !== undefined) {
        const problem = triggerService.validateTriggerConfig(existing.type, req.body.config);
        if (problem) return reply.status(400).send({ error: problem });
      }
      try {
        const updated = await triggerService.updateTrigger(req.params.triggerId, req.body);
        if (!updated) return reply.status(404).send({ error: "Trigger not found" });
        reply.send({ trigger: updated });
      } catch (err) {
        if (replyTriggerError(reply, err, req.body)) return;
        throw err;
      }
    },
  );

  app.delete(
    "/api/local/blueprints/:id/triggers/:triggerId",
    {
      ...member,
      schema: {
        operationId: "deleteLocalBlueprintTrigger",
        summary: "Delete a blueprint trigger",
        tags: ["Local"],
        params: z.object({ id: z.string().uuid(), triggerId: z.string().uuid() }),
        response: { 200: EmptyResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const blueprint = await blueprintService.getBlueprint(req.params.id);
      if (!blueprint || !blueprintService.canAccessBlueprint(blueprint, req.user?.id)) {
        return reply.status(404).send({ error: "Blueprint not found" });
      }
      const existing = await triggerService.getTriggerFor(
        "local_blueprint",
        blueprint.id,
        req.params.triggerId,
      );
      if (!existing) {
        return reply.status(404).send({ error: "Trigger not found" });
      }
      await triggerService.deleteTrigger(req.params.triggerId);
      reply.send({});
    },
  );
}

/** Map repo defaultAgentType values onto agents the daemon can launch. */
function normalizeLocalAgent(
  agentType: string | null | undefined,
): "claude-code" | "codex" | "cursor" | "gemini" | "opencode" {
  switch (agentType) {
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "gemini":
      return "gemini";
    case "opencode":
      return "opencode";
    default:
      return "claude-code";
  }
}
