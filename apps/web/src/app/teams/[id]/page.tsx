"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { TEAM_JOIN_POLICY_LABEL, type TeamDetail } from "@optio/shared";
import { api } from "@/lib/api-client";
import { usePageTitle } from "@/hooks/use-page-title";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useMyTeamsStore } from "@/hooks/use-my-teams";
import { DetailHeader } from "@/components/detail-header";
import { EmptyState } from "@/components/empty-state";
import { IfCanMutate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { AddMemberForm, MembersSection, RequestsSection } from "@/components/teams/team-members";
import { GroupMappingsEditor } from "@/components/teams/group-mappings-editor";
import { TeamSettings } from "@/components/teams/team-settings";
import { TeamTokens } from "@/components/teams/team-tokens";
import { TeamGatewayBudgetCard } from "@/components/teams/team-gateway-key";
import { TeamAgentPolicy } from "@/components/teams/team-agent-policy";
import { TeamChatChannel } from "@/components/teams/team-chat-channel";
import {
  JOIN_POLICY_SHORT,
  STANDING_LABEL,
  joinAction,
  standingOf,
} from "@/components/teams/standing";

/**
 * One team: its members, and — for its admins and workspace admins — the
 * requests waiting, adding people by email, the SSO group mappings that
 * fill it at sign-in, and its settings. Everyone else sees the members and
 * the Join / Leave button.
 */
export default function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { userId } = useCurrentUser();
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  usePageTitle(team ? team.name : "Team");

  const load = useCallback(async () => {
    try {
      const res = await api.getTeam(id);
      setTeam(res.team);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the team");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every change answers with the whole team; pickers elsewhere follow on the next load. */
  const changed = (next: TeamDetail) => {
    setTeam(next);
    void useMyTeamsStore.getState().reload();
  };

  const act = async () => {
    if (!team) return;
    const action = joinAction(team);
    if (action.kind === "none") return;
    setBusy(true);
    try {
      if (action.kind === "join" || action.kind === "request") {
        const { team: next } = await api.joinTeam(team.id);
        toast.success(
          next.myStatus === "active" ? `You joined ${team.name}` : `Asked to join ${team.name}`,
        );
        changed(next);
      } else {
        await api.leaveTeam(team.id);
        toast.success(action.kind === "leave" ? `You left ${team.name}` : "Request withdrawn");
        await load();
        void useMyTeamsStore.getState().reload();
      }
    } catch (err) {
      toast.error(`Couldn't ${action.label.toLowerCase()}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="page-column py-6">
        <EmptyState
          icon={Users}
          title="Team not found"
          description={error}
          action={
            <Link href="/teams" className="text-sm text-primary hover:underline">
              Back to Teams
            </Link>
          }
        />
      </div>
    );
  }

  if (!team) {
    return (
      <div className="page-column py-16 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-text-muted" />
      </div>
    );
  }

  const standing = standingOf(team);
  const action = joinAction(team);
  const members = team.members.filter((m) => m.status === "active").length;

  return (
    <>
      <DetailHeader
        subtitle={
          <Link href="/teams" className="inline-flex items-center gap-1 hover:text-text">
            <ArrowLeft className="w-3 h-3" />
            Teams
          </Link>
        }
        title={team.name}
        metaItems={[
          <span key="members">{`${members} member${members === 1 ? "" : "s"}`}</span>,
          <span key="policy" title={TEAM_JOIN_POLICY_LABEL[team.joinPolicy]}>
            {JOIN_POLICY_SHORT[team.joinPolicy]}
          </span>,
          <span key="standing">
            {standing === "none" ? "You're not a member" : `You: ${STANDING_LABEL[standing]}`}
          </span>,
        ]}
        rightSlot={
          <IfCanMutate>
            {action.kind === "none" ? (
              <span className="text-xs text-text-muted">{action.reason}</span>
            ) : (
              <Button
                size="sm"
                variant={
                  action.kind === "join" || action.kind === "request" ? "primary" : "secondary"
                }
                disabled={busy}
                onClick={act}
              >
                {busy && <Loader2 className="animate-spin" />}
                {action.label}
              </Button>
            )}
          </IfCanMutate>
        }
      />
      <div className="page-column py-6 space-y-5">
        {team.description && (
          <p className="text-sm text-text-muted max-w-2xl">{team.description}</p>
        )}

        <RequestsSection team={team} onChanged={changed} />

        <div>
          <MembersSection team={team} viewerId={userId} onChanged={changed} />
          {team.canManage && (
            <Panel title="Add someone" className="mt-3">
              <AddMemberForm team={team} onChanged={changed} />
            </Panel>
          )}
        </div>

        {team.canManage && <TeamTokens team={team} />}
        {/* A member sees the team's gateway budget when Optio made its key. */}
        {!team.canManage && team.myStatus === "active" && (
          <TeamGatewayBudgetCard teamId={team.id} />
        )}

        {/* The deny rules the team's work adds (docs/agent-policy.md). */}
        {team.myStatus === "active" || team.canManage ? <TeamAgentPolicy teamId={team.id} /> : null}

        {/* The team's chat channel (docs/notifications.md). */}
        {team.canManage && <TeamChatChannel teamId={team.id} />}

        {team.canManage && (
          <GroupMappingsEditor key={team.updatedAt} team={team} onChanged={changed} />
        )}

        {team.canManage && (
          <TeamSettings
            key={`settings-${team.updatedAt}`}
            team={team}
            onChanged={changed}
            onDeleted={() => {
              void useMyTeamsStore.getState().reload();
              router.push("/teams");
            }}
          />
        )}
      </div>
    </>
  );
}
