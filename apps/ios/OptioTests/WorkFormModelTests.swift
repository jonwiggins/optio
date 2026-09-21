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

    func testPodTerminalNeedsRepoAndIsOpenedByHand() {
        XCTAssertFalse(enabled(F.runtimeOptions(with(empty) { $0.withRepo = false })).contains(F.terminal))
        XCTAssertFalse(enabled(F.runtimeOptions(with(empty) { $0.when = .schedule })).contains(F.terminal))
        XCTAssertTrue(enabled(F.runtimeOptions(empty)).contains(F.terminal))
    }

    func testTerminalWithNoAgentWaitsForYou() {
        let d = F.normalize(local(with(empty) { $0.withRepo = false; $0.runtime = F.terminal }))
        XCTAssertEqual(enabled(F.thenOptions(d)), [.waitsForMe])
        XCTAssertEqual(d.then, .waitsForMe)
        XCTAssertEqual(d.location.localSessionMode, .interactive)
    }

    func testPersistentAgentLivesInPodNoRepoNotOnEvents() {
        XCTAssertFalse(enabled(F.thenOptions(local(empty))).contains(.waitsForMessages))
        XCTAssertFalse(enabled(F.thenOptions(empty)).contains(.waitsForMessages))
        XCTAssertTrue(enabled(F.thenOptions(with(empty) { $0.withRepo = false })).contains(.waitsForMessages))
        let flipped = F.normalize(local(with(empty) { $0.withRepo = false; $0.then = .waitsForMessages }))
        XCTAssertEqual(flipped.then, .exits)
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
        XCTAssertEqual(text(agent), "Woken by messages, a OpenAI Codex agent in an Optio pod that keeps its memory between turns.")

        let hook = F.normalize(with(empty) { $0.withRepo = false; $0.when = .webhook; $0.trigger = F.TriggerConfig(type: .webhook, webhookPath: "hook-abc") })
        XCTAssertEqual(text(hook), "Started by a webhook at /api/hooks/hook-abc, a Claude Code run in an Optio pod that exits when done.")
        let noPath = with(hook) { $0.trigger.webhookPath = nil }
        XCTAssertEqual(text(noPath), "Started by [a webhook path], a Claude Code run in an Optio pod that exits when done.")
        XCTAssertEqual(F.missingFields(noPath), [.webhook, .prompt])

        let gh = F.normalize(with(empty) { $0.when = .github; $0.withRepo = false })
        XCTAssertEqual(text(gh), "Started by GitHub events, a Claude Code run in an Optio pod that exits when done.")
        XCTAssertEqual(F.missingFields(gh), [.prompt])
        let ghLocal = F.normalize(with(empty) { $0.when = .github; $0.withRepo = false; $0.location.runTarget = .local })
        XCTAssertEqual(text(ghLocal), "Started by GitHub events, a Claude Code run [a machine] [a directory] that exits when done.")

        let shell = F.normalize(local(with(empty) { $0.withRepo = false; $0.runtime = F.terminal }, dir: "/home/dev/x"))
        XCTAssertEqual(text(shell), "Opened now, a terminal on my machine in ~/x that waits for you between turns.")

        let missingRepo = with(empty) { $0.repoUrl = "" }
        XCTAssertEqual(text(missingRepo), "Started now, a Claude Code run in an Optio pod [a repo] that opens a PR and exits when done.")
        XCTAssertEqual(F.missingFields(missingRepo), [.repo, .prompt])
    }

    // MARK: presets and params

    func testPresetsLandOnPromisedKinds() {
        var by: [String: F.Draft] = [:]
        for p in F.presets { by[p.id] = F.normalize(p.apply(empty)) }
        XCTAssertEqual(F.deriveKind(by["pr"]!), .repoTask)
        XCTAssertEqual(F.deriveKind(local(by["chat"]!)), .localTerminal)
        XCTAssertEqual(F.deriveKind(by["schedule"]!), .standalone)
        XCTAssertEqual(F.deriveKind(by["agent"]!), .persistentAgent)
    }

    func testTicketStyleParamsForTicketAndLinear() {
        XCTAssertTrue(F.triggerParams(.ticket).contains("ticketUrl"))
        XCTAssertTrue(F.triggerParams(.linear).contains("ticketUrl"))
        XCTAssertEqual(F.triggerParams(.schedule), [])
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

    func testOptionsFromRepoReadsOnlyCatalogKeys() {
        let repo: [String: AnyCodable] = ["claudeModel": .string("opus"), "claudeThinking": .bool(true), "fullName": .string("x"), "maxTurnsCoding": .int(5)]
        let out = F.optionsFromRepo(runtime: "claude-code", repo: repo, keys: ["claudeModel", "claudeThinking", "claudeEffort"])
        XCTAssertEqual(out, ["claudeModel": .string("opus"), "claudeThinking": .bool(true)])
        XCTAssertEqual(F.optionsFromRepo(runtime: F.terminal, repo: repo, keys: ["claudeModel"]), [:])
        XCTAssertEqual(F.optionsFromRepo(runtime: "claude-code", repo: nil, keys: ["claudeModel"]), [:])
    }

    func testPickedModelAndSetOptions() {
        let d = with(empty) { $0.runtime = "codex"; $0.agentOptions = ["copilotModel": .string("gpt-5"), "codexReasoning": .string(""), "flag": .bool(false)] }
        XCTAssertEqual(F.pickedModel(d), "gpt-5")
        XCTAssertEqual(F.setOptions(d), ["copilotModel": .string("gpt-5"), "flag": .bool(false)])
        XCTAssertNil(F.pickedModel(with(empty) { $0.runtime = F.terminal }))
        XCTAssertNil(F.setOptions(with(empty) { $0.agentOptions = ["claudeModel": .string("")] }))
    }

    func testGenericTriggerAndLocationPayload() {
        XCTAssertNil(F.triggerFor(empty))
        let sched = F.triggerFor(with(empty) { $0.trigger = F.TriggerConfig(type: .schedule, cronExpression: " 0 9 * * * ") })
        XCTAssertEqual(sched?.type, "schedule")
        XCTAssertEqual(sched?.config, ["cronExpression": .string("0 9 * * *")])
        let ticket = F.triggerFor(with(empty) { $0.trigger = F.TriggerConfig(type: .ticket, ticketSource: .linear, ticketLabels: ["bug"]) })
        XCTAssertEqual(ticket?.config, ["source": .string("linear"), "labels": .array([.string("bug")])])
        let plain = F.triggerFor(with(empty) { $0.trigger = F.TriggerConfig(type: .ticket) })
        XCTAssertEqual(plain?.config, ["source": .string("github")])

        XCTAssertEqual(F.locationPayload(empty), ["runTarget": .string("cluster"), "localHostId": .null, "localDir": .null, "localSessionMode": .null])
        let l = F.locationPayload(F.normalize(local(with(empty) { $0.withRepo = false; $0.then = .waitsForMe })))
        XCTAssertEqual(l["runTarget"], .string("local"))
        XCTAssertEqual(l["localHostId"], .string("h1"))
        XCTAssertEqual(l["localSessionMode"], .string("interactive"))
    }

    func testSubmitLabel() {
        XCTAssertEqual(F.submitLabel(empty), "Start work (opens a PR)")
        XCTAssertEqual(F.submitLabel(with(empty) { $0.withRepo = false }), "Start work")
        XCTAssertEqual(F.submitLabel(with(empty) { $0.then = .waitsForMe }), "Open session")
        XCTAssertEqual(F.submitLabel(F.normalize(with(empty) { $0.withRepo = false; $0.then = .waitsForMessages })), "Create agent")
        XCTAssertEqual(F.submitLabel(with(empty) { $0.when = .schedule }), "Save")
    }

    func testCronValidity() {
        XCTAssertTrue(F.cronIsValid("0 9 * * 1-5"))
        XCTAssertFalse(F.cronIsValid("nope"))
        XCTAssertFalse(F.cronIsValid(nil))
        XCTAssertTrue(F.randomWebhookPath().hasPrefix("hook-"))
        XCTAssertEqual(F.randomWebhookPath().count, 13)
    }
}
