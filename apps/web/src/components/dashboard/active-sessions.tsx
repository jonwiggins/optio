import Link from "next/link";
import { Terminal, FolderGit2, CircleDot } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";

export function ActiveSessions({
  sessions,
  activeCount,
}: {
  sessions: any[];
  activeCount: number;
}) {
  if (sessions.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-text-heading flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          Active Sessions
          <span className="text-xs font-normal text-primary bg-primary/10 px-1.5 py-0.5 rounded-md">
            {activeCount}
          </span>
        </h2>
        <Link href="/sessions" className="text-xs text-primary hover:underline">
          All sessions &rarr;
        </Link>
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
        {sessions.map((session: any) => {
          const repoName = session.repoUrl
            ? session.repoUrl.replace("https://github.com/", "")
            : "Unknown";
          return (
            <Link
              key={session.id}
              href={`/sessions/${session.id}`}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg-card hover:border-primary/30 hover:bg-bg-hover transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Terminal className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium truncate">
                    {session.branch ?? `Session ${session.id.slice(0, 8)}`}
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
                </div>
                <div className="flex items-center gap-2 text-[10px] text-text-muted mt-0.5">
                  <span className="flex items-center gap-0.5">
                    <FolderGit2 className="w-2.5 h-2.5" />
                    {repoName}
                  </span>
                  <span>{formatRelativeTime(session.createdAt)}</span>
                </div>
              </div>
              <CircleDot className="w-3.5 h-3.5 text-primary shrink-0" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
