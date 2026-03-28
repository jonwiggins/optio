import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  CheckCircle,
  Zap,
  FolderGit2,
  ListTodo,
  ArrowRight,
  Rocket,
  KeyRound,
  GitBranch,
  Bot,
  Container,
} from "lucide-react";

function QuickLink({
  icon: Icon,
  label,
  description,
  href,
}: {
  icon: any;
  label: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group p-4 rounded-xl border border-border/50 bg-bg-card hover:border-primary/30 hover:bg-bg-card-hover transition-all card-hover"
    >
      <Icon className="w-5 h-5 text-text-muted group-hover:text-primary transition-colors mb-2" />
      <div className="text-sm font-medium text-text-heading">{label}</div>
      <div className="text-xs text-text-muted mt-0.5">{description}</div>
    </Link>
  );
}

export function WelcomeHero({ repoCount }: { repoCount: number }) {
  const hasRepos = repoCount > 0;

  const steps = [
    {
      num: 1,
      icon: KeyRound,
      title: "Configure secrets",
      description: "Add your Anthropic API key or connect Claude Max credentials.",
      href: "/secrets",
      done: false,
    },
    {
      num: 2,
      icon: FolderGit2,
      title: "Add a repository",
      description: "Connect a GitHub repo so Optio can clone it and run agents.",
      href: "/repos/new",
      done: hasRepos,
    },
    {
      num: 3,
      icon: Rocket,
      title: "Create your first task",
      description: "Describe what you want built. Optio spins up an agent and opens a PR.",
      href: "/tasks/new",
      done: false,
    },
  ];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-bg-card via-bg-card to-primary/[0.04] px-8 py-12 mb-8">
        <div className="absolute top-0 right-0 w-72 h-72 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-primary/3 rounded-full blur-3xl translate-y-1/2 -translate-x-1/4" />

        <div className="relative">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-xl bg-primary/10 border border-primary/20">
              <Zap className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Welcome to Optio</h1>
          </div>
          <p className="text-text-muted text-lg max-w-xl leading-relaxed mb-2">
            CI/CD where the build step is an AI agent. Submit tasks from the dashboard or GitHub
            Issues, and Optio handles the rest &mdash; isolated pods, code generation, and pull
            requests.
          </p>

          <div className="flex items-center gap-4 mt-6 text-sm text-text-muted">
            <span className="flex items-center gap-1.5">
              <Bot className="w-4 h-4 text-primary" />
              AI-powered coding
            </span>
            <span className="flex items-center gap-1.5">
              <GitBranch className="w-4 h-4 text-primary" />
              Auto PR creation
            </span>
            <span className="flex items-center gap-1.5">
              <Container className="w-4 h-4 text-primary" />
              Isolated K8s pods
            </span>
          </div>
        </div>
      </div>

      <div className="mb-8">
        <h2 className="text-sm font-medium text-text-heading uppercase tracking-wider mb-4">
          Get started
        </h2>
        <div className="grid gap-3">
          {steps.map((step) => (
            <Link
              key={step.num}
              href={step.href}
              className={cn(
                "group flex items-center gap-4 p-4 rounded-xl border transition-all",
                step.done
                  ? "border-success/20 bg-success/[0.03]"
                  : "border-border/50 bg-bg-card hover:border-primary/30 hover:bg-bg-card-hover",
              )}
            >
              <div
                className={cn(
                  "flex items-center justify-center w-10 h-10 rounded-lg shrink-0",
                  step.done
                    ? "bg-success/10 text-success"
                    : "bg-bg-hover text-text-muted group-hover:bg-primary/10 group-hover:text-primary",
                )}
              >
                {step.done ? (
                  <CheckCircle className="w-5 h-5" />
                ) : (
                  <step.icon className="w-5 h-5" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-sm font-medium",
                      step.done ? "text-success" : "text-text-heading",
                    )}
                  >
                    {step.title}
                  </span>
                  {step.done && (
                    <span className="text-[10px] font-medium text-success bg-success/10 px-1.5 py-0.5 rounded">
                      Done
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-0.5">{step.description}</p>
              </div>
              <ArrowRight
                className={cn(
                  "w-4 h-4 shrink-0 transition-transform",
                  step.done
                    ? "text-success/40"
                    : "text-text-muted/30 group-hover:text-primary group-hover:translate-x-0.5",
                )}
              />
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <QuickLink icon={ListTodo} label="Tasks" description="View all tasks" href="/tasks" />
        <QuickLink
          icon={FolderGit2}
          label="Repos"
          description="Manage repositories"
          href="/repos"
        />
        <QuickLink
          icon={Container}
          label="Cluster"
          description="K8s pods & nodes"
          href="/cluster"
        />
        <QuickLink
          icon={KeyRound}
          label="Secrets"
          description="API keys & tokens"
          href="/secrets"
        />
      </div>
    </div>
  );
}
