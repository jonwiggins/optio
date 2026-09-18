import SwiftUI

/// Reviews list — mirrors `/reviews` (PrBrowser): open PRs across connected
/// repos with their review state/verdict, a "paste a PR URL" launcher, repo
/// filter, and per-PR "Review with Optio" / "Approve & Merge" as swipe actions.
/// Rows push: a review detail when one exists, otherwise a PR summary with the
/// review launcher. Embedded by the Run hub inside its NavigationStack.
struct ReviewsListView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.openURL) private var openURL
    @State private var model = ReviewsListModel()
    @State private var prUrl = ""
    @State private var stateFilter = ""
    @State private var repoFilter = ""
    @State private var mergeTarget: PullRequestSummary?
    @State private var pushed: ReviewRoute?

    private static let stateOptions: [(String, String)] = [
        ("", "All"),
        ("unreviewed", "Unreviewed"),
        ("queued", "Queued"),
        ("waiting_ci", "Waiting CI"),
        ("reviewing", "Reviewing"),
        ("ready", "Ready"),
        ("stale", "Stale"),
        ("submitted", "Submitted"),
        ("failed", "Failed"),
    ]

    private var filtered: [PullRequestSummary] {
        model.prs.filter { pr in
            switch stateFilter {
            case "": return true
            case "unreviewed": return pr.review == nil
            default: return pr.review?.state == stateFilter
            }
        }
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: Spacing.s) {
                    Image(systemName: "link").foregroundStyle(.tertiary)
                    TextField("Paste a PR URL to review", text: $prUrl)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .onSubmit { launchFromURL() }
                    Button {
                        launchFromURL()
                    } label: {
                        Group {
                            if model.launchingURL { ProgressView().tint(.white) } else { Image(systemName: "arrow.up").font(.body.weight(.semibold)) }
                        }
                        .frame(width: 30, height: 30)
                        .foregroundStyle(.white)
                        .background(prUrl.trimmingCharacters(in: .whitespaces).isEmpty ? Color(.tertiaryLabel) : AppTheme.accent, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.launchingURL || prUrl.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityLabel("Review")
                }
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, 6)
                .background(.fill.tertiary, in: Capsule())
                .listRowInsets(EdgeInsets(top: Spacing.xs, leading: Spacing.l, bottom: Spacing.xs, trailing: Spacing.l))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            Section {
                ChipPicker(options: Self.stateOptions, selection: $stateFilter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }

            if let error = model.error, model.prs.isEmpty {
                ErrorRow(error: error, what: "pull requests") { Task { await model.load(api, repoId: repoFilter) } }
            } else if !model.loaded {
                SkeletonRows()
            } else if filtered.isEmpty {
                EmptyState(
                    title: model.prs.isEmpty ? "No open pull requests" : "No \(Self.stateOptions.first { $0.0 == stateFilter }?.1.lowercased() ?? "matching") PRs",
                    systemImage: "arrow.triangle.pull",
                    message: model.repos.isEmpty ? "Add a repo first under More › Repos." : (model.prs.isEmpty ? "Pull requests from your repos appear here." : "Nothing matches this filter.")
                )
                .listRowSeparator(.hidden)
            } else {
                ForEach(filtered) { pr in
                    NavigationLink(value: pr.review.map { ReviewRoute.detail($0.id) } ?? ReviewRoute.pullRequest(pr)) {
                        PullRequestRow(pr: pr, busy: model.reviewingURL == pr.url || model.mergingURL == pr.url)
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        if pr.review == nil {
                            Button("Review", systemImage: "eye") {
                                Task { if let id = await model.launchReview(prUrl: pr.url, api: api) { pushed = .detail(id) } }
                            }.tint(AppTheme.accent)
                        } else if pr.review?.canReReview == true {
                            Button("Re-review", systemImage: "arrow.clockwise") {
                                Task { if let id = await model.launchReview(prUrl: pr.url, api: api) { pushed = .detail(id) } }
                            }.tint(.primary)
                        }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Merge", systemImage: "arrow.triangle.merge") { mergeTarget = pr }.tint(.primary)
                        if let url = URL(string: pr.url) {
                            Button("Open", systemImage: "safari") { openURL(url) }.tint(Color(.systemGray))
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .animation(.snappy, value: stateFilter)
        .toolbar {
            if model.repos.count > 1 {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Repo", selection: $repoFilter) {
                            Text("All repos").tag("")
                            ForEach(model.repos) { Text($0.fullName ?? $0.id).tag($0.id) }
                        }
                    } label: { Image(systemName: "line.3.horizontal.decrease") }
                }
            }
        }
        .onChange(of: repoFilter) { _, _ in Task { await model.load(api, repoId: repoFilter) } }
        .refreshable { await model.load(api, repoId: repoFilter) }
        .task { await model.load(api, repoId: repoFilter) }
        .confirmationDialog(
            "Approve and merge PR #\(mergeTarget?.number ?? 0)? This skips agent review.",
            isPresented: Binding(get: { mergeTarget != nil }, set: { if !$0 { mergeTarget = nil } }),
            titleVisibility: .visible
        ) {
            Button("Approve & squash-merge", role: .destructive) {
                if let pr = mergeTarget { Task { await model.approveAndMerge(pr, api: api, repoId: repoFilter) } }
            }
        }
        .errorToast(Binding(get: { model.actionError }, set: { model.actionError = $0 }))
        .toast(model.toast, tone: .success) { model.toast = nil }
        .navigationDestination(item: $pushed) { route in
            switch route {
            case .detail(let id): ReviewDetailView(reviewId: id)
            case .pullRequest(let pr): PullRequestSummaryView(pr: pr)
            }
        }
        .navigationDestination(for: ReviewRoute.self) { route in
            switch route {
            case .detail(let id): ReviewDetailView(reviewId: id)
            case .pullRequest(let pr): PullRequestSummaryView(pr: pr)
            }
        }
    }

    private func launchFromURL() {
        let url = prUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return }
        Task {
            if let id = await model.launchReview(prUrl: url, api: api, fromURLField: true) {
                prUrl = ""
                pushed = .detail(id)
            }
        }
    }
}

extension PullRequestSummary.EmbeddedReview {
    var canReReview: Bool { ["ready", "stale", "submitted", "failed"].contains(state ?? "") }
}

enum ReviewRoute: Hashable, Identifiable {
    case detail(String)
    case pullRequest(PullRequestSummary)
    var id: String {
        switch self {
        case .detail(let id): return id
        case .pullRequest(let pr): return pr.id
        }
    }
}

/// `dot · title · #n · repo · author · 2h` with one trailing verdict or state.
struct PullRequestRow: View {
    let pr: PullRequestSummary
    var busy = false

    private var tone: Tone? {
        guard let s = pr.review?.state else { return pr.draft == true ? .idle : nil }
        return ReviewFormat.stateTone(s)
    }

    private var trailing: (String, Tone?) {
        if busy { return ("Working…", .working) }
        if let v = pr.review?.verdict { return (ReviewFormat.verdictLabel(v), ReviewFormat.verdictTone(v)) }
        if let s = pr.review?.state { return (ReviewFormat.stateLabel(s), ReviewFormat.stateTone(s) == .accent ? .accent : nil) }
        if pr.draft == true { return ("Draft", nil) }
        return (pr.updatedAt?.relativeDescription ?? "", nil)
    }

    var body: some View {
        OptioRow(
            title: pr.title,
            tone: tone,
            meta: Text.meta([Text.mono("#\(pr.number)"), pr.repo?.fullName.map { Text($0) }, pr.author.map { Text($0) }, pr.updatedAt.map { Text($0.relativeDescription) }]),
            trailing: trailing.0,
            trailingTone: trailing.1,
            footer: (pr.labels?.isEmpty == false) ? Text(pr.labels!.joined(separator: " · ")) : nil
        )
    }
}

/// Pushed for a PR that has no Optio review yet: the facts, "Review with Optio", and the host link.
struct PullRequestSummaryView: View {
    let pr: PullRequestSummary
    @Environment(APIClient.self) private var api
    @State private var launching = false
    @State private var error: Error?
    @State private var reviewId: String?

    var body: some View {
        List {
            Section {
                Text(pr.title).font(.body)
                if let repo = pr.repo?.fullName { LabeledContent("Repo", value: repo) }
                if let a = pr.author { LabeledContent("Author", value: a) }
                if let u = pr.updatedAt { LabeledContent("Updated", value: u.relativeDescription) }
                if pr.draft == true { LabeledContent("State") { StatusBadge(text: "Draft", tone: .idle) } }
                if let url = URL(string: pr.url) { Link("Open on \(pr.url.contains("gitlab") ? "GitLab" : "GitHub")", destination: url) }
            }
            if let labels = pr.labels, !labels.isEmpty {
                Section("Labels") { Text(labels.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary) }
            }
            Section {
                Button {
                    Task { await launch() }
                } label: {
                    HStack { Spacer(); if launching { ProgressView() } else { Label("Review with Optio", systemImage: "eye") }; Spacer() }
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.accent)
                .disabled(launching)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                if let error { ErrorRow(error: error) }
            }
        }
        .navigationTitle("PR #\(pr.number)")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $reviewId) { ReviewDetailView(reviewId: $0) }
    }

    private func launch() async {
        launching = true
        defer { launching = false }
        do { reviewId = try await api.createPrReview(prUrl: pr.url).id } catch { self.error = error }
    }
}

@Observable @MainActor
final class ReviewsListModel {
    var prs: [PullRequestSummary] = []
    var repos: [RepoSummary] = []
    var loaded = false
    var error: Error?
    var actionError: Error?
    var toast: String?
    var reviewingURL: String?
    var mergingURL: String?
    var launchingURL = false

    func load(_ api: APIClient, repoId: String) async {
        do {
            async let prs = api.listOpenPullRequests(repoId: repoId.isEmpty ? nil : repoId)
            async let repos = api.listReposForReviews()
            self.prs = try await prs
            self.repos = (try? await repos) ?? []
            error = nil
        } catch {
            self.error = error
        }
        loaded = true
    }

    /// Returns the new review id on success.
    func launchReview(prUrl: String, api: APIClient, fromURLField: Bool = false) async -> String? {
        if fromURLField { launchingURL = true } else { reviewingURL = prUrl }
        defer { launchingURL = false; reviewingURL = nil }
        do {
            let review = try await api.createPrReview(prUrl: prUrl)
            toast = "Review started"
            return review.id
        } catch {
            actionError = error
            return nil
        }
    }

    func approveAndMerge(_ pr: PullRequestSummary, api: APIClient, repoId: String) async {
        mergingURL = pr.url
        defer { mergingURL = nil }
        if let review = pr.review {
            // Best-effort: mark the draft approved + submit before merging (web does the same).
            _ = try? await api.updatePrReview(review.id, .init(summary: "Approved by user", verdict: "approve"))
            _ = try? await api.submitPrReview(review.id)
        }
        do {
            try await api.mergePullRequest(prUrl: pr.url, method: "squash")
            toast = "PR #\(pr.number) merged"
            await load(api, repoId: repoId)
        } catch {
            actionError = error
        }
    }
}
