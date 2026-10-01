import XCTest
@testable import Optio

/// Model providers, owner, and pod secrets in the work form.
final class WorkFormProvidersTests: XCTestCase {
    private typealias F = WorkForm

    private func provider(_ id: String, agents: [ModelProviderAgent] = [.claudeCode], owner: String? = nil, mine: Bool = false,
                          pod: ModelProviderPodCredential = .accessKey, profile: String? = nil) -> ModelProvider {
        ModelProvider(
            id: id, workspaceId: "w", ownerUserId: owner, ownerName: nil, kind: .bedrock, name: "P \(id)",
            agents: agents, region: "us-west-2",
            models: ModelProviderModels(claudeCode: [ModelProviderModel(id: "us.anthropic.claude-opus-5-5", label: "Opus 5.5"), ModelProviderModel(id: "us.anthropic.claude-sonnet-5")]),
            localAwsProfile: profile, podCredential: pod, hasPodCredentials: true, mine: mine, canEdit: true,
            createdAt: "", updatedAt: ""
        )
    }

    private func host(providers: Bool?, profiles: [String]? = nil) -> LocalHost? {
        let json = """
        {"id":"h1","userId":"u","workspaceId":null,"name":"mac","hostname":"mac.local","platform":"darwin","dirs":[],"state":"online","lastSeenAt":null,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"\(providers.map { ",\"modelProviders\":\($0)" } ?? "")\(profiles.map { ",\"awsProfiles\":[\($0.map { "\"\($0)\"" }.joined(separator: ","))]" } ?? "")}
        """
        return try? JSONDecoder().decode(LocalHost.self, from: Data(json.utf8))
    }

    func testUsableProvidersServeTheRuntimeAndSkipOthersPersonal() {
        let list = [provider("org"), provider("mine", owner: "me", mine: true), provider("theirs", owner: "x"), provider("codex", agents: [.codex])]
        XCTAssertEqual(F.usableProviders(list, runtime: "claude-code").map(\.id), ["org", "mine"])
        XCTAssertEqual(F.usableProviders(list, runtime: "codex").map(\.id), ["codex"])
        XCTAssertTrue(F.usableProviders(list, runtime: "gemini").isEmpty)
    }

    func testPickProviderSwapsModelAndOwner() {
        var d = F.Draft.empty
        d = F.pickProvider(d, provider("mine", owner: "me", mine: true))
        XCTAssertEqual(F.modelProviderId(d), "mine")
        XCTAssertEqual(d.agentOptions["claudeModel"]?.stringValue, "us.anthropic.claude-opus-5-5")
        XCTAssertEqual(d.owner, .me)
        d = F.pickProvider(d, nil)
        XCTAssertNil(F.modelProviderId(d))
        XCTAssertEqual(d.agentOptions["claudeModel"]?.stringValue, "")
        XCTAssertNil(F.setOptions(d)?["modelProvider"])
    }

    func testOrgOwnerDropsPersonalPicks() {
        let mine = provider("mine", owner: "me", mine: true)
        var d = F.pickProvider(F.Draft.empty, mine)
        d.podSecrets = ["ORG_KEY", "MY_KEY"]
        let secrets = [PickableSecret(name: "ORG_KEY", owner: .workspace), PickableSecret(name: "MY_KEY", owner: .me)]
        let org = F.setOwner(d, .workspace, providers: [mine], secrets: secrets)
        XCTAssertNil(F.modelProviderId(org))
        XCTAssertEqual(org.podSecrets, ["ORG_KEY"])
        XCTAssertEqual(F.pickableSecrets(secrets, owner: .workspace, picked: []).map(\.name), ["ORG_KEY"])
        XCTAssertEqual(F.pickableSecrets(secrets, owner: .me, picked: ["ORG_KEY"]).map(\.name), ["MY_KEY"])
    }

    func testDisabledReasons() {
        var pod = F.Draft.empty
        pod.location.runTarget = .cluster
        XCTAssertEqual(F.providerDisabled(provider("a", pod: .none), pod, host: nil), "Machines only")
        XCTAssertNil(F.providerDisabled(provider("a"), pod, host: nil))

        var local = F.Draft.empty
        local.location.runTarget = .local
        XCTAssertEqual(F.providerDisabled(provider("a", pod: .none), local, host: host(providers: false)), "Update Optio Local on mac to use model providers")
        XCTAssertEqual(F.providerDisabled(provider("a", profile: "work"), local, host: host(providers: true, profiles: ["default"])), "AWS profile work isn't on mac")
        XCTAssertNil(F.providerDisabled(provider("a", profile: "work"), local, host: host(providers: true, profiles: ["work"])))
    }

    func testAccessPayload() {
        var d = F.Draft.empty
        d.prompt = "p"
        d.podSecrets = ["A"]
        XCTAssertEqual(F.accessPayload(d)["owner"], .string("workspace"))
        XCTAssertEqual(F.accessPayload(d)["podSecrets"], .array([.string("A")]))
        d.location.runTarget = .local
        XCTAssertEqual(F.accessPayload(d)["owner"], .string("me"))
        XCTAssertNil(F.accessPayload(d)["podSecrets"])
    }

    func testBedrockDefaults() {
        XCTAssertTrue(F.isValidAwsRegion("us-west-2"))
        XCTAssertFalse(F.isValidAwsRegion("uswest2"))
        XCTAssertEqual(F.bedrockDefaultModels(.claudeCode, region: "eu-west-1").first?.id, "eu.anthropic.claude-opus-5-5")
    }
}
