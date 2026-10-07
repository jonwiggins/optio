import XCTest
@testable import Optio

/// Mirrors `apps/web/src/components/work-form/model.test.ts` case for case,
/// plus the sentence text for a few drafts and the submit-side helpers.
final class WorkFormModelTests: XCTestCase {
    private typealias F = WorkForm
    private let empty = F.Draft.empty

    private func local(_ d: F.Draft, dir: String = "/Users/dev/repos/app") -> F.Draft {
        var d = d
        d.location.runTarget = .local
        d.location.localHostId = "h1"
        d.location.localDir = dir
        return d
    }

    private func text(_ d: F.Draft, _ ctx: F.Context = F.Context()) -> String {
        F.sentenceText(F.describe(d, ctx))
    }

    private func enabled<T>(_ choices: [F.Choice<T>]) -> [T] { choices.filter(\.isEnabled).map(\.value) }

    private func with(_ d: F.Draft, _ change: (inout F.Draft) -> Void) -> F.Draft {
        var d = d
        change(&d)
        return d
    }

    // MARK: deriveKind — every kind is a point in the attribute space

    private var base: F.Draft { with(empty) { $0.prompt = "p" } }

    func testExitsPodRepo() {
        XCTAssertEqual(F.deriveKind(base), .repoTask)
        XCTAssertEqual(F.deriveKind(with(base) { $0.when = .schedule }), .repoBlueprint)
    }

    func testExitsNoRepoOrCurrentDirectory() {
        XCTAssertEqual(F.deriveKind(with(base) { $0.withRepo = false }), .standalone)
        XCTAssertEqual(F.deriveKind(with(base) { $0.withRepo = false; $0.when = .webhook }), .standalone)
        XCTAssertEqual(F.deriveKind(local(with(base) { $0.withRepo = false; $0.when = .schedule })), .standalone)
    }

    func testExitsMachineNewBranchOpensPR() {
        XCTAssertEqual(F.deriveKind(local(with(base) { $0.withRepo = true })), .repoTask)
    }

    func testEventTriggerIsAWhenLikeAnyOther() {
        // Pod + repo + GitHub event → a scheduled Task; no repo → a Job.
        XCTAssertEqual(F.deriveKind(with(base) { $0.when = .github }), .repoBlueprint)
        XCTAssertEqual(F.deriveKind(with(base) { $0.when = .slack; $0.withRepo = false }), .standalone)
        // Machine + branch + Linear event → a scheduled Task that runs in the checkout.
        XCTAssertEqual(F.deriveKind(local(with(base) { $0.when = .linear })), .repoBlueprint)
        // Only an interactive automation on a machine is a Local automation.
        XCTAssertEqual(F.deriveKind(local(with(base) { $0.when = .github; $0.then = .waitsForMe })), .localBlueprint)
    }

    func testWaitsForMe() {
        XCTAssertEqual(F.deriveKind(local(with(base) { $0.then = .waitsForMe })), .localTerminal)
        XCTAssertEqual(F.deriveKind(local(with(base) { $0.then = .waitsForMe; $0.when = .slack })), .localBlueprint)
        XCTAssertEqual(F.deriveKind(with(base) { $0.then = .waitsForMe }), .podSession)
    }

    func testPersistentAgent() {
        XCTAssertEqual(F.deriveKind(with(base) { $0.then = .waitsForMessages; $0.withRepo = false }), .persistentAgent)
    }

    // MARK: constraints flow downstream

    func testEveryTriggerWorksWithEveryWhere() {
        for when in F.WhenType.allCases {
            XCTAssertEqual(enabled(F.whereOptions(with(empty) { $0.when = when })), [.cluster, .local], "\(when)")
        }
        XCTAssertEqual(F.normalize(with(empty) { $0.when = .linear }).location.runTarget, .cluster)
    }

    func testMachineOffersTerminalAndOnlyDaemonCLIs() {
        let opts = F.runtimeOptions(local(with(empty) { $0.withRepo = false }))
        XCTAssertTrue(enabled(opts).contains(F.terminal))
        XCTAssertFalse(enabled(opts).contains("copilot"))
        XCTAssertEqual(F.normalize(local(with(empty) { $0.runtime = "copilot" })).runtime, "claude-code")
    }

    func testTerminalFitsWhereSomeExitConditionDoes() {
        // A pod with no repo: a command. A pod with a repo, by hand: a session.
        XCTAssertTrue(enabled(F.runtimeOptions(with(empty) { $0.withRepo = false })).contains(F.terminal))
        XCTAssertTrue(enabled(F.runtimeOptions(empty)).contains(F.terminal))
        // A repo pod on a trigger starts an agent: nothing a terminal could do there.
        XCTAssertFalse(enabled(F.runtimeOptions(with(empty) { $0.when = .schedule })).contains(F.terminal))
        XCTAssertTrue(enabled(F.runtimeOptions(with(empty) { $0.when = .schedule; $0.withRepo = false })).contains(F.terminal))
    }

    func testTerminalRunsACommandOrOpensAShell() {
        // In the directory as it is (or a pod with no checkout) a terminal can run and exit: a command.
        let d = F.normalize(local(with(empty) { $0.withRepo = false; $0.runtime = F.terminal }))
        XCTAssertEqual(enabled(F.thenOptions(d)), [.exits, .waitsForMe])
        XCTAssertTrue(F.isCommand(d))
        XCTAssertTrue(F.asksForPrompt(d))
        XCTAssertEqual(F.deriveKind(d), .standalone)
        XCTAssertTrue(F.isCommand(F.normalize(with(empty) { $0.withRepo = false; $0.runtime = F.terminal })))
        // On a new branch there is nothing for a command to do: it waits for you.
        let branch = F.normalize(local(with(empty) { $0.withRepo = true; $0.runtime = F.terminal }))
        XCTAssertEqual(enabled(F.thenOptions(branch)), [.waitsForMe])
        XCTAssertEqual(branch.then, .waitsForMe)
        XCTAssertEqual(branch.location.localSessionMode, .interactive)
        XCTAssertFalse(F.asksForPrompt(branch))
        // The Terminal example is a plain shell on your machine.
        let shell = F.normalize(F.preset("terminal")!.apply(empty))
        XCTAssertEqual(shell.runtime, F.terminal)
        XCTAssertEqual(shell.then, .waitsForMe)
        XCTAssertTrue(F.isLocal(shell))
        XCTAssertFalse(F.asksForPrompt(shell))
    }

    func testPodSessionChatsWithClaudeCode() {
        XCTAssertTrue(enabled(F.thenOptions(empty)).contains(.waitsForMe))
        XCTAssertTrue(enabled(F.thenOptions(with(empty) { $0.runtime = F.terminal })).contains(.waitsForMe))
        XCTAssertFalse(enabled(F.thenOptions(with(empty) { $0.runtime = "codex" })).contains(.waitsForMe))
        // On your machine any daemon CLI can wait for you.
        XCTAssertTrue(enabled(F.thenOptions(local(with(empty) { $0.runtime = "codex" }))).contains(.waitsForMe))
        XCTAssertFalse(F.asksForPrompt(with(empty) { $0.then = .waitsForMe }))
    }

    func testPersistentAgentLivesInAPodWithOrWithoutARepo() {
        XCTAssertFalse(enabled(F.thenOptions(local(empty))).contains(.waitsForMessages))
        XCTAssertTrue(enabled(F.thenOptions(empty)).contains(.waitsForMessages))
        XCTAssertTrue(enabled(F.thenOptions(with(empty) { $0.withRepo = false })).contains(.waitsForMessages))
        XCTAssertFalse(enabled(F.thenOptions(with(empty) { $0.runtime = F.terminal })).contains(.waitsForMessages))
        let flipped = F.normalize(local(with(empty) { $0.withRepo = false; $0.then = .waitsForMessages }))
        XCTAssertEqual(flipped.then, .exits)
        let withRepo = F.normalize(with(empty) { $0.then = .waitsForMessages; $0.repoUrl = "https://github.com/acme/app" })
        XCTAssertEqual(F.deriveKind(withRepo), .persistentAgent)
        XCTAssertEqual(text(withRepo, F.Context(repoName: "acme/app")), "Woken by messages, a Claude Code agent in an Optio pod with acme/app that keeps its memory between turns.")
    }

    func testSwitchingRuntimesClearsPreviousOptions() {
        let d = F.normalize(local(with(empty) { $0.runtime = "copilot"; $0.agentOptions = ["copilotModel": .string("x")] }))
        XCTAssertEqual(d.agentOptions, [:])
    }

    // MARK: the sentence

    func testLeadsWithTriggerForPRTask() {
        let d = with(empty) { $0.repoUrl = "https://github.com/acme/app" }
        XCTAssertEqual(text(d, F.Context(repoName: "acme/app")),
                       "Started now, a Claude Code run in an Optio pod with acme/app that opens a PR and exits when done.")
    }

    func testNamesMachineAndDirectoryForLocalTerminal() {
        let d = F.normalize(local(with(empty) { $0.then = .waitsForMe; $0.withRepo = false }, dir: "/Users/dev/notes"))
        XCTAssertEqual(text(d, F.Context(machineName: "M1")),
                       "Opened now, a Claude Code session on M1 in ~/notes that waits for you between turns.")
        let branch = F.normalize(local(with(empty) { $0.withRepo = true }))
        XCTAssertTrue(text(branch).contains("on a new branch in ~/repos/app that opens a PR"))
    }

    func testDescribesSchedulesAndMarksMissing() {
        let d = F.normalize(with(empty) {
            $0.withRepo = false
            $0.when = .schedule
            $0.trigger = F.TriggerConfig(type: .schedule, cronExpression: "0 9 * * 1-5")
        })
        XCTAssertEqual(text(d), "Running weekdays at 09:00 UTC, a Claude Code run in an Optio pod that exits when done.")
        XCTAssertEqual(F.missingFields(d), [.prompt])
        let bad = with(d) { $0.trigger = F.TriggerConfig(type: .schedule, cronExpression: "nope") }
        XCTAssertTrue(text(bad).contains("[on a schedule]"))
    }

    func testNoPromptDemandedForHandOpenedTerminal() {
        XCTAssertEqual(F.missingFields(F.normalize(local(with(empty) { $0.then = .waitsForMe; $0.withRepo = false }))), [])
        XCTAssertEqual(F.missingFields(F.normalize(with(empty) { $0.then = .waitsForMe; $0.repoUrl = "x" })), [])
    }

    func testMoreSentences() {
        let agent = F.normalize(with(empty) { $0.withRepo = false; $0.then = .waitsForMessages; $0.runtime = "codex" })
        XCTAssertEqual(text(agent), "Woken by messages, an OpenAI Codex agent in an Optio pod that keeps its memory between turns.")

        let hook = F.normalize(with(empty) { $0.withRepo = false; $0.when = .webhook; $0.trigger = F.TriggerConfig(type: .webhook, webhookPath: "hook-abc") })
        XCTAssertEqual(text(hook), "Started by a webhook at /api/hooks/hook-abc, a Claude Code run in an Optio pod that exits when done.")
        let noPath = with(hook) { $0.trigger.webhookPath = nil }
        XCTAssertEqual(text(noPath), "Started by [a webhook path], a Claude Code run in an Optio pod that exits when done.")
        XCTAssertEqual(F.missingFields(noPath), [.webhook, .prompt])

        let gh = F.normalize(with(empty) { $0.when = .github; $0.withRepo = false; $0.event.config["login"] = .string("jon") })
        XCTAssertEqual(text(gh), "Started by GitHub events, a Claude Code run in an Optio pod that exits when done.")
        XCTAssertEqual(F.missingFields(gh), [.prompt])
        // Review requests and mentions are about you: the trigger has to know who.
        let anon = F.normalize(with(empty) { $0.when = .github; $0.withRepo = false })
        XCTAssertEqual(text(anon), "Started by GitHub events [about you], a Claude Code run in an Optio pod that exits when done.")
        XCTAssertEqual(F.missingFields(anon), [.identity, .prompt])
        let ghLocal = F.normalize(with(empty) { $0.when = .github; $0.withRepo = false; $0.location.runTarget = .local; $0.event.config["login"] = .string("jon") })
        XCTAssertEqual(text(ghLocal), "Started by GitHub events, a Claude Code run [a machine] [a directory] that exits when done.")

        let shell = F.normalize(local(with(empty) { $0.withRepo = false; $0.runtime = F.terminal; $0.then = .waitsForMe }, dir: "/home/dev/x"))
        XCTAssertEqual(text(shell), "Opened now, a terminal on my machine in ~/x that waits for you between turns.")
        let command = F.normalize(local(with(empty) { $0.withRepo = false; $0.runtime = F.terminal; $0.prompt = "make" }, dir: "/home/dev/x"))
        XCTAssertEqual(text(command), "Started now, a command on my machine in ~/x that runs and exits.")
        XCTAssertEqual(F.missingFields(with(command) { $0.prompt = "" }), [.prompt])

        let missingRepo = with(empty) { $0.repoUrl = "" }
        XCTAssertEqual(text(missingRepo), "Started now, a Claude Code run in an Optio pod [a repo] that opens a PR and exits when done.")
        XCTAssertEqual(F.missingFields(missingRepo), [.repo, .prompt])
    }

    // MARK: presets and params

    func testPresetsLandOnPromisedKinds() {
        var by: [String: F.Draft] = [:]
        for p in F.presets { by[p.id] = F.normalize(p.apply(empty)) }
        XCTAssertEqual(F.presets.map(\.id), ["pr", "assign", "chat", "terminal", "schedule", "agent"])
        XCTAssertEqual(F.deriveKind(by["pr"]!), .repoTask)
        XCTAssertEqual(F.deriveKind(by["assign"]!), .repoBlueprint)
        XCTAssertEqual(F.deriveKind(local(by["chat"]!)), .localTerminal)
        XCTAssertEqual(F.deriveKind(local(by["terminal"]!)), .localTerminal)
        XCTAssertEqual(by["terminal"]!.runtime, F.terminal)
        XCTAssertEqual(F.deriveKind(by["schedule"]!), .standalone)
        XCTAssertEqual(F.deriveKind(by["agent"]!), .persistentAgent)
    }

    func testTicketStyleParamsForTicketAndLinear() {
        XCTAssertTrue(F.triggerParams(.ticket).contains("ticketUrl"))
        XCTAssertTrue(F.triggerParams(.linear).contains("ticketUrl"))
        XCTAssertTrue(F.triggerParams(.pagerduty).contains("ticketUrl"))
        XCTAssertTrue(F.triggerParams(.pagerduty).contains("incidentId"))
        XCTAssertTrue(F.triggerParams(.pylon).contains("issueId"))
        XCTAssertEqual(F.triggerParams(.schedule), [])
    }

    func testPagerDutyAndPylonEvents() {
        XCTAssertEqual(F.WhenType.pagerduty.label, "PagerDuty")
        XCTAssertEqual(F.WhenType.pylon.label, "Pylon")
        XCTAssertTrue(F.WhenType.pagerduty.isEvent)
        XCTAssertTrue(F.WhenType.pylon.isEvent)
        XCTAssertEqual(F.defaultEventConfig(.pagerduty), ["events": .array([.string("incident.triggered")])])
        XCTAssertEqual(F.defaultEventConfig(.pylon), ["events": .array([])])
        XCTAssertTrue(F.eventKinds(.pylon).isEmpty)
        XCTAssertFalse(F.eventKinds(.pagerduty).contains { $0.personal })
        XCTAssertTrue(F.eventKinds(.pagerduty).contains { $0.value == "incident.triggered" })
        XCTAssertTrue(text(F.normalize(with(empty) { $0.when = .pagerduty; $0.withRepo = false; $0.event = .default(.pagerduty); $0.prompt = "p" })).hasPrefix("Started by PagerDuty incidents,"))
        XCTAssertTrue(text(F.normalize(with(empty) { $0.when = .pylon; $0.withRepo = false; $0.event = .default(.pylon); $0.prompt = "p" })).hasPrefix("Started by Pylon events,"))
    }

    /// The fourteen When answers, in the picker's order (`TRIGGER_TYPES` in @optio/shared).
    func testWhenTypesMatchTheSharedOrder() {
        XCTAssertEqual(F.WhenType.allCases.map(\.rawValue), [
            "manual", "schedule", "webhook", "ticket", "github", "gitlab", "slack", "linear", "jira",
            "pylon", "pagerduty", "sentry", "alertmanager", "datadog",
        ])
        XCTAssertEqual(F.EventTriggerType.allCases.map(\.rawValue), [
            "github", "gitlab", "slack", "linear", "jira", "pylon", "pagerduty", "sentry", "alertmanager", "datadog",
        ])
        XCTAssertEqual(F.TicketSource.allCases.map(\.rawValue), ["github", "gitlab", "linear", "jira", "notion"])
        for w in F.WhenType.allCases where w.isEvent {
            XCTAssertNotNil(w.event, w.rawValue)
            XCTAssertNil(w.trigger, w.rawValue)
        }
        XCTAssertEqual(F.EventTriggerType.allCases.filter(\.selfSecret), [.pylon, .alertmanager, .datadog])
    }

    func testGitLabJiraSentryAlertmanagerDatadogEvents() {
        XCTAssertEqual(F.WhenType.gitlab.label, "GitLab")
        XCTAssertEqual(F.WhenType.jira.label, "Jira")
        XCTAssertEqual(F.WhenType.sentry.label, "Sentry")
        XCTAssertEqual(F.WhenType.alertmanager.label, "Alertmanager")
        XCTAssertEqual(F.WhenType.datadog.label, "Datadog")
        XCTAssertEqual(F.WhenType.gitlab.glyph, .brand(.gitlab))
        XCTAssertEqual(F.WhenType.jira.glyph, .brand(.jira))
        XCTAssertEqual(F.WhenType.sentry.glyph, .brand(.sentry))
        XCTAssertEqual(F.WhenType.alertmanager.glyph, .symbol("waveform.path.ecg"))
        XCTAssertEqual(F.WhenType.datadog.glyph, .symbol("dog"))

        XCTAssertEqual(F.defaultEventConfig(.gitlab), ["events": .array([.string("review_requested"), .string("mentioned")]), "username": .string("")])
        XCTAssertEqual(F.defaultEventConfig(.jira), ["events": .array([.string("assigned"), .string("mentioned")]), "user": .string("")])
        XCTAssertEqual(F.defaultEventConfig(.sentry), ["events": .array([.string("issue_created")])])
        XCTAssertEqual(F.defaultEventConfig(.alertmanager), ["events": .array([.string("firing")])])
        XCTAssertEqual(F.defaultEventConfig(.datadog), ["events": .array([.string("triggered")])])

        // Identity: the key each type's personal kinds are matched against.
        XCTAssertEqual(F.identityKey(.github), "login")
        XCTAssertEqual(F.identityKey(.gitlab), "username")
        XCTAssertEqual(F.identityKey(.linear), "user")
        XCTAssertEqual(F.identityKey(.jira), "user")
        for t in [F.EventTriggerType.slack, .pylon, .pagerduty, .sentry, .alertmanager, .datadog] {
            XCTAssertNil(F.identityKey(t), t.rawValue)
            XCTAssertFalse(F.eventKinds(t).contains { $0.personal }, t.rawValue)
        }
        XCTAssertEqual(F.eventKinds(.gitlab).filter(\.personal).map(\.value), ["review_requested", "mentioned", "assigned"])
        XCTAssertEqual(F.eventKinds(.jira).filter(\.personal).map(\.value), ["assigned", "mentioned"])

        // GitHub's new repo-level kinds, and each new type's kinds.
        XCTAssertEqual(F.eventKinds(.github).map(\.value), [
            "review_requested", "mentioned", "assigned", "pr_opened", "issue_opened",
            "pr_merged", "labeled", "push", "release_published", "workflow_succeeded", "workflow_failed",
        ])
        XCTAssertEqual(F.eventKinds(.gitlab).map(\.value), [
            "review_requested", "mentioned", "assigned", "mr_opened", "mr_merged", "issue_opened", "labeled",
            "push", "release_published", "pipeline_succeeded", "pipeline_failed",
        ])
        XCTAssertEqual(F.eventKinds(.jira).map(\.value), ["assigned", "mentioned", "created", "commented", "transitioned", "labeled"])
        XCTAssertEqual(F.eventKinds(.sentry).map(\.value), [
            "issue_created", "issue_unresolved", "issue_resolved", "issue_assigned", "issue_archived",
            "alert_triggered", "metric_alert_critical", "metric_alert_warning", "metric_alert_resolved",
        ])
        XCTAssertEqual(F.eventKinds(.alertmanager).map(\.value), ["firing", "resolved"])
        XCTAssertEqual(F.eventKinds(.datadog).map(\.value), ["triggered", "warning", "no_data", "recovered"])

        // Filters beside the kinds, keyed like the server's config.
        XCTAssertEqual(F.listFilters(.github).map(\.key), ["repos", "branches", "workflows", "labels"])
        XCTAssertEqual(F.listFilters(.gitlab).map(\.key), ["projects", "branches", "labels"])
        XCTAssertEqual(F.listFilters(.jira).map(\.key), ["projects", "labels", "issueTypes", "statuses"])
        XCTAssertEqual(F.listFilters(.sentry).map(\.key), ["projects", "environments", "levels"])
        XCTAssertEqual(F.listFilters(.alertmanager).map(\.key), ["alertnames", "severities", "receivers"])
        XCTAssertEqual(F.listFilters(.datadog).map(\.key), ["priorities", "tags", "monitors"])
        XCTAssertTrue(F.listFilters(.slack).isEmpty)

        // Params: the new GitHub fields, and the ticket-style aliases Jira and Sentry carry.
        XCTAssertTrue(F.triggerParams(.github).contains("workflow"))
        XCTAssertTrue(F.triggerParams(.github).contains("compareUrl"))
        XCTAssertTrue(F.triggerParams(.gitlab).contains("pipelineStatus"))
        XCTAssertTrue(F.triggerParams(.jira).contains("ticketUrl"))
        XCTAssertTrue(F.triggerParams(.jira).contains("key"))
        XCTAssertTrue(F.triggerParams(.sentry).contains("ticketExternalId"))
        XCTAssertTrue(F.triggerParams(.sentry).contains("culprit"))
        XCTAssertTrue(F.triggerParams(.alertmanager).contains("alerts"))
        XCTAssertTrue(F.triggerParams(.datadog).contains("transition"))

        func sentence(_ w: F.WhenType, _ e: F.EventTriggerType) -> String {
            text(F.normalize(with(empty) {
                $0.when = w; $0.withRepo = false; $0.event = .default(e); $0.prompt = "p"
                // The defaults ask about you (review requests, mentions): say who.
                if let key = F.identityKey(e) { $0.event.config[key] = .string("me") }
            }))
        }
        XCTAssertTrue(sentence(.gitlab, .gitlab).hasPrefix("Started by GitLab events,"))
        XCTAssertTrue(sentence(.jira, .jira).hasPrefix("Started by Jira events,"))
        XCTAssertTrue(sentence(.sentry, .sentry).hasPrefix("Started by Sentry alerts,"))
        XCTAssertTrue(sentence(.alertmanager, .alertmanager).hasPrefix("Started by Alertmanager alerts,"))
        XCTAssertTrue(sentence(.datadog, .datadog).hasPrefix("Started by Datadog monitors,"))
    }

    func testSlugify() {
        XCTAssertEqual(F.slugify("Release Manager!"), "release-manager")
        XCTAssertEqual(F.slugify("Session 12"), "session-12")
        XCTAssertEqual(F.slugify("  --Ünïcode__name  "), "n-code-name")
        XCTAssertEqual(F.slugify(String(repeating: "a", count: 50)).count, 40)
    }

    // MARK: helpers the picker and the submitter lean on

    func testRepoUrlFromRemote() {
        XCTAssertEqual(F.repoUrlFromRemote("git@github.com:jonwiggins/optio.git"), "https://github.com/jonwiggins/optio")
        XCTAssertEqual(F.repoUrlFromRemote("ssh://git@github.com:22/Foo/Bar.git"), "https://github.com/foo/bar")
        XCTAssertEqual(F.repoUrlFromRemote("HTTPS://GitHub.com/Foo/Bar/"), "https://github.com/foo/bar")
        XCTAssertEqual(F.repoUrlFromRemote("github.com/foo/bar"), "https://github.com/foo/bar")
        XCTAssertNil(F.repoUrlFromRemote(nil))
        XCTAssertNil(F.repoUrlFromRemote("  "))
        XCTAssertEqual(F.shortRepo("git@github.com:acme/app.git"), "github.com/acme/app")
    }

    func testFullOptionsApplyForEveryPodRun() {
        XCTAssertTrue(F.fullOptionsApply(empty))
        XCTAssertTrue(F.fullOptionsApply(with(empty) { $0.withRepo = false }))
        XCTAssertTrue(F.fullOptionsApply(F.normalize(with(empty) { $0.withRepo = false; $0.then = .waitsForMessages })))
        XCTAssertFalse(F.fullOptionsApply(local(empty)))
        XCTAssertFalse(F.fullOptionsApply(with(empty) { $0.runtime = F.terminal }))
    }

    func testPresetsResetAgentOptionsAndAliasesResolve() {
        let d = with(empty) { $0.agentOptions = ["claudeModel": .string("opus")] }
        for p in F.presets { XCTAssertEqual(p.apply(d).agentOptions, [:], p.id) }
        XCTAssertEqual(F.resolveModel("opus", aliases: ["opus": "claude-opus-4-8"]), "claude-opus-4-8")
        XCTAssertEqual(F.resolveModel("claude-opus-4-8", aliases: ["opus": "claude-opus-4-8"]), "claude-opus-4-8")
        XCTAssertEqual(F.resolveModel("x", aliases: nil), "x")
    }

    func testOptionsFromRepoReadsOnlyTheRuntimesColumns() {
        let repo: [String: AnyCodable] = ["claudeModel": .string("opus"), "claudeThinking": .bool(true), "fullName": .string("x"), "maxTurnsCoding": .int(5), "copilotModel": .string("gpt-5")]
        XCTAssertEqual(F.optionsFromRepo(runtime: "claude-code", repo: repo), ["claudeModel": .string("opus")])
        XCTAssertEqual(F.optionsFromRepo(runtime: "copilot", repo: repo), ["copilotModel": .string("gpt-5")])
        // Codex shares Copilot's columns, so a repo keeps no settings for it.
        XCTAssertEqual(F.optionsFromRepo(runtime: "codex", repo: repo), [:])
        XCTAssertEqual(F.optionsFromRepo(runtime: F.terminal, repo: repo), [:])
        XCTAssertEqual(F.optionsFromRepo(runtime: "claude-code", repo: nil), [:])
    }

    func testPickedModelAndSetOptions() {
        let d = with(empty) { $0.runtime = "codex"; $0.agentOptions = ["copilotModel": .string("gpt-5"), "codexReasoning": .string(""), "flag": .bool(false)] }
        XCTAssertEqual(F.pickedModel(d), "gpt-5")
        XCTAssertEqual(F.setOptions(d), ["copilotModel": .string("gpt-5"), "flag": .bool(false)])
        XCTAssertNil(F.pickedModel(with(empty) { $0.runtime = F.terminal }))
        XCTAssertNil(F.setOptions(with(empty) { $0.agentOptions = ["claudeModel": .string("")] }))
    }

    func testGenericTriggerConfigs() {
        XCTAssertNil(F.triggerFor(empty))
        let sched = F.triggerFor(with(empty) { $0.trigger = F.TriggerConfig(type: .schedule, cronExpression: " 0 9 * * * ") })
        XCTAssertEqual(sched?.type, "schedule")
        XCTAssertEqual(sched?.config, ["cronExpression": .string("0 9 * * *")])
        let ticket = F.triggerFor(with(empty) { $0.trigger = F.TriggerConfig(type: .ticket, ticketSource: .linear, ticketLabels: ["bug"]) })
        XCTAssertEqual(ticket?.config, ["source": .string("linear"), "labels": .array([.string("bug")])])
        let plain = F.triggerFor(with(empty) { $0.trigger = F.TriggerConfig(type: .ticket) })
        XCTAssertEqual(plain?.config, ["source": .string("github")])
        let gh = F.triggerFor(with(empty) { $0.when = .github; $0.event = F.EventTrigger(type: .github, config: ["events": .array([.string("push")])]) })
        XCTAssertEqual(gh?.type, "github")
        XCTAssertEqual(gh?.config, ["events": .array([.string("push")])])
    }

    /// The catalog says which options a run on a machine honors (the server
    /// turns them into the CLI's flags; the app only shows the right ones).
    func testCatalogOptionsSayWhereTheyApply() throws {
        let json = #"""
        {"provider":"openai","label":"OpenAI Codex","modelField":"copilotModel","models":[],"options":[
          {"key":"copilotEffort","label":"Reasoning effort","kind":"select","runsOn":["pod","local"],"localParam":"effort"},
          {"key":"codexPermissionMode","label":"Permissions","kind":"select","runsOn":["local"],"localParam":"permissionMode",
           "choices":[{"value":"bypassPermissions","label":"Skip all checks"}]},
          {"key":"podOnly","label":"Pod only","kind":"select"}
        ]}
        """#
        let catalog = try JSONDecoder().decode(ProviderCatalog.self, from: Data(json.utf8))
        XCTAssertEqual(catalog.options.map(\.appliesToLocal), [true, true, false])
        XCTAssertEqual(catalog.options.map(\.appliesToPods), [true, false, true])
    }

    func testSubmitLabel() {
        XCTAssertEqual(F.submitLabel(empty), "Start work (opens a PR)")
        XCTAssertEqual(F.submitLabel(with(empty) { $0.withRepo = false }), "Start work")
        XCTAssertEqual(F.submitLabel(with(empty) { $0.then = .waitsForMe }), "Open session")
        XCTAssertEqual(F.submitLabel(F.normalize(with(empty) { $0.withRepo = false; $0.then = .waitsForMessages })), "Create agent")
        XCTAssertEqual(F.submitLabel(with(empty) { $0.when = .schedule }), "Save")
        XCTAssertEqual(F.submitLabel(with(empty) { $0.then = .untilMerged }), "Start work (until merged)")
    }

    func testCronValidity() {
        XCTAssertTrue(F.cronIsValid("0 9 * * 1-5"))
        XCTAssertFalse(F.cronIsValid("nope"))
        XCTAssertFalse(F.cronIsValid(nil))
        XCTAssertTrue(F.randomWebhookPath().hasPrefix("hook-"))
        XCTAssertEqual(F.randomWebhookPath().count, 13)
    }

    // MARK: Work until merged — PR follow-through

    private var repoBase: F.Draft { with(empty) { $0.prompt = "p"; $0.repoUrl = "https://github.com/a/b" } }

    func testUntilMergedNeedsAnAgentWithARepo() {
        XCTAssertTrue(enabled(F.thenOptions(repoBase)).contains(.untilMerged))
        XCTAssertTrue(enabled(F.thenOptions(local(repoBase))).contains(.untilMerged))
        XCTAssertFalse(enabled(F.thenOptions(with(repoBase) { $0.withRepo = false })).contains(.untilMerged))
        XCTAssertFalse(enabled(F.thenOptions(local(with(repoBase) { $0.withRepo = false }))).contains(.untilMerged))
        XCTAssertFalse(enabled(F.thenOptions(with(repoBase) { $0.runtime = F.terminal })).contains(.untilMerged))
    }

    func testUntilMergedIsStillATaskHeadless() {
        let d = F.normalize(with(repoBase) { $0.then = .untilMerged })
        XCTAssertEqual(d.then, .untilMerged)
        XCTAssertEqual(F.deriveKind(d), .repoTask)
        XCTAssertEqual(F.deriveKind(with(d) { $0.when = .ticket; $0.trigger = F.TriggerConfig(type: .ticket) }), .repoBlueprint)
        XCTAssertEqual(F.normalize(local(d)).location.localSessionMode, .headless)
    }

    func testUntilMergedSnapsBackToExitsWithoutARepo() {
        XCTAssertEqual(F.normalize(with(repoBase) { $0.then = .untilMerged; $0.withRepo = false }).then, .exits)
    }

    func testUntilMergedReadsAsASentence() {
        XCTAssertEqual(
            text(with(repoBase) { $0.then = .untilMerged }),
            "Started now, a Claude Code run in an Optio pod with https://github.com/a/b that opens a PR and keeps working on it until it merges."
        )
        XCTAssertTrue(text(with(repoBase) { $0.then = .untilMerged; $0.mergeWhenReady = false }).hasSuffix("keeps it green until you merge it."))
    }

    func testAssignToOptioPresetIsATicketLabeledScheduledTaskWorkedUntilMerged() {
        let d = F.normalize(F.preset("assign")!.apply(empty))
        XCTAssertEqual(d.when, .ticket)
        XCTAssertEqual(d.trigger.ticketLabels, ["optio"])
        XCTAssertEqual(d.trigger.ticketSource, .github)
        XCTAssertEqual(d.then, .untilMerged)
        XCTAssertTrue(d.mergeWhenReady)
        XCTAssertEqual(F.deriveKind(d), .repoBlueprint)
    }

    private func on(_ plan: F.FollowThrough?) -> [F.FollowThroughStep.Key] {
        plan?.steps.filter(\.on).map(\.key) ?? []
    }

    func testExitWhenDoneShowsTheReposSettings() {
        let plan = F.followThrough(repoBase, repo: F.RepoPrSettings(autoResume: false, autoMerge: false))
        XCTAssertEqual(plan?.fromRepo, true)
        XCTAssertEqual(on(plan), [.pr, .done])
        XCTAssertEqual(
            on(F.followThrough(repoBase, repo: F.RepoPrSettings(autoResume: true, autoMerge: true, reviewEnabled: true, reviewTrigger: "on_ci_pass"))),
            [.pr, .review, .ci, .changes, .merge, .done]
        )
    }

    func testUntilMergedResumesAndMergesWhateverTheRepoSays() {
        let d = with(repoBase) { $0.then = .untilMerged }
        let plan = F.followThrough(d, repo: F.RepoPrSettings(autoResume: false, autoMerge: false, maxAutoResumes: 4))
        XCTAssertEqual(plan?.fromRepo, false)
        XCTAssertEqual(on(plan), [.pr, .ci, .changes, .merge, .done])
        XCTAssertTrue(plan?.steps.first { $0.key == .ci }?.detail?.contains("up to 4 times") == true)
        XCTAssertEqual(on(F.followThrough(with(d) { $0.mergeWhenReady = false }, repo: nil)), [.pr, .ci, .changes, .done])
    }

    func testCautiousModeHoldsTheMergeBack() {
        let plan = F.followThrough(with(repoBase) { $0.then = .untilMerged }, repo: F.RepoPrSettings(cautiousMode: true))
        let merge = plan?.steps.first { $0.key == .merge }
        XCTAssertEqual(merge?.on, false)
        XCTAssertTrue(merge?.detail?.contains("cautious mode") == true)
        XCTAssertEqual(plan?.steps.first?.label, "Opens a draft PR")
    }

    func testOnlyWorkThatOpensAPRHasAPlan() {
        XCTAssertNil(F.followThrough(with(repoBase) { $0.withRepo = false }, repo: nil))
        XCTAssertNil(F.followThrough(with(repoBase) { $0.then = .waitsForMe }, repo: nil))
    }

    func testRepoPrSettingsReadTheRawRepoRow() {
        let s = F.RepoPrSettings(row: [
            "autoResume": .bool(true), "autoMerge": .null, "cautiousMode": .bool(false),
            "reviewEnabled": .bool(true), "reviewTrigger": .string("on_pr"), "maxAutoResumes": .int(3),
        ])
        XCTAssertEqual(s, F.RepoPrSettings(autoResume: true, autoMerge: nil, cautiousMode: false, reviewEnabled: true, reviewTrigger: "on_pr", maxAutoResumes: 3))
    }

    func testEventGaps() {
        func gaps(_ type: F.EventTriggerType, _ config: [String: AnyCodable]) -> [F.SentenceField] {
            F.eventGaps(F.EventTrigger(type: type, config: config))
        }
        // Slack: a channel id, nothing else.
        XCTAssertEqual(gaps(.slack, ["channelId": .string("")]), [.channel])
        XCTAssertEqual(gaps(.slack, ["channelId": .string("general")]), [.channel])
        XCTAssertEqual(gaps(.slack, ["channelId": .string("C0123ABCD")]), [])
        // Pylon's kinds are free text: empty means whatever the trigger sends.
        XCTAssertEqual(gaps(.pylon, ["events": .array([])]), [])
        // Every other type needs some kind checked.
        XCTAssertEqual(gaps(.github, ["events": .array([])]), [.events])
        XCTAssertEqual(gaps(.sentry, [:]), [.events])
        XCTAssertEqual(gaps(.github, ["events": .array([.string("pr_opened")])]), [])
        // Personal kinds need an identity; the key is the type's.
        XCTAssertEqual(gaps(.github, ["events": .array([.string("mentioned")]), "login": .string(" ")]), [.identity])
        XCTAssertEqual(gaps(.github, ["events": .array([.string("mentioned")]), "login": .string("jon")]), [])
        XCTAssertEqual(gaps(.gitlab, ["events": .array([.string("assigned")]), "username": .string("jon")]), [])
        XCTAssertEqual(gaps(.jira, ["events": .array([.string("assigned")])]), [.identity])
        XCTAssertEqual(gaps(.linear, ["events": .array([.string("created")]), "othersOnly": .bool(true)]), [.identity])
        XCTAssertEqual(gaps(.linear, ["events": .array([.string("created")]), "othersOnly": .bool(true), "user": .string("Jane")]), [])
        XCTAssertEqual(gaps(.datadog, ["events": .array([.string("triggered")])]), [])
        // The gaps land in the sentence and the field list.
        let slack = F.normalize(with(empty) { $0.when = .slack; $0.withRepo = false; $0.event = .default(.slack); $0.prompt = "p" })
        XCTAssertEqual(text(slack), "Started by Slack messages [in a channel], a Claude Code run in an Optio pod that exits when done.")
        XCTAssertEqual(F.missingFields(slack), [.channel])
        let none = F.normalize(with(empty) { $0.when = .sentry; $0.withRepo = false; $0.event = F.EventTrigger(type: .sentry, config: [:]); $0.prompt = "p" })
        XCTAssertEqual(text(none), "Started by Sentry alerts [of some kind], a Claude Code run in an Optio pod that exits when done.")
        XCTAssertEqual(F.missingFields(none), [.events])
    }

    func testRecurringWorkNamesEachRun() {
        XCTAssertFalse(F.namesRuns(empty))
        XCTAssertTrue(F.namesRuns(with(empty) { $0.when = .schedule }))
        XCTAssertTrue(F.namesRuns(with(empty) { $0.when = .webhook; $0.withRepo = false }))
        XCTAssertFalse(F.namesRuns(with(empty) { $0.withRepo = false }))
        XCTAssertTrue(F.namesRuns(F.normalize(local(with(empty) { $0.when = .github; $0.then = .waitsForMe }))))
        XCTAssertFalse(F.namesRuns(F.normalize(with(empty) { $0.withRepo = false; $0.then = .waitsForMessages })))
    }
}
