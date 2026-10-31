"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import { TEAM_JOIN_POLICY_LABEL, type Team } from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import { useMyTeams } from "@/hooks/use-my-teams";
import { useDeploymentSwitches } from "@/hooks/use-deployment-switches";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { IfCanMutate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import { NewTeamDialog } from "@/components/teams/new-team-dialog";
import {
  JOIN_POLICY_SHORT,
  STANDING_LABEL,
  joinAction,
  standingOf,
  type Standing,
} from "@/components/teams/standing";

/**
 * The workspace's teams (docs/teams.md): yours first, then the rest, each
 * with its size, who can join, where you stand, and the one button that
 * changes that — Join, Request to join, Leave, Cancel request. "New team"
 * makes you the first admin of a new one; a team's own page runs it.
 */
export default function TeamsPage() {
  usePageTitle("Teams");
  const router = useRouter();
  // Pickers elsewhere may have loaded the list earlier; this page wants it fresh.
  const { teams, loaded, reload } = useMyTeams({ fresh: true });
  const switches = useDeploymentSwitches();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const mine = teams.filter((t) => t.myStatus === "active");
  const others = teams.filter((t) => t.myStatus !== "active");

  const act = async (t: Team) => {
    const action = joinAction(t);
    if (action.kind === "none") return;
    setBusy(t.id);
    try {
      if (action.kind === "join" || action.kind === "request") {
        const { team } = await api.joinTeam(t.id);
        toast.success(
          team.myStatus === "active" ? `You joined ${t.name}` : `Asked to join ${t.name}`,
        );
      } else {
        await api.leaveTeam(t.id);
        toast.success(action.kind === "leave" ? `You left ${t.name}` : "Request withdrawn");
      }
      await reload();
    } catch (err) {
      toast.error(`Couldn't ${action.label.toLowerCase()}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const newButton = (
    <IfCanMutate>
      <Button onClick={() => setCreating(true)}>
        <Plus />
        New team
      </Button>
    </IfCanMutate>
  );

  const row = (t: Team) => {
    const standing = standingOf(t);
    const action = joinAction(t);
    return (
      <div key={t.id} className="flex items-center gap-3 px-4 py-3 hover:bg-bg-hover/40">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/teams/${t.id}`}
              className="text-sm font-medium text-text-heading hover:underline underline-offset-2 truncate"
            >
              {t.name}
            </Link>
            <StandingChip standing={standing} />
            {t.canManage && t.pendingCount > 0 && (
              <Link
                href={`/teams/${t.id}`}
                className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-warning/10 text-warning font-medium"
              >
                {t.pendingCount} request{t.pendingCount === 1 ? "" : "s"}
              </Link>
            )}
          </div>
          {t.description && (
            <p className="text-[11px] text-text-muted truncate mt-0.5">{t.description}</p>
          )}
          <p className="text-[11px] text-text-muted mt-0.5">
            <span>{`${t.memberCount} member${t.memberCount === 1 ? "" : "s"}`}</span>
            {" · "}
            <span title={TEAM_JOIN_POLICY_LABEL[t.joinPolicy]}>
              {JOIN_POLICY_SHORT[t.joinPolicy]}
            </span>
          </p>
        </div>
        <IfCanMutate>
          {action.kind === "none" ? (
            <span className="text-[11px] text-text-muted shrink-0">{action.reason}</span>
          ) : (
            <Button
              size="sm"
              variant={
                action.kind === "join" || action.kind === "request" ? "primary" : "secondary"
              }
              disabled={busy === t.id}
              onClick={() => act(t)}
            >
              {busy === t.id && <Loader2 className="animate-spin" />}
              {action.label}
            </Button>
          )}
        </IfCanMutate>
      </div>
    );
  };

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={Users}
        title="Teams"
        description="A team shares its work and secrets with its members. Join one, ask to, or start your own."
        meta={
          teams.length > 0 ? (
            <span>
              {teams.length} team{teams.length === 1 ? "" : "s"} · you&apos;re in {mine.length}
            </span>
          ) : null
        }
        actions={switches.teams ? newButton : undefined}
      />

      {switches.loaded && !switches.teams ? (
        <EmptyState
          icon={Users}
          title="Teams are off"
          description="A deployment admin turns them on under Settings → Access → Teams."
        />
      ) : !loaded ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 skeleton-shimmer rounded-lg" />
          ))}
        </div>
      ) : teams.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No teams yet"
          description="Start one for the people who share work and secrets. You become its first admin; SSO groups can fill it."
          action={newButton}
        />
      ) : (
        <div className="space-y-4">
          <Panel title="Your teams">
            {mine.length > 0 ? (
              <div className="divide-y divide-border/60">{mine.map(row)}</div>
            ) : (
              <PanelEmpty>
                You&apos;re not in a team yet. Join one below, or start your own.
              </PanelEmpty>
            )}
          </Panel>
          <Panel title="Other teams">
            {others.length > 0 ? (
              <div className="divide-y divide-border/60">{others.map(row)}</div>
            ) : (
              <PanelEmpty>You&apos;re in every team there is.</PanelEmpty>
            )}
          </Panel>
        </div>
      )}

      {creating && (
        <NewTeamDialog
          onClose={() => setCreating(false)}
          onCreated={(team) => {
            setCreating(false);
            void reload();
            router.push(`/teams/${team.id}`);
          }}
        />
      )}
    </div>
  );
}

function StandingChip({ standing }: { standing: Standing }) {
  if (standing === "none") return null;
  return (
    <span
      className={cn(
        "shrink-0 px-1.5 py-0.5 text-[10px] rounded font-medium",
        standing === "admin"
          ? "bg-primary/10 text-primary"
          : standing === "member"
            ? "bg-success/10 text-success"
            : standing === "requested"
              ? "bg-warning/10 text-warning"
              : "bg-bg-hover text-text-muted",
      )}
    >
      {STANDING_LABEL[standing]}
    </span>
  );
}
