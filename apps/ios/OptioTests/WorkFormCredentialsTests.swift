import XCTest
@testable import Optio

/// Agent credentials in the work form: the "Signed in with" pick.
final class WorkFormCredentialsTests: XCTestCase {
    private typealias F = WorkForm

    private let secretId = "11111111-1111-1111-1111-111111111111"
    private let mineId = "22222222-2222-2222-2222-222222222222"

    private func secret(_ id: String, owner: ResourceOwner = .workspace, isDefault: Bool = false,
                        name: String = "ANTHROPIC_API_KEY", kind: AgentCredentialKind = .secret) -> AgentCredential {
        AgentCredential(
            id: "secret:\(id)", kind: kind, method: .apiKey, label: "Anthropic API key", secretName: name,
            owner: owner, ownerUserId: owner == .me ? "me" : nil, default: isDefault
        )
    }

    private func provider(_ id: String, owner: String? = nil, mine: Bool = false) -> ModelProvider {
        ModelProvider(
            id: id, workspaceId: "w", ownerUserId: owner, ownerName: nil, kind: .bedrock, name: "P \(id)",
            agents: [.claudeCode], region: "us-west-2",
            models: ModelProviderModels(claudeCode: [ModelProviderModel(id: "us.anthropic.claude-opus-5-5", label: "Opus 5.5")]),
            localAwsProfile: nil, podCredential: .accessKey, hasPodCredentials: true, mine: mine, canEdit: true,
            createdAt: "", updatedAt: ""
        )
    }

    private func providerCredential(_ p: ModelProvider) -> AgentCredential {
        AgentCredential(
            id: "provider:\(p.id)", kind: .provider, method: .bedrock, label: "Amazon Bedrock · \(p.name)",
            providerId: p.id, owner: p.ownerUserId == nil ? .workspace : .me, ownerUserId: p.ownerUserId, default: false
        )
    }

    private func local(_ d: F.Draft) -> F.Draft {
        var d = d
        d.location.runTarget = .local
        d.location.localHostId = "h1"
        d.location.localDir = "/Users/dev/repos/app"
        return d
    }

    func testSecretPickSetsCredentialAndDropsTheProvider() {
        let p = provider("org")
        var d = F.pickProvider(F.Draft.empty, p)
        XCTAssertEqual(F.modelProviderId(d), "org")
        d = F.pickCredential(d, secret(secretId), providers: [p])
        XCTAssertEqual(F.credentialId(d), "secret:\(secretId)")
        XCTAssertNil(F.modelProviderId(d))
        XCTAssertEqual(d.owner, .workspace)
        XCTAssertEqual(F.setOptions(d)?["credential"]?.stringValue, "secret:\(secretId)")
    }

    func testPrivateSecretMakesTheWorkYours() {
        let d = F.pickCredential(F.Draft.empty, secret(mineId, owner: .me), providers: [])
        XCTAssertEqual(d.owner, .me)
        XCTAssertEqual(F.credentialId(d), "secret:\(mineId)")
    }

    func testProviderEntryIsTodaysProviderPick() {
        let p = provider("mine", owner: "me", mine: true)
        var d = F.pickCredential(F.Draft.empty, secret(secretId), providers: [p])
        d = F.pickCredential(d, providerCredential(p), providers: [p])
        XCTAssertEqual(F.modelProviderId(d), "mine")
        XCTAssertNil(F.credentialId(d))
        XCTAssertEqual(d.agentOptions["claudeModel"]?.stringValue, "us.anthropic.claude-opus-5-5")
        XCTAssertEqual(d.owner, .me)
        // A provider the list no longer has is a no-op.
        let unchanged = F.pickCredential(d, providerCredential(provider("gone")), providers: [p])
        XCTAssertEqual(F.modelProviderId(unchanged), "mine")
    }

    func testDefaultClearsBoth() {
        let p = provider("org")
        var d = F.pickCredential(F.Draft.empty, providerCredential(p), providers: [p])
        d = F.pickCredential(d, nil, providers: [p])
        XCTAssertNil(F.modelProviderId(d))
        XCTAssertNil(F.credentialId(d))
        d = F.pickCredential(d, secret(secretId), providers: [p])
        d = F.pickCredential(d, nil, providers: [p])
        XCTAssertNil(F.credentialId(d))
        XCTAssertNil(F.setOptions(d)?["credential"])
    }

    func testPickedCredentialResolvesSecretsAndProviders() {
        let p = provider("org")
        let list = [secret(secretId), secret(mineId, owner: .me), providerCredential(p)]
        XCTAssertNil(F.pickedCredential(F.Draft.empty, list))
        let s = F.pickCredential(F.Draft.empty, secret(mineId, owner: .me), providers: [p])
        XCTAssertEqual(F.pickedCredential(s, list)?.id, "secret:\(mineId)")
        let pr = F.pickProvider(F.Draft.empty, p)
        XCTAssertEqual(F.pickedCredential(pr, list)?.id, "provider:org")
        // A stale id resolves to nothing (the state then drops it).
        var stale = F.Draft.empty
        stale.agentOptions["credential"] = .string("secret:33333333-3333-3333-3333-333333333333")
        XCTAssertNil(F.pickedCredential(stale, list))
    }

    func testOrganizationOwnerDropsAPrivateCredentialOnly() {
        let list = [secret(secretId), secret(mineId, owner: .me)]
        let mine = F.pickCredential(F.Draft.empty, secret(mineId, owner: .me), providers: [])
        let org = F.setOwner(mine, .workspace, providers: [], secrets: [], credentials: list)
        XCTAssertEqual(org.owner, .workspace)
        XCTAssertNil(F.credentialId(org))
        let theirs = F.pickCredential(F.Draft.empty, secret(secretId), providers: [])
        let still = F.setOwner(theirs, .workspace, providers: [], secrets: [], credentials: list)
        XCTAssertEqual(F.credentialId(still), "secret:\(secretId)")
        // Unknown to the list (not loaded yet): left alone.
        let unknown = F.setOwner(mine, .workspace, providers: [], secrets: [], credentials: [])
        XCTAssertEqual(F.credentialId(unknown), "secret:\(mineId)")
    }

    func testRowShowsForPodAgentWorkOnly() {
        XCTAssertTrue(F.showsCredentials(F.Draft.empty))
        var terminal = F.Draft.empty
        terminal.runtime = F.terminal
        XCTAssertFalse(F.showsCredentials(terminal))
        XCTAssertFalse(F.showsCredentials(local(F.Draft.empty)))
    }

    func testSecretIdParsing() {
        XCTAssertEqual(F.secretIdFromCredential("secret:\(secretId)"), secretId)
        XCTAssertEqual(F.secretIdFromCredential(" SECRET:\(secretId) "), secretId)
        XCTAssertNil(F.secretIdFromCredential("provider:\(secretId)"))
        XCTAssertNil(F.secretIdFromCredential("secret:nope"))
        XCTAssertNil(F.secretIdFromCredential(nil))
    }

    func testTagsAndUsableList() {
        XCTAssertEqual(F.credentialTag(secret(secretId, owner: .me, isDefault: true)), "Private · default")
        XCTAssertEqual(F.credentialTag(secret(secretId)), "Organization")
        let unknownKind = secret("44444444-4444-4444-4444-444444444444", kind: .unknown)
        XCTAssertEqual(F.usableCredentials([secret(secretId), unknownKind]).map(\.id), ["secret:\(secretId)"])
    }
}
