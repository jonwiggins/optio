import SwiftUI

// Organization and private scope, as the UI shows it — the web's `lib/owner.ts`,
// `OwnerChip`, `OwnerPicker` and `ScopedList` in one file. Every scoped
// resource (secrets, connections, model providers, MCP servers, prompts, work)
// carries `ownerUserId`: nil = the **organization's** (everyone in the workspace
// sees it); set = someone's **private** one, visible to them alone and, read-only,
// to workspace admins, who see it under **Other people's** named with its owner.
//
// One vocabulary everywhere: pickers say Organization / Private, lists are
// sectioned Organization / Private / Other people's, a chip says Private
// (Private · Name for someone else's). Organization rows carry no chip — they
// are the norm.

/// Which scope a row falls in for the viewer.
enum OwnerScope: Hashable, CaseIterable, Sendable {
    case organization
    case `private`
    case others

    var label: String {
        switch self {
        case .organization: return "Organization"
        case .private: return "Private"
        case .others: return "Other people's"
        }
    }

    var systemImage: String {
        switch self {
        case .organization: return "building.2"
        case .private: return "lock"
        case .others: return "person.2"
        }
    }

    /// The scope of a row owned by `ownerUserId` for the viewer.
    ///
    /// The API sends a member only the organization's rows and their own, so for
    /// a member every private row is theirs; only an admin's list holds other
    /// people's, and there the id decides. A missing viewer id (auth disabled, or
    /// `/api/auth/me` not back yet) reads as the viewer's own.
    static func of(ownerUserId: String?, viewerId: String?, isAdmin: Bool) -> OwnerScope {
        guard let ownerUserId, !ownerUserId.isEmpty else { return .organization }
        guard isAdmin, let viewerId, !viewerId.isEmpty else { return .private }
        return ownerUserId == viewerId ? .private : .others
    }

    /// One sentence on what Private means for a kind of resource (the empty Private section's line).
    static func privateHint(_ what: String) -> String {
        "Private \(what) are yours alone: only you see them and only your work can use them."
    }

    static func organizationHint(_ what: String) -> String {
        "No \(what) shared with the organization yet."
    }
}

/// The server's rule on who may change a row, by scope (`services/ownership.ts`):
/// the organization's by whoever the resource's role rule allows (`orgRule`: an
/// admin for most kinds, a member for prompts and work); a private one by its
/// owner alone; someone else's never — except that an admin may delete it, for
/// offboarding.
enum ScopeRules {
    static func canChange(_ scope: OwnerScope, orgRule: Bool) -> Bool {
        switch scope {
        case .organization: return orgRule
        case .private: return true
        case .others: return false
        }
    }

    static func canDelete(_ scope: OwnerScope, orgRule: Bool, isAdmin: Bool) -> Bool {
        switch scope {
        case .organization: return orgRule
        case .private: return true
        case .others: return isAdmin
        }
    }
}

/// One scope's rows, in list order.
struct ScopeSection<Row> {
    let scope: OwnerScope
    let rows: [Row]
}

/// Rows grouped by scope: the organization's, the viewer's private ones and —
/// only ever for an admin — other people's.
struct ScopeGroups<Row> {
    var organization: [Row] = []
    var `private`: [Row] = []
    var others: [Row] = []

    var isEmpty: Bool { organization.isEmpty && `private`.isEmpty && others.isEmpty }
    var count: Int { organization.count + `private`.count + others.count }

    subscript(scope: OwnerScope) -> [Row] {
        switch scope {
        case .organization: return organization
        case .private: return `private`
        case .others: return others
        }
    }

    /// Sections in display order: Organization and Private always (an empty one
    /// says what the scope means here), Other people's only when there are any.
    var sections: [ScopeSection<Row>] {
        var out = [ScopeSection(scope: .organization, rows: organization), ScopeSection(scope: .private, rows: `private`)]
        if !others.isEmpty { out.append(ScopeSection(scope: .others, rows: others)) }
        return out
    }

    /// Group `rows` by whose they are: `owner` reads a row's `ownerUserId`,
    /// `viewerId` is the signed-in user and `isAdmin` whether they may be
    /// looking at other people's rows at all (see `OwnerScope.of`).
    static func group(_ rows: [Row], viewerId: String?, isAdmin: Bool, owner: (Row) -> String?) -> ScopeGroups<Row> {
        group(rows) { OwnerScope.of(ownerUserId: owner($0), viewerId: viewerId, isAdmin: isAdmin) }
    }

    /// Group rows that already know their scope (model providers carry `mine`).
    static func group(_ rows: [Row], scopeOf: (Row) -> OwnerScope) -> ScopeGroups<Row> {
        var out = ScopeGroups<Row>()
        for row in rows {
            switch scopeOf(row) {
            case .organization: out.organization.append(row)
            case .private: out.private.append(row)
            case .others: out.others.append(row)
            }
        }
        return out
    }
}

// MARK: - Views

/// The one chip for a private row: **Private** for the viewer's own, **Private ·
/// Name** for someone else's (what an admin sees). Nothing for the
/// organization's. For rows of different scopes that mix without sections: the
/// Work list, pickers, detail headers.
struct PrivateTag: View {
    let scope: OwnerScope
    var ownerName: String? = nil

    init(scope: OwnerScope, ownerName: String? = nil) {
        self.scope = scope
        self.ownerName = ownerName
    }

    init(ownerUserId: String?, ownerName: String?, viewerId: String?, isAdmin: Bool) {
        self.init(scope: OwnerScope.of(ownerUserId: ownerUserId, viewerId: viewerId, isAdmin: isAdmin), ownerName: ownerName)
    }

    /// The chip's text, or nil for an organization row.
    var text: String? {
        switch scope {
        case .organization: return nil
        case .private: return "Private"
        case .others: return "Private · \(ownerName ?? "someone")"
        }
    }

    var body: some View {
        if let text {
            let other = scope == .others
            Label(text, systemImage: "lock")
                .font(.caption2.weight(.medium))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(other ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(AppTheme.accent.opacity(0.12)), in: Capsule())
                .foregroundStyle(other ? AnyShapeStyle(.secondary) : AnyShapeStyle(AppTheme.accent))
                .lineLimit(1)
                .fixedSize()
                .accessibilityLabel(other ? "\(ownerName ?? "Someone")'s private" : "Private")
        }
    }
}

/// `groups` as `List` sections: Organization, Private (an empty one says what
/// private means here) and, for an admin with any, Other people's. `row` gets
/// each row with its scope so it can decide its own swipe actions; `footer`
/// may add a line under a section.
struct ScopedSections<Row, ID: Hashable, Content: View>: View {
    let groups: ScopeGroups<Row>
    let id: KeyPath<Row, ID>
    /// The resource, plural, for the empty lines ("secrets").
    let what: String
    var footer: (OwnerScope) -> String? = { _ in nil }
    @ViewBuilder let row: (Row, OwnerScope) -> Content

    var body: some View {
        ForEach(groups.sections, id: \.scope) { section in
            Section {
                if section.rows.isEmpty {
                    Text(section.scope == .private ? OwnerScope.privateHint(what) : OwnerScope.organizationHint(what))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(section.rows, id: id) { row($0, section.scope) }
                }
            } header: {
                Label(section.scope.label, systemImage: section.scope.systemImage)
            } footer: {
                if let text = footer(section.scope) { Text(text) }
            }
        }
    }
}

/// The Owner row a create / edit form shows: **Organization** or **Private**.
/// When the organization's needs an admin the viewer isn't, the choice is
/// locked on Private; `hint` is the one helper sentence for the section footer.
struct OwnerPicker: View {
    @Binding var owner: ResourceOwner
    /// The resource, singular, for the helper sentence ("secret").
    let what: String
    /// Whether the viewer may make the organization's.
    var canOrg = true
    var orgHint: String? = nil
    var privateHint: String? = nil

    var body: some View {
        Picker("Owner", selection: $owner) {
            Label("Organization", systemImage: OwnerScope.organization.systemImage).tag(ResourceOwner.workspace)
            Label("Private", systemImage: OwnerScope.private.systemImage).tag(ResourceOwner.me)
        }
        .disabled(!canOrg)
    }

    var hint: String {
        Self.hint(owner: owner, what: what, canOrg: canOrg, orgHint: orgHint, privateHint: privateHint)
    }

    static func hint(owner: ResourceOwner, what: String, canOrg: Bool = true, orgHint: String? = nil, privateHint: String? = nil) -> String {
        if !canOrg { return "Only an admin can make a \(what) the organization's." }
        if owner == .me {
            return privateHint ?? "Only you see this \(what), and only your work can use it. Admins see that it exists."
        }
        return orgHint ?? "Everyone in the workspace sees and can use this \(what)."
    }
}
