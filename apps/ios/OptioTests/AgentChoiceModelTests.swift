import XCTest
@testable import Optio

/// Mirrors `apps/web/src/components/agent-choice-model.test.ts` (repo columns ↔
/// picker keys), the repo-default precedence in the web's work-form model, and
/// the per-model effort narrowing of `optionChoicesFor`.
final class AgentChoiceModelTests: XCTestCase {
    private typealias F = WorkForm

    private func repo(_ over: [String: AnyCodable] = [:]) -> [String: AnyCodable] {
        var r: [String: AnyCodable] = ["defaultAgentType": .string("claude-code")]
        for (k, v) in F.repoFactoryOptions { r[k] = v.anyCodable }
        r["copilotModel"] = .null
        r["opencodeBaseUrl"] = .null
        return r.merging(over) { _, b in b }
    }

    private func encode(_ input: RepoUpdateInput) throws -> [String: Any] {
        let data = try JSONEncoder().encode(input)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    // MARK: picker keys are repo columns

    func testSeedsARuntimesPickerFromTheRepoRow() {
        let r = repo(["claudeModel": .string("sonnet"), "geminiModel": .string("gemini-2.5-flash")])
        XCTAssertEqual(F.optionsFromRepo(runtime: "claude-code", repo: r),
                       ["claudeModel": .string("sonnet"), "claudeContextWindow": .string("1m"), "claudeEffort": .string("high")])
        XCTAssertEqual(F.optionsFromRepo(runtime: "copilot", repo: r), [:])
        XCTAssertEqual(F.optionsFromRepo(runtime: "codex", repo: repo(["copilotModel": .string("gpt-5")])), [:])
        XCTAssertEqual(F.optionsFromRepo(runtime: "claude-code", repo: nil), [:])
    }

    func testReadsEveryAgentColumnNullsAsTheColumnDefault() {
        let v = F.repoAgentValues(["claudeModel": .string("sonnet"), "claudeEffort": .null, "cursorModel": .string("auto")])
        XCTAssertEqual(v["claudeModel"], .string("sonnet"))
        XCTAssertEqual(v["claudeEffort"], .string("high"))
        XCTAssertEqual(v["cursorModel"], .string("auto"))
        XCTAssertEqual(v["geminiApprovalMode"], .string("yolo"))
    }

    func testRepoRowAgentColumnsRoundTrip() {
        var row = RepoRow(id: "r1")
        row.defaultAgentType = "gemini"
        row.geminiModel = "gemini-2.5-flash"
        row.opencodeBaseUrl = nil
        XCTAssertEqual(row.agentColumns, ["defaultAgentType": .string("gemini"), "geminiModel": .string("gemini-2.5-flash")])
        XCTAssertEqual(F.repoRuntime(row.agentColumns), "gemini")
    }

    func testWritesThePatchBodyTheSettingsPageAlwaysSent() throws {
        var values = F.repoFactoryOptions
        values["claudeEffort"] = .string("")
        values["copilotModel"] = .string("")
        values["opencodeBaseUrl"] = .string("")
        values["claudePermissionMode"] = .string("plan")
        let patch = F.repoAgentPatch(runtime: "gemini", values: values)
        XCTAssertEqual(patch["defaultAgentType"], .string("gemini"))
        XCTAssertEqual(patch["claudeModel"], .string("opus"))
        XCTAssertEqual(patch["claudeEffort"], .string(""))
        XCTAssertNil(patch["claudeThinking"])
        XCTAssertNil(patch["copilotModel"])
        XCTAssertEqual(patch["opencodeBaseUrl"], .null)
        XCTAssertNil(patch["claudePermissionMode"])

        // Merged into the one PATCH object with the other settings.
        var input = RepoUpdateInput()
        input.maxTurnsCoding = 100
        input.reviewAgentType = .null
        input.agent = patch
        let json = try encode(input)
        XCTAssertEqual(json["maxTurnsCoding"] as? Int, 100)
        XCTAssertEqual(json["defaultAgentType"] as? String, "gemini")
        XCTAssertEqual(json["geminiApprovalMode"] as? String, "yolo")
        XCTAssertTrue(json["opencodeBaseUrl"] is NSNull)
        XCTAssertTrue(json["reviewAgentType"] is NSNull)
        XCTAssertNil(json["claudeThinking"])
        XCTAssertNil(json["defaultBranch"])
    }

    func testTellsAConfiguredRepoFromOneAtTheColumnDefaults() {
        XCTAssertFalse(F.repoHasOwnOptions("claude-code", repo: repo()))
        XCTAssertTrue(F.repoHasOwnOptions("claude-code", repo: repo(["claudeEffort": .string("max")])))
        XCTAssertNil(F.repoOwnRuntime(repo()))
        XCTAssertEqual(F.repoOwnRuntime(repo(["claudeModel": .string("sonnet")])), "claude-code")
        XCTAssertEqual(F.repoOwnRuntime(repo(["defaultAgentType": .string("gemini")])), "gemini")
        XCTAssertNil(F.repoOwnRuntime(repo(["defaultAgentType": .string("nope")])))
    }

    func testSummarizesAsRuntimeModelEffort() {
        XCTAssertEqual(F.agentSummary(runtime: "claude-code", values: ["claudeModel": .string("opus"), "claudeEffort": .string("high")]), "Claude Code · opus · high")
        XCTAssertEqual(F.agentSummary(runtime: "codex", values: ["copilotModel": .string("gpt-5")]), "OpenAI Codex")
        XCTAssertEqual(F.agentSummary(runtime: F.terminal, values: [:]), "")
    }

    // MARK: repo defaults in the New work form

    private let saved: F.AgentOptions = ["claudeModel": .string("sonnet"), "claudeEffort": .string("low")]

    func testFactoryRepoDoesNotOverrideYourLastSettings() {
        var d = F.Draft.empty
        d.agentOptions = saved
        XCTAssertEqual(F.withRepoDefaults(d, repo: repo()), d)
        let start = F.startingOptions(.empty, runtime: "claude-code", repo: repo(), saved: saved)
        XCTAssertEqual(start.from, .saved)
        XCTAssertEqual(start.options, saved)
        // With nothing saved, the repo's column defaults show.
        XCTAssertEqual(F.startingOptions(.empty, runtime: "claude-code", repo: repo(), saved: nil).from, .repo)
    }

    func testARepoWithItsOwnDefaultsWinsForPodWork() {
        var d = F.Draft.empty
        d.agentOptions = saved
        let own = repo(["defaultAgentType": .string("gemini"), "geminiModel": .string("gemini-2.5-flash")])
        let next = F.withRepoDefaults(d, repo: own)
        XCTAssertEqual(next.runtime, "gemini")
        XCTAssertEqual(next.agentOptions, ["geminiModel": .string("gemini-2.5-flash"), "geminiApprovalMode": .string("yolo")])
        XCTAssertTrue(F.matchesRepoDefaults(next, repo: own))

        let max = repo(["claudeEffort": .string("max")])
        XCTAssertEqual(F.startingOptions(.empty, runtime: "claude-code", repo: max, saved: saved).options["claudeEffort"], .string("max"))

        // Not on a machine: the repo's columns are pod settings.
        var local = d
        local.location.runTarget = .local
        XCTAssertEqual(F.withRepoDefaults(local, repo: own), local)
    }

    func testResetGoesBackToTheReposAgentAndParameters() {
        let own = repo(["defaultAgentType": .string("gemini")])
        var d = F.Draft.empty
        d.agentOptions = saved
        XCTAssertFalse(F.matchesRepoDefaults(d, repo: own))
        let reset = F.resetToRepoDefaults(d, repo: own)
        XCTAssertEqual(reset.runtime, "gemini")
        XCTAssertTrue(F.matchesRepoDefaults(reset, repo: own))
    }

    // MARK: per-model effort

    private func catalog() throws -> ProviderCatalog {
        let json = """
        {"provider":"anthropic","label":"Claude Code","modelField":"claudeModel",
         "aliases":{"opus":"claude-opus-4-8","haiku":"claude-haiku-4-5"},
         "models":[
           {"id":"claude-opus-4-8","label":"Opus 4.8","family":"opus","efforts":["low","medium","high","xhigh","max"]},
           {"id":"claude-sonnet-4-6","label":"Sonnet 4.6","family":"sonnet","efforts":["low","medium","high","max"]},
           {"id":"claude-haiku-4-5","label":"Haiku 4.5","family":"haiku","efforts":[]},
           {"id":"claude-legacy","label":"Legacy","family":"legacy"}
         ],
         "options":[
           {"key":"claudeContextWindow","label":"Context","kind":"select","choices":[{"value":"1m","label":"1M"}]},
           {"key":"claudeEffort","label":"Effort Level","kind":"select","default":"high","modelEfforts":true,
            "choices":[{"value":"low","label":"Low"},{"value":"medium","label":"Medium"},{"value":"high","label":"High"},
                       {"value":"xhigh","label":"Extra high"},{"value":"max","label":"Max"}]}
         ]}
        """
        return try JSONDecoder().decode(ProviderCatalog.self, from: Data(json.utf8))
    }

    func testEffortNarrowsToTheSelectedModels() throws {
        let c = try catalog()
        let effort = c.options[1]
        XCTAssertEqual(ProviderCatalog.choices(for: effort, model: c.model(named: "opus")).map(\.value), ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(ProviderCatalog.choices(for: effort, model: c.model(named: "claude-sonnet-4-6")).map(\.label), ["Low", "Medium", "High", "Max"])
        // An empty list: the model takes no effort, so the field hides.
        XCTAssertEqual(ProviderCatalog.choices(for: effort, model: c.model(named: "haiku")), [])
        // No list, or no model: the field's own choices.
        XCTAssertEqual(ProviderCatalog.choices(for: effort, model: c.model(named: "claude-legacy")).count, 5)
        XCTAssertEqual(ProviderCatalog.choices(for: effort, model: nil).count, 5)
        // Other fields never narrow.
        XCTAssertEqual(ProviderCatalog.choices(for: c.options[0], model: c.model(named: "haiku")).map(\.value), ["1m"])
    }

    func testAnUnknownEffortIsLabelledByItsValue() throws {
        let c = try catalog()
        let model = ProviderCatalog.Model(id: "m", label: "M", family: nil, latest: nil, preview: nil, source: nil, efforts: ["low", "ultra"])
        XCTAssertEqual(ProviderCatalog.choices(for: c.options[1], model: model).map(\.label), ["Low", "Ultra"])
    }

    func testChangingToAModelWithoutTheEffortResetsIt() throws {
        let c = try catalog()
        let values: F.AgentOptions = ["claudeModel": .string("opus"), "claudeEffort": .string("xhigh")]
        XCTAssertEqual(c.keysToReset(values, newModel: "claude-sonnet-4-6"), ["claudeEffort"])
        XCTAssertEqual(c.keysToReset(values, newModel: "claude-haiku-4-5"), ["claudeEffort"])
        XCTAssertEqual(c.keysToReset(["claudeEffort": .string("high")], newModel: "claude-sonnet-4-6"), [])
        XCTAssertEqual(c.keysToReset(["claudeEffort": .string("")], newModel: "haiku"), [])
        XCTAssertEqual(c.keysToReset(values, newModel: "claude-legacy"), [])
        XCTAssertEqual(c.keysToReset(values, newModel: ""), [])
    }
}
