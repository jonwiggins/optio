import XCTest
@testable import Optio

/// Remembered agent settings in the New work form (`GET/PUT /api/me/work-defaults`).
final class WorkFormDefaultsTests: XCTestCase {
    private typealias F = WorkForm

    private func provider(_ id: String, agents: [ModelProviderAgent] = [.claudeCode], owner: String? = nil, mine: Bool = false) -> ModelProvider {
        ModelProvider(
            id: id, workspaceId: "w", ownerUserId: owner, ownerName: nil, kind: .bedrock, name: "P \(id)",
            agents: agents, region: "us-west-2",
            models: ModelProviderModels(claudeCode: [ModelProviderModel(id: "us.anthropic.claude-opus-5-5")]),
            localAwsProfile: nil, podCredential: .accessKey, hasPodCredentials: true, mine: mine, canEdit: true,
            createdAt: "", updatedAt: ""
        )
    }

    private let defaults = WorkFormDefaults(runtime: "codex", agentOptions: [
        "codex": ["copilotModel": .string("gpt-5.5"), "codexReasoningEffort": .string("high")],
        "claude-code": ["claudeModel": .string("opus"), "claudeThinking": .bool(true)],
    ])

    func testBlankFormTakesTheSavedRuntimeAndItsOptions() {
        let d = F.applyDefaults(.empty, defaults, providers: [])
        XCTAssertEqual(d.runtime, "codex")
        XCTAssertEqual(d.agentOptions["copilotModel"], .string("gpt-5.5"))
        XCTAssertEqual(d.agentOptions["codexReasoningEffort"], .string("high"))
    }

    func testNothingSavedLeavesTheDraft() {
        XCTAssertEqual(F.applyDefaults(.empty, nil, providers: []), .empty)
        XCTAssertEqual(F.applyDefaults(.empty, WorkFormDefaults(), providers: []), F.normalize(.empty))
    }

    func testRuntimeThatCantRunHereIsSkippedButItsOwnOptionsStillApply() {
        var local = F.Draft.empty
        local.location.runTarget = .local
        local.withRepo = false
        let saved = WorkFormDefaults(runtime: "copilot", agentOptions: ["claude-code": ["claudeModel": .string("sonnet")]])
        let d = F.applyDefaults(local, saved, providers: [])
        XCTAssertEqual(d.runtime, "claude-code", "copilot runs in pods only")
        XCTAssertEqual(d.agentOptions["claudeModel"], .string("sonnet"))
    }

    func testTerminalIsNeverRemembered() {
        var t = F.Draft.empty
        t.runtime = F.terminal
        XCTAssertNil(F.workDefaults(from: t))
        XCTAssertNil(F.savedOptions(WorkFormDefaults(agentOptions: ["": ["x": .string("y")]]), runtime: F.terminal, providers: []))
    }

    func testUnusableProviderIsDroppedWithItsModel() {
        let saved = WorkFormDefaults(agentOptions: ["claude-code": [
            "modelProvider": .string("gone"), "claudeModel": .string("us.anthropic.claude-opus-5-5"), "claudeEffort": .string("max"),
        ]])
        let opts = F.savedOptions(saved, runtime: "claude-code", providers: [provider("theirs", owner: "x")])
        XCTAssertEqual(opts, ["claudeEffort": .string("max")])

        let theirs = WorkFormDefaults(agentOptions: ["claude-code": ["modelProvider": .string("theirs"), "claudeModel": .string("m")]])
        XCTAssertNil(F.savedOptions(theirs, runtime: "claude-code", providers: [provider("theirs", owner: "x")]))
    }

    func testUsableProviderIsKeptAndPersonalOneMakesPodWorkYours() {
        let saved = WorkFormDefaults(runtime: "claude-code", agentOptions: ["claude-code": [
            "modelProvider": .string("mine"), "claudeModel": .string("us.anthropic.claude-opus-5-5"),
        ]])
        let d = F.applyDefaults(.empty, saved, providers: [provider("mine", owner: "me", mine: true)])
        XCTAssertEqual(F.modelProviderId(d), "mine")
        XCTAssertEqual(d.agentOptions["claudeModel"], .string("us.anthropic.claude-opus-5-5"))
        XCTAssertEqual(d.owner, .me)
    }

    func testFreeTextModelIsKept() {
        let saved = WorkFormDefaults(agentOptions: ["claude-code": ["claudeModel": .string("my-custom-model")]])
        XCTAssertEqual(F.savedOptions(saved, runtime: "claude-code", providers: []), ["claudeModel": .string("my-custom-model")])
    }

    func testSubmitRemembersTheRuntimeAndTheOptionsActuallySent() {
        var d = F.Draft.empty
        d.agentOptions = ["claudeModel": .string("opus"), "claudeEffort": .string(""), "claudeThinking": .bool(false)]
        let body = F.workDefaults(from: d)
        XCTAssertEqual(body?.runtime, "claude-code")
        XCTAssertEqual(body?.agentOptions?["claude-code"], ["claudeModel": .string("opus"), "claudeThinking": .bool(false)])
    }

    func testSameOptionsIgnoresBlanks() {
        XCTAssertTrue(F.sameOptions(["a": .string("x"), "b": .string("")], ["a": .string("x")]))
        XCTAssertFalse(F.sameOptions(["a": .string("x")], ["a": .string("y")]))
    }

    @MainActor
    func testStateStartsSwitchedRuntimeFromSavedOptionsUntilTouched() async {
        let state = WorkFormState(api: APIClient())
        state.applySavedDefaults(defaults)
        XCTAssertEqual(state.draft.runtime, "codex")
        XCTAssertTrue(state.lastSettingsShown)

        state.setRuntime("claude-code")
        XCTAssertEqual(state.draft.agentOptions["claudeModel"], .string("opus"))
        state.setOption("claudeModel", .string("sonnet"))
        XCTAssertFalse(state.lastSettingsShown)

        state.setRuntime("codex")
        XCTAssertEqual(state.draft.agentOptions["copilotModel"], .string("gpt-5.5"), "codex untouched: saved")
        state.setRuntime("claude-code")
        XCTAssertNil(state.draft.agentOptions["claudeModel"], "touched runtime starts over")

        state.setRuntime("codex")
        state.resetLastSettings()
        XCTAssertNil(state.draft.agentOptions["copilotModel"])
        XCTAssertFalse(state.lastSettingsShown)
    }

    @MainActor
    func testExampleChipWithBlankOptionsTakesSavedOptionsForItsRuntime() async {
        let state = WorkFormState(api: APIClient())
        state.applySavedDefaults(defaults)
        state.applyPreset("chat")
        XCTAssertEqual(state.draft.runtime, "codex")
        XCTAssertEqual(state.draft.agentOptions["copilotModel"], .string("gpt-5.5"))
        XCTAssertTrue(state.lastSettingsShown)

        // A chip picked before the settings loaded fills its blank options once they arrive.
        let early = WorkFormState(api: APIClient())
        early.applyPreset("schedule")
        early.applySavedDefaults(defaults)
        XCTAssertEqual(early.draft.runtime, "claude-code", "another chip keeps its runtime")
        XCTAssertEqual(early.draft.agentOptions["claudeModel"], .string("opus"))
    }

    @MainActor
    func testResetSticksForTheRuntime() async {
        let state = WorkFormState(api: APIClient())
        state.applySavedDefaults(defaults)
        state.resetLastSettings()
        XCTAssertNil(state.draft.agentOptions["copilotModel"])
        XCTAssertFalse(state.lastSettingsShown)
    }
}
