import type { Metadata } from "next";
import Link from "next/link";
import { WorkComposer } from "@/components/platform/work-composer";
import { ANSWERS } from "@/components/platform/answers";
import "./platform.css";

const title = "One model for all your agent work";
const description =
  "From a quick terminal session to a recurring automation: choose When, Where, Who, What, and Then. Explore Optio’s unified Work UI, execution options, and team controls.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/platform/" },
  openGraph: { title: `${title} | Optio`, description, url: "/platform/" },
  twitter: { title: `${title} | Optio`, description },
};

function Screenshot({
  name,
  alt,
  caption,
  eager = false,
}: {
  name: string;
  alt: string;
  caption: string;
  eager?: boolean;
}) {
  return (
    <figure className="platform-shot">
      <a
        href={`/screenshots/showcase/${name}.webp`}
        target="_blank"
        rel="noreferrer"
        aria-label={`View full size: ${alt}`}
      >
        <img
          src={`/screenshots/showcase/${name}.webp`}
          alt={alt}
          width={1440}
          height={1000}
          loading={eager ? "eager" : "lazy"}
          fetchPriority={eager ? "high" : "auto"}
        />
        <span className="image-hint">View full size ↗</span>
      </a>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

export default function PlatformPage() {
  return (
    <article className="platform-page">
      <header className="platform-hero landing-container">
        <p className="eyebrow">
          <span className="status-light" /> The Optio approach
        </p>
        <div className="platform-intro">
          <h1>
            Different kinds of work.
            <br />
            <span>One way to run them.</span>
          </h1>
          <div>
            <p>
              A coding task. A scheduled report. A terminal on your laptop. An agent your team can
              message. In Optio, they all start in the same place: <strong>Work.</strong>
            </p>
            <div className="landing-actions">
              <Link href="/docs/getting-started" className="landing-button primary">
                Get started <span aria-hidden="true">↗</span>
              </Link>
              <a href="#work-model" className="landing-button secondary">
                See how it works <span aria-hidden="true">↓</span>
              </a>
            </div>
          </div>
        </div>
        <Screenshot
          name="web-work"
          eager
          alt="The current Work page, with attention counts and Active, Recurring, Agents, History, and All views"
          caption="One Work list. See what needs you, what is running, and what is ready for your next step."
        />
        <p className="sample-note">
          Real Optio screens with fictional example data. Activity and usage shown are simulated.
        </p>
        <nav className="platform-contents" aria-label="On this page">
          <a href="#work-model">01 · Define the work</a>
          <a href="#execution">02 · Choose where it runs</a>
          <a href="#follow-through">03 · Follow it through</a>
          <a href="#control">04 · Keep control</a>
        </nav>
      </header>

      <section id="work-model" className="landing-section">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">01 / Define the work</p>
              <h2>
                Five answers.
                <br />A workflow that fits.
              </h2>
            </div>
            <p>
              The same form creates a one-off run, a recurring workflow, an interactive session, or
              a persistent agent. Choose the behavior you need.
            </p>
          </div>
          <ol className="platform-attributes">
            {ANSWERS.map((answer, index) => (
              <li key={answer.key}>
                <span className="attribute-number">0{index + 1}</span>
                <h3 style={{ color: answer.color }}>{answer.name}</h3>
                <p>{answer.text}</p>
              </li>
            ))}
          </ol>
          <div className="platform-example-heading">
            <h3>See the same five answers in action.</h3>
            <p>Choose an example to see what runs and what happens next.</p>
          </div>
          <WorkComposer />
          <div className="platform-editor">
            <div className="platform-copy">
              <p className="eyebrow">The form is the model</p>
              <h3>
                Create it once.
                <br />
                Refine it in the same place.
              </h3>
              <p>
                The Work editor summarizes your choices in plain language before you save. Recurring
                work uses that same editor when its schedule, prompt, runtime, or environment needs
                to change.
              </p>
              <p>
                Environment lives under <strong>Where</strong>: start with your repo and workspace
                defaults, then choose connections, MCP servers, skills, secrets, and setup commands
                for this work.
              </p>
              <Link href="/docs/sessions">
                Explore the Work model <span aria-hidden="true">↗</span>
              </Link>
            </div>
            <Screenshot
              name="web-new-work"
              alt="Edit work showing When, Where, Organization and Private ownership, and a plain-language summary"
              caption="The current editor: five attributes, one readable summary."
            />
          </div>
        </div>
      </section>

      <section id="execution" className="landing-section platform-tinted">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">02 / Choose where it runs</p>
              <h2>
                Your infrastructure.
                <br />
                Your way of working.
              </h2>
            </div>
            <p>
              Run agents in your Kubernetes cluster or connect a machine with Optio Local. Choose a
              runtime for the work, with a shell available when no agent is needed.
            </p>
          </div>
          <div className="platform-locations">
            <article>
              <span className="location-tag">OPTIO POD</span>
              <h3>Give the work a workspace.</h3>
              <p>
                Repo tasks use separate git worktrees in pooled pods. Work without a repo can run
                reports, use connected services, or execute commands. Persistent agents have a pod
                and can work with a repo, too.
              </p>
              <Link href="/docs/architecture">How execution works ↗</Link>
            </article>
            <article>
              <span className="location-tag">YOUR MACHINE</span>
              <h3>Use the setup you already have.</h3>
              <p>
                Pair a machine, choose an allowed directory, and use its installed agent CLI,
                configuration, and login. Start interactively or attach a trigger to a local
                automation.
              </p>
              <Link href="/docs/sessions">Explore local work ↗</Link>
            </article>
          </div>
          <p className="platform-footnote">
            Available choices follow the workflow: persistent agents live in pods; following a PR
            requires an agent and a repository.
          </p>
          <Screenshot
            name="web-sessions"
            alt="Optio sessions with a Claude Code conversation and terminal arranged side by side"
            caption="Stay hands-on: keep the conversation and terminal together, with sessions arranged side by side."
          />
        </div>
      </section>

      <section id="follow-through" className="landing-section">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">03 / Follow it through</p>
              <h2>
                Starting is only
                <br />
                part of the workflow.
              </h2>
            </div>
            <p>
              Keep the conversation, run history, and next decision connected. Open Work for the
              full picture, Reviews for code review, and Inbox for requests that need attention.
            </p>
          </div>
          <div className="platform-outcomes">
            <article>
              <span>01</span>
              <h3>From ticket to PR</h3>
              <p>
                Follow CI checks, review feedback, and merge status. Enable automatic code review
                and resuming where appropriate, with limits set by the repo and the work.
              </p>
            </article>
            <article>
              <span>02</span>
              <h3>From trigger to history</h3>
              <p>
                Each recurring run keeps its own outcome and logs. See what happened last time
                before changing the workflow or starting it again.
              </p>
            </article>
            <article>
              <span>03</span>
              <h3>From message to next turn</h3>
              <p>
                Persistent agents wait between turns and wake on messages or configured triggers.
                Give specialists their own instructions and let them coordinate through the
                inter-agent API.
              </p>
            </article>
          </div>
          <div className="platform-mobile">
            <div className="platform-copy">
              <p className="eyebrow">Web · iOS · Android · CLI</p>
              <h3>
                Step away.
                <br />
                Stay in the loop.
              </h3>
              <p>
                Native iOS and Android apps let you check work, return to a session, and respond
                when an agent needs you. Widgets and live status surfaces keep progress visible
                between check-ins.
              </p>
              <Link href="/#mobile">Explore the mobile apps ↗</Link>
            </div>
            <div className="platform-phones">
              <figure>
                <a href="/screenshots/showcase/ios-session.webp" target="_blank" rel="noreferrer">
                  <img
                    src="/screenshots/showcase/ios-session.webp"
                    alt="Native iOS app showing a live agent conversation"
                    width={1170}
                    height={2532}
                    loading="lazy"
                  />
                </a>
                <figcaption>iOS · Pick up the conversation</figcaption>
              </figure>
              <figure>
                <a href="/screenshots/showcase/android-work.webp" target="_blank" rel="noreferrer">
                  <img
                    src="/screenshots/showcase/android-work.webp"
                    alt="Native Android app showing the unified Work list"
                    width={1080}
                    height={2424}
                    loading="lazy"
                  />
                </a>
                <figcaption>Android · Check on the work</figcaption>
              </figure>
            </div>
          </div>
        </div>
      </section>

      <section id="control" className="landing-section platform-tinted">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">04 / Keep control</p>
              <h2>
                Shared work.
                <br />
                Explicit boundaries.
              </h2>
            </div>
            <p>
              Optio is self-hosted and open source. Your team chooses who owns the work, which
              resources it uses, and how much it can do on its own.
            </p>
          </div>
          <div className="platform-controls">
            <article>
              <h3>Organization or Private</h3>
              <p>
                Organization work uses shared resources. Private work is hidden from other members;
                its owner changes and runs it. Workspace admins can inspect it read-only and delete
                it for administration.
              </p>
            </article>
            <article>
              <h3>The right tools for each run</h3>
              <p>
                Connections bring service credentials, tools, shell environment, and instructions
                together. Add or remove access for pod work instead of giving every agent the same
                environment.
              </p>
            </article>
            <article>
              <h3>Review rules that hold</h3>
              <p>
                Work can request extra review, draft PRs, or fewer automatic resumes. Per-work
                settings can tighten a repository’s PR policies; they cannot loosen them. Viewers
                stay read-only for work controls.
              </p>
            </article>
            <article>
              <h3>Repeatable configuration</h3>
              <p>
                Keep supported work definitions and resources in YAML. Apply and export them with
                the CLI, or sync a mounted configuration directory to keep managed resources
                aligned.
              </p>
            </article>
          </div>
          <div className="foundation-links">
            <Link href="/docs/guides/connections">Connections ↗</Link>
            <Link href="/docs/configuration">Configuration ↗</Link>
            <Link href="/docs/deployment">Deployment ↗</Link>
            <a href="https://github.com/jonwiggins/optio">Source on GitHub ↗</a>
          </div>
        </div>
      </section>
      <section className="landing-section platform-cta">
        <div className="landing-container">
          <p className="eyebrow">Start with one piece of work</p>
          <h2>
            Choose the work.
            <br />
            Make room for what’s next.
          </h2>
          <p>
            Connect a repo or pair a machine, choose your agent, and give it something useful to do.
          </p>
          <div className="landing-actions">
            <Link href="/docs/getting-started" className="landing-button primary">
              Get started ↗
            </Link>
            <Link href="/docs" className="landing-button secondary">
              Read the docs ↗
            </Link>
          </div>
        </div>
      </section>
    </article>
  );
}
