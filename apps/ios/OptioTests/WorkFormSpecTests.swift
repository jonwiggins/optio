import XCTest
@testable import Optio

/// Mirrors `apps/web/src/components/work-form/submit.test.ts`: the draft as the
/// `WorkSpec` that `POST /api/work` takes, the name-clash retry, and where a
/// `WorkCreated` reply leads.
final class WorkFormSpecTests: XCTestCase {
    private typealias F = WorkForm
    private let empty = F.Draft.empty
    private let repo = "https://github.com/acme/app"

    private func with(_ d: F.Draft, _ change: (inout F.Draft) -> Void) -> F.Draft {
        var d = d
        change(&d)
        return d
    }

    private func local(_ d: F.Draft, dir: String = "/Users/dev/repos/app") -> F.Draft {
        with(d) {
            $0.location.runTarget = .local
            $0.location.localHostId = "h1"
            $0.location.localDir = dir
        }
    }

    private func spec(_ d: F.Draft, repoUrl: String? = nil, name: String = "Job 1") -> [String: AnyCodable] {
        F.specFor(F.normalize(d), repoUrl: repoUrl ?? "", name: name)
    }

    private func part(_ spec: [String: AnyCodable], _ key: String) -> [String: AnyCodable] {
        spec[key]?.objectValue ?? [:]
    }

    // MARK: specFor

    func testJobStartedNow() {
        let d = with(empty) {
            $0.withRepo = false
            $0.agentOptions = ["claudeModel": .string("opus"), "claudeThinking": .string("")]
            $0.prompt = "  do the thing  "
            $0.description = " "
        }
        let s = spec(d, name: "Job 7")
        XCTAssertEqual(s["name"], .string("Job 7"))
        XCTAssertEqual(s["description"], .null)
        XCTAssertEqual(s["when"], .object(["type": .string("manual")]))
        XCTAssertEqual(part(s, "where"), ["runTarget": .string("cluster"), "repoUrl": .null, "repoBranch": .null, "localHostId": .null, "localDir": .null])
        XCTAssertEqual(part(s, "who"), ["runtime": .string("claude-code"), "agentOptions": .object(["claudeModel": .string("opus")]), "model": .string("opus")])
        XCTAssertEqual(part(s, "what"), ["prompt": .string("do the thing"), "runTitle": .null])
        XCTAssertEqual(s["then"], .string("exits"))
        XCTAssertEqual(s["mergeWhenReady"], .bool(true))
        XCTAssertEqual(s["maxRetries"], .int(3))
        XCTAssertEqual(s["priority"], .int(100))
        XCTAssertEqual(s["owner"], .string("workspace"))
        XCTAssertEqual(s["podSecrets"], .array([]))
        XCTAssertNil(s["agent"])
        XCTAssertNil(s["dependsOn"])
    }

    func testScheduledTaskOnAGitHubEventNamesItsRuns() {
        let d = with(empty) {
            $0.when = .github
            $0.event = F.EventTrigger(type: .github, config: ["events": .array([.string("pr_opened")]), "repos": .array([.string("acme/app")])])
            $0.repoUrl = repo
            $0.repoBranch = " main "
            $0.runName = " Review: {{title}} "
            $0.prompt = "review it"
            $0.description = "Reviews every PR"
            $0.podSecrets = ["GH"]
            $0.owner = .me
        }
        let s = spec(d, repoUrl: repo, name: "Reviewer")
        XCTAssertEqual(s["when"], .object(["type": .string("github"), "config": .object(["events": .array([.string("pr_opened")]), "repos": .array([.string("acme/app")])])]))
        XCTAssertEqual(part(s, "where")["repoUrl"], .string(repo))
        XCTAssertEqual(part(s, "where")["repoBranch"], .string("main"))
        XCTAssertEqual(part(s, "what"), ["prompt": .string("review it"), "runTitle": .string("Review: {{title}}")])
        XCTAssertEqual(s["description"], .string("Reviews every PR"))
        XCTAssertEqual(s["owner"], .string("me"))
        XCTAssertEqual(s["podSecrets"], .array([.string("GH")]))
        XCTAssertNil(s["dependsOn"], "only a one-off Task waits for other tasks")
    }

    func testRepoTaskWaitsForTasksAndLeavesTheBranchToTheRepo() {
        let d = with(empty) {
            $0.repoUrl = repo
            $0.repoBranch = ""
            $0.prompt = "p"
            $0.dependsOn = ["7f1c6a2e-0b7f-4a65-9a7e-1a2b3c4d5e6f"]
            $0.then = .untilMerged
            $0.mergeWhenReady = false
        }
        let s = spec(d, repoUrl: repo)
        XCTAssertEqual(part(s, "where")["repoBranch"], .null, "blank on a pod = the repo's default branch")
        XCTAssertEqual(s["dependsOn"], .array([.string("7f1c6a2e-0b7f-4a65-9a7e-1a2b3c4d5e6f")]))
        XCTAssertEqual(s["then"], .string("until-merged"))
        XCTAssertEqual(s["mergeWhenReady"], .bool(false))
    }

    func testShellOnAMachineCarriesNoAgentPromptOrOwner() {
        let d = local(with(empty) { $0.withRepo = false; $0.runtime = F.terminal; $0.then = .waitsForMe; $0.prompt = "ignored" })
        let s = spec(d)
        XCTAssertEqual(part(s, "where"), ["runTarget": .string("local"), "repoUrl": .null, "repoBranch": .null, "localHostId": .string("h1"), "localDir": .string("/Users/dev/repos/app")])
        XCTAssertEqual(part(s, "who"), ["runtime": .null, "agentOptions": .null, "model": .null])
        XCTAssertEqual(part(s, "what")["prompt"], .string(""), "a terminal that waits for you has nothing to run")
        XCTAssertNil(s["owner"])
        XCTAssertNil(s["podSecrets"])
    }

    func testCommandRunsItsCommand() {
        let onMachine = local(with(empty) { $0.withRepo = false; $0.runtime = F.terminal; $0.then = .exits; $0.prompt = "make check" })
        XCTAssertEqual(part(spec(onMachine), "what")["prompt"], .string("make check"))
        XCTAssertEqual(part(spec(onMachine), "who")["runtime"], .null)
        XCTAssertEqual(spec(onMachine)["owner"], .string("me"), "a machine run is always yours")
        let inPod = with(empty) { $0.withRepo = false; $0.runtime = F.terminal; $0.then = .exits; $0.prompt = "./report.sh"; $0.podSecrets = ["TOKEN"] }
        XCTAssertEqual(spec(inPod)["podSecrets"], .array([.string("TOKEN")]), "a command in a pod gets its secrets like an agent")
    }

    func testNewBranchOnAMachineDefaultsToMain() {
        let d = local(with(empty) { $0.withRepo = true; $0.repoBranch = "  "; $0.prompt = "p" })
        XCTAssertEqual(part(spec(d, repoUrl: repo), "where")["repoBranch"], .string("main"))
        XCTAssertEqual(part(spec(d, repoUrl: repo), "where")["repoUrl"], .string(repo))
        XCTAssertEqual(spec(d, repoUrl: repo)["owner"], .string("me"))
    }

    func testPersistentAgentHasAnAddressAndAPod() {
        let d = with(empty) { $0.withRepo = false; $0.then = .waitsForMessages; $0.prompt = "hello"; $0.agent.podLifecycle = .onDemand }
        let s = spec(d, name: "Ops Bot")
        let agent = part(s, "agent")
        XCTAssertEqual(agent["slug"], .string("ops-bot"))
        XCTAssertEqual(agent["podLifecycle"], .string("on-demand"))
        XCTAssertEqual(agent["systemPrompt"], .null)
        XCTAssertEqual(agent["agentsMd"], .string(AgentFormSheet.defaultAgentsMd))
        XCTAssertEqual(part(spec(with(d) { $0.agent.slug = " ops " }, name: "Ops Bot"), "agent")["slug"], .string("ops"))
        XCTAssertEqual(s["then"], .string("waits-for-messages"))
    }

    func testPodSessionAlwaysNamesItsRepo() {
        let d = with(empty) { $0.then = .waitsForMe; $0.repoUrl = repo }
        let s = spec(d, repoUrl: repo)
        XCTAssertEqual(part(s, "where")["repoUrl"], .string(repo))
        XCTAssertEqual(part(s, "what")["prompt"], .string(""))
        XCTAssertNil(s["owner"])
    }

    // MARK: names and clashes

    func testAutomaticNamesBumpOnAClashYoursNever() {
        XCTAssertEqual(F.nameForAttempt(own: "", auto: "Job 3", attempt: 1), "Job 3")
        XCTAssertEqual(F.nameForAttempt(own: " ", auto: "Job 3", attempt: 2), "Job 3 (2)")
        XCTAssertEqual(F.nameForAttempt(own: " Mine ", auto: "Job 3", attempt: 4), "Mine")
    }

    func testNameClashIsA409WithNameTaken() {
        func err(_ status: Int, _ body: String?) -> APIError {
            APIError(status: status, message: "x", body: body.map { Data($0.utf8) })
        }
        XCTAssertTrue(F.isNameClash(err(409, #"{"error":"taken","details":"name_taken"}"#)))
        XCTAssertFalse(F.isNameClash(err(409, #"{"error":"taken","details":"webhook_path_taken"}"#)))
        XCTAssertFalse(F.isNameClash(err(400, #"{"error":"bad","details":"name_taken"}"#)))
        XCTAssertFalse(F.isNameClash(err(409, nil)))
        XCTAssertFalse(F.isNameClash(err(409, "not json")))
        XCTAssertEqual(F.apiDetails(err(409, #"{"error":"taken","details":"webhook_path_taken"}"#)), "webhook_path_taken")
    }

    // MARK: WorkCreated → where to go

    private func created(_ kind: String, run: String? = nil, secret: String? = nil, triggerId: String? = nil) -> F.WorkCreated {
        F.WorkCreated(
            kind: kind, id: "id1", href: "/x",
            run: run.map { F.WorkCreated.Run(id: $0) },
            trigger: triggerId.map { F.WorkCreated.Trigger(id: $0, secret: secret) }
        )
    }

    func testMadeMapsEveryKindToItsScreen() throws {
        let job = with(empty) { $0.withRepo = false }
        XCTAssertEqual(try F.made(created("standalone", run: "r1"), draft: job, name: "Job 1").destination, .jobRun(jobId: "id1", runId: "r1"))
        XCTAssertEqual(try F.made(created("standalone", run: "r1"), draft: job, name: "Job 1").toast, "Job 1 started")
        XCTAssertEqual(try F.made(created("standalone"), draft: job, name: "Job 1").destination, .job("id1"))
        XCTAssertEqual(try F.made(created("standalone"), draft: job, name: "Job 1").toast, "Job 1 saved")
        XCTAssertEqual(try F.made(created("repo-task"), draft: empty, name: "T").destination, .task("id1"))
        XCTAssertEqual(try F.made(created("repo-task"), draft: empty, name: "T").toast, "T started — it will open a PR")
        XCTAssertEqual(try F.made(created("repo-task"), draft: with(empty) { $0.then = .untilMerged }, name: "T").toast, "T started — it will work the PR until it merges")
        XCTAssertEqual(try F.made(created("repo-blueprint"), draft: empty, name: "T").destination, .blueprint("id1"))
        XCTAssertEqual(try F.made(created("local-blueprint"), draft: empty, name: "A").destination, .localBlueprint("id1"))
        XCTAssertEqual(try F.made(created("local-terminal"), draft: empty, name: "S").destination, .localTerminal("id1"))
        XCTAssertEqual(try F.made(created("local-terminal"), draft: empty, name: "S").toast, "S opened")
        XCTAssertEqual(try F.made(created("pod-session"), draft: empty, name: "S").destination, .podSession("id1"))
        XCTAssertEqual(try F.made(created("persistent-agent"), draft: empty, name: "Bot").destination, .agent("id1"))
        XCTAssertEqual(try F.made(created("persistent-agent"), draft: empty, name: "Bot").toast, "Bot created")
        XCTAssertThrowsError(try F.made(created("environment"), draft: empty, name: "E"))
    }

    func testTheMintedSecretIsKeptForSelfSecretTriggersOnly() throws {
        let am = with(empty) { $0.when = .alertmanager; $0.withRepo = false }
        let kept = try F.made(created("standalone", secret: "s3cret", triggerId: "t1"), draft: am, name: "A")
        XCTAssertEqual(kept.secret, F.MintedSecret(type: .alertmanager, triggerId: "t1", secret: "s3cret"))
        // A trigger with no secret (every signed type), or a non-event When: nothing to show.
        XCTAssertNil(try F.made(created("standalone", triggerId: "t1"), draft: am, name: "A").secret)
        let gh = with(empty) { $0.when = .github; $0.withRepo = false }
        XCTAssertNil(try F.made(created("standalone", secret: "s", triggerId: "t1"), draft: gh, name: "A").secret)
        XCTAssertNil(try F.made(created("standalone", secret: "s", triggerId: "t1"), draft: with(empty) { $0.when = .schedule }, name: "A").secret)
    }

    func testWorkCreatedDecodesWithOptionalParts() throws {
        let json = #"{"kind":"standalone","id":"a","href":"/jobs/a","run":{"id":"r","href":"/jobs/a/runs/r"},"trigger":{"id":"t","secret":"s"}}"#
        let full = try JSONDecoder().decode(F.WorkCreated.self, from: Data(json.utf8))
        XCTAssertEqual(full.run?.id, "r")
        XCTAssertEqual(full.trigger?.secret, "s")
        let bare = try JSONDecoder().decode(F.WorkCreated.self, from: Data(#"{"kind":"repo-task","id":"b","href":"/tasks/b"}"#.utf8))
        XCTAssertNil(bare.run)
        XCTAssertNil(bare.trigger)
    }

    func testHookUrlForAMintedSecret() {
        let sheet = TriggerSecretSheet(secret: F.MintedSecret(type: .datadog, triggerId: "t9", secret: "s"), baseURL: URL(string: "https://optio.example.com/")!, onDone: {})
        XCTAssertEqual(sheet.url, "https://optio.example.com/api/hooks/datadog/t9")
    }
}
