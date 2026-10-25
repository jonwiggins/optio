"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, ListChecks } from "lucide-react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useDeploymentSwitches } from "@/hooks/use-deployment-switches";
import { useGettingStartedStore } from "@/components/dashboard/getting-started-store";

const ITEM =
  "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-sm text-text transition-colors hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-primary";

/**
 * The account menu's Help: the guide for the people who use Optio (/help,
 * docs/using-optio.md) and, for a signed-in person, the Overview's
 * getting-started checklist again after they hid it. Only while a deployment
 * admin has the getting-started guide on (Settings → Access); nothing
 * otherwise.
 */
export function HelpMenu({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const { userId } = useCurrentUser();
  const { onboarding } = useDeploymentSwitches();
  const show = useGettingStartedStore((s) => s.show);
  if (!onboarding) return null;
  return (
    <nav aria-label="Help" className="space-y-1 p-2">
      <p className="px-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
        Help
      </p>
      <Link href="/help" onClick={onNavigate} className={ITEM}>
        <BookOpen className="h-3.5 w-3.5 text-text-muted" />
        Using Optio
      </Link>
      {userId && (
        <button
          type="button"
          className={ITEM}
          onClick={() => {
            show(userId);
            onNavigate?.();
            router.push("/");
          }}
        >
          <ListChecks className="h-3.5 w-3.5 text-text-muted" />
          Getting-started checklist
        </button>
      )}
    </nav>
  );
}
