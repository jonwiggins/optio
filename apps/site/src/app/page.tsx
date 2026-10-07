import Link from "next/link";
import { ProductTour } from "@/components/product-tour";

const github = "https://github.com/jonwiggins/optio";
const useCases = [
  {
    n: "01",
    title: "Turn an issue into a pull request",
    trigger: "Ticket · GitHub · Linear",
    body: "Hand off a bounded change. Optio runs the agent in a worktree, tracks CI and review, and can resume it with feedback before a configured merge.",
    link: "/docs/guides/creating-tasks",
    action: "Build a PR workflow",
  },
  {
    n: "02",
    title: "Put routine work on a schedule",
    trigger: "Schedule · Manual",
    body: "Keep dependencies current, prepare a morning briefing, or run a shell command. Save the instructions once and keep a history of each run.",
    link: "/docs/guides/scheduled-tasks",
    action: "Schedule recurring work",
  },
  {
    n: "03",
    title: "Give events a useful next step",
    trigger: "Webhook · Slack · PagerDuty · Pylon",
    body: "Investigate a failed deployment, research a support escalation, or draft an answer for a teammate. Event payloads become parameters in your prompt.",
    link: "/docs/guides/integrations",
    action: "Connect a trigger",
  },
  {
    n: "04",
    title: "Work in the checkout you already have",
    trigger: "Your machine · Your CLI login",
    body: "Pair a machine with Optio Local. Run an agent or shell in an allowed directory, then return to the same session from your browser or phone.",
    link: "/docs/sessions",
    action: "Explore local sessions",
  },
  {
    n: "05",
    title: "Let specialists work together",
    trigger: "Messages · Persistent agents",
    body: "Give a coordinator, researcher, and reviewer their own instructions. Agents can message one another and wake on demand instead of starting from scratch each time.",
    link: `${github}/tree/main/examples/persistent-agents`,
    action: "Explore agent teams",
  },
  {
    n: "06",
    title: "Bring someone into the session",
    trigger: "Organization · Shared control",
    body: "Create an expiring, revocable link for a teammate to view and control a session. Organization sign-in is required; sharing grants access to the session’s environment.",
    link: `${github}/blob/main/docs/production-eks.md#collaboration-links`,
    action: "Read about collaboration",
  },
];
const runtimes = [
  "Claude Code",
  "OpenAI Codex",
  "GitHub Copilot",
  "Google Gemini",
  "Cursor",
  "OpenCode",
  "OpenClaw",
];
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Optio",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web, iOS, Android; Kubernetes server",
  description:
    "Self-hosted orchestration for coding agents, automated workflows, and interactive sessions on Kubernetes or your own machines.",
  url: "https://optio.host",
  license: "https://opensource.org/licenses/MIT",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

function Screenshot({
  file,
  alt,
  width = 1440,
  height = 1000,
  eager = false,
}: {
  file: string;
  alt: string;
  width?: number;
  height?: number;
  eager?: boolean;
}) {
  return (
    <img
      src={`/screenshots/showcase/${file}.webp`}
      alt={alt}
      width={width}
      height={height}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : "auto"}
    />
  );
}

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <section className="landing-hero">
        <div className="landing-container">
          <div className="hero-intro">
            <div>
              <p className="eyebrow">
                <span className="status-light" /> Self-hosted. Open source. Yours.
              </p>
              <h1>
                All your agent work.
                <br />
                <span>One place to run it.</span>
              </h1>
              <p className="hero-description">
                Ship a change. Automate the routine. Pick up a session from your phone. Optio brings
                your agents together on your Kubernetes cluster and your own machines.
              </p>
              <div className="landing-actions">
                <Link href="/docs/getting-started" className="landing-button primary">
                  Get started <span aria-hidden="true">↗</span>
                </Link>
                <a href="#product" className="landing-button secondary">
                  Take a look <span aria-hidden="true">↓</span>
                </a>
              </div>
            </div>
            <div className="hero-aside">
              <span className="font-mono">A WORKSPACE FOR YOUR AGENTS</span>
              <p>
                Your models.
                <br />
                Your infrastructure.
                <br />
                Your way of working.
              </p>
              <a href={github}>
                Explore the source <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
          <figure className="hero-shot">
            <div className="shot-bar">
              <span>
                <span className="status-light" /> optio / overview
              </span>
              <span>Web · iOS · Android</span>
            </div>
            <a
              href="/screenshots/showcase/web-overview.webp"
              target="_blank"
              rel="noreferrer"
              aria-label="Open the Overview screenshot at full size"
            >
              <Screenshot
                file="web-overview"
                alt="Optio Overview with a needs-you queue, Codex usage limits, active sessions, and persistent agents"
                eager
              />
            </a>
            <figcaption>
              Your whole workspace at a glance. Know what is working and what needs you.{" "}
              <span>Example data</span>
            </figcaption>
          </figure>
          <div className="runtime-strip">
            <p>Pick the agent for the job</p>
            <div>
              {runtimes.map((runtime) => (
                <span key={runtime}>{runtime}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="possibilities" className="landing-section">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">From a quick task to a daily workflow</p>
              <h2>
                What will you put
                <br />
                your agents to work on?
              </h2>
            </div>
            <p>
              Code changes are a starting point. The same prompts, triggers, and connections support
              the work around them, too.
            </p>
          </div>
          <div className="use-case-grid">
            {useCases.map((item) => (
              <article key={item.n} className="use-case">
                <span className="case-number font-mono">{item.n}</span>
                <p className="case-trigger">{item.trigger}</p>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <Link href={item.link}>
                  {item.action} <span aria-hidden="true">↗</span>
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="product" className="landing-section product-section">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Meet your workspace</p>
              <h2>
                One Work feed.
                <br />
                Room for all of it.
              </h2>
            </div>
            <p>
              Move from the big picture to the conversation, the terminal, or the next run. The same
              work stays connected throughout.
            </p>
          </div>
          <ProductTour />
        </div>
      </section>

      <section id="mobile" className="landing-section mobile-section">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">A real app in your pocket</p>
              <h2>
                Step away from your desk.
                <br />
                Stay with your work.
              </h2>
            </div>
            <p>
              Native SwiftUI on iOS. Native Jetpack Compose on Android. Check the queue, read an
              agent’s conversation, open a terminal, or start something new.
            </p>
          </div>
          <div className="mobile-showcase">
            <figure>
              <div className="phone-frame">
                <Screenshot
                  file="ios-work"
                  alt="Native iOS Work screen with active Claude Code and Codex sessions"
                  width={1170}
                  height={2532}
                />
              </div>
              <figcaption>
                <strong>iOS · Your work, together</strong>
                <span>Find the session that needs you.</span>
              </figcaption>
            </figure>
            <figure>
              <div className="phone-frame">
                <Screenshot
                  file="ios-session"
                  alt="Native iOS session conversation with a reply composer"
                  width={1170}
                  height={2532}
                />
              </div>
              <figcaption>
                <strong>iOS · Pick up the conversation</strong>
                <span>Read, reply, or switch to the terminal.</span>
              </figcaption>
            </figure>
            <figure>
              <div className="phone-frame android">
                <Screenshot
                  file="android-work"
                  alt="Native Android Work screen with agents and local sessions"
                  width={1080}
                  height={2424}
                />
              </div>
              <figcaption>
                <strong>Android · Made for your phone</strong>
                <span>The same workspace, native controls.</span>
              </figcaption>
            </figure>
          </div>
          <div className="mobile-links">
            <a href={`${github}/tree/main/apps/ios`}>Build the iOS app ↗</a>
            <a href={`${github}/tree/main/apps/android`}>Build the Android app ↗</a>
            <a href="#gallery">More app screenshots ↓</a>
          </div>
          <div className="glance-grid">
            <div>
              <p className="eyebrow">Less checking. More context.</p>
              <h3>See when you’re needed.</h3>
              <p>
                iOS widgets, Live Activities, Dynamic Island, and the Apple Watch Smart Stack put
                status and contextual actions within reach. Android adds home-screen widgets and an
                ongoing watch notification.
              </p>
              <p className="sample-note">
                Apple surfaces shown here are native component captures with sample states. Watch
                support mirrors the iPhone Live Activity.
              </p>
            </div>
            <figure>
              <Screenshot
                file="ios-glances"
                alt="Native iOS widget, Live Activity, and Watch Smart Stack components showing example work that needs attention"
                width={1616}
                height={994}
              />
              <figcaption>Widgets · Live Activities · Watch Smart Stack</figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section className="landing-section foundation-section">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Run it on your terms</p>
              <h2>
                Your infrastructure.
                <br />A shared control plane.
              </h2>
            </div>
            <p>
              Connect your repositories, identity provider, tools, and machines. Choose which
              credentials each piece of work receives.
            </p>
          </div>
          <div className="foundation-grid">
            <article>
              <h3>Pods and personal machines</h3>
              <p>
                Use Kubernetes for managed execution or pair a machine with Optio Local. Repository
                work uses worktrees; local work uses the machine’s own CLI configuration.
              </p>
            </article>
            <article>
              <h3>Tools with a place to belong</h3>
              <p>
                Connections combine credentials, MCP tools, shell environment, and usage notes.
                Assign access by repo and runtime, with per-work overrides.
              </p>
            </article>
            <article>
              <h3>Recovery you can see</h3>
              <p>
                Sessions expose reconnecting, resumable, and lost states. Recoverable work is
                preserved, and uncertain outcomes require a decision before retrying side effects.
              </p>
            </article>
            <article>
              <h3>Ready for managed infrastructure</h3>
              <p>
                Use Helm with managed PostgreSQL and Redis, existing Kubernetes Secrets, OAuth or
                OIDC, and separate worker identities. The combined API/web deployment currently
                requires one replica.
              </p>
            </article>
          </div>
          <div className="foundation-links">
            <Link href="/docs/deployment">Deployment guide ↗</Link>
            <Link href="/docs/guides/connections">Connections guide ↗</Link>
            <a href={`${github}/blob/main/docs/security-review-2026-10.md`}>Security model ↗</a>
          </div>
        </div>
      </section>

      <section id="gallery" className="landing-section">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">A closer look</p>
              <h2>More ways to work.</h2>
            </div>
            <p>
              Open any capture at full size. These are the real web and native apps, using fictional
              demonstration data.
            </p>
          </div>
          <div className="capture-gallery">
            {[
              {
                file: "web-trigger",
                label: "A PagerDuty incident workflow",
                alt: "PagerDuty-triggered job with its prompt and run history",
                mobile: false,
              },
              {
                file: "web-task",
                label: "A completed repo task",
                alt: "Task detail showing the prompt, result, and example log output",
                mobile: false,
              },
              {
                file: "ios-recurring",
                label: "Recurring work on iOS",
                alt: "iOS list of recurring workflows and their trigger icons",
                mobile: true,
              },
              {
                file: "android-session",
                label: "A session on Android",
                alt: "Android agent conversation and terminal controls",
                mobile: true,
              },
              {
                file: "ios-new-work",
                label: "Create work on iOS",
                alt: "iOS work form with trigger and location choices",
                mobile: true,
              },
              {
                file: "android-new-work",
                label: "Create work on Android",
                alt: "Android work form with schedule and location settings",
                mobile: true,
              },
            ].map((item) => (
              <a
                key={item.file}
                href={`/screenshots/showcase/${item.file}.webp`}
                target="_blank"
                rel="noreferrer"
                className={item.mobile ? "capture portrait" : "capture"}
              >
                <div>
                  <Screenshot
                    file={item.file}
                    alt={item.alt}
                    width={item.file.startsWith("ios-") ? 1170 : item.mobile ? 1080 : 1440}
                    height={item.file.startsWith("ios-") ? 2532 : item.mobile ? 2424 : 1000}
                  />
                </div>
                <span>
                  {item.label} <span aria-hidden="true">↗</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section id="start" className="landing-section start-section">
        <div className="landing-container start-layout">
          <div>
            <p className="eyebrow">Start with one piece of work</p>
            <h2>
              Make room for
              <br />
              your next idea.
            </h2>
            <p>
              Bring your Kubernetes cluster and an agent login. Start locally with Docker Desktop,
              or use the Helm guide for a managed deployment.
            </p>
            <div className="landing-actions">
              <Link href="/docs/getting-started" className="landing-button primary">
                Deploy Optio ↗
              </Link>
              <a href={github} className="landing-button secondary">
                View on GitHub ↗
              </a>
            </div>
            <p className="sample-note">
              MIT licensed. Agent providers and infrastructure may have their own costs.
            </p>
          </div>
          <div className="install-snippet">
            <span className="font-mono">LOCAL QUICK START</span>
            <pre>
              <code>{`git clone https://github.com/jonwiggins/optio.git\ncd optio\n./scripts/setup-local.sh`}</code>
            </pre>
            <p>Requires Docker Desktop with Kubernetes enabled.</p>
            <Link href="/docs/installation">Installation requirements and options ↗</Link>
          </div>
        </div>
      </section>
    </>
  );
}
