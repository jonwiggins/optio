import SwiftUI

/// Reviews list — mirrors `/reviews` (PrBrowser): open PRs across connected
/// repos with their review state/verdict, a "paste a PR URL" launcher, repo
/// filter, and per-PR "Review with Optio" / "Approve & Merge". A review-state
/// chip row narrows the list client-side. Embedded by the Run hub inside its
/// NavigationStack; declares its own navigation destinations.
struct ReviewsListView: View {
    @Environment(APIClient.self) private var api
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
                HStack(spacing: 8) {
                    TextField("Paste a PR URL to review", text: $prUrl)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .onSubmit { launchFromURL() }
                    Button {
                        launchFromURL()
                    } label: {
                        if model.launchingURL { ProgressView() } else { Label("Review", systemImage: "eye") }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AppTheme.accent)
                    .controlSize(.small)
                    .disabled(model.launchingURL || prUrl.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            Section {
                ChipPicker(options: Self.stateOptions, selection: $stateFilter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                if model.repos.count > 1 {
                    Picker("Repo", selection: $repoFilter) {
                        Text("All repos").tag("")
                        ForEach(model.repos) { Text($0.fullName ?? $0.id).tag($0.id) }
                    }
                    .onChange(of: repoFilter) { _, _ in Task { await model.load(api, repoId: repoFilter) } }
                }
            }

            if let error = model.error, model.prs.isEmpty {
                ErrorBanner(error: error) { Task { await model.load(api, repoId: repoFilter) } }
            } else if model.loaded && filtered.isEmpty {
                EmptyState(
                    title: model.prs.isEmpty ? "No open pull requests" : "No matching PRs",
                    systemImage: "arrow.triangle.pull",
                    message: model.repos.isEmpty ? "Add a repo first in Repos settings." : (model.prs.isEmpty ? "Pull requests from your configured repos appear here." : nil)
                )
            } else {
                ForEach(filtered) { pr in
                    PullRequestRow(
                        pr: pr,
                        reviewing: model.reviewingURL == pr.url,
                        merging: model.mergingURL == pr.url,
                        onReview: { Task { if let id = await model.launchReview(prUrl: pr.url, api: api) { pushed = .detail(id) } } },
                        onMerge: { mergeTarget = pr }
                    )
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if let id = pr.review?.id { pushed = .detail(id) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Reviews")
        .overlay { if !model.loaded && model.error == nil { ProgressView() } }
        .refreshable { await model.load(api, repoId: repoFilter) }
        .task { await model.load(api, repoId: repoFilter) }
        .confirmationDialog(
            "Approve and merge PR #\(mergeTarget?.number ?? 0)? This skips agent review.",
            isPresented: Binding(get: { mergeTarget != nil }, set: { if !$0 { mergeTarget = nil } }),
            titleVisibility: .visible
        ) {
            Button("Approve & Squash-merge", role: .destructive) {
                if let pr = mergeTarget { Task { await model.approveAndMerge(pr, api: api, repoId: repoFilter) } }
            }
        }
        .alert("Error", isPresented: Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.actionError?.localizedDescription ?? "")
        }
        .transientMessage(model.toast) { model.toast = nil }
        .navigationDestination(item: $pushed) { route in
            switch route {
            case .detail(let id): ReviewDetailView(reviewId: id)
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

enum ReviewRoute: Hashable, Identifiable {
    case detail(String)
    var id: String {
        switch self {
        case .detail(let id): return id
        }
    }
}

struct PullRequestRow: View {
    let pr: PullRequestSummary
    let reviewing: Bool
    let merging: Bool
    let onReview: () -> Void
    let onMerge: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                Text(pr.title).font(.headline).lineLimit(2)
                Spacer(minLength: 0)
                Text("#\(pr.number)").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                if pr.draft == true { StatusBadge(text: "Draft", color: .gray) }
                if let r = pr.review, let s = r.state { StatusBadge(text: ReviewFormat.stateLabel(s), color: ReviewFormat.stateColor(s)) }
                if let v = pr.review?.verdict { StatusBadge(text: ReviewFormat.verdictLabel(v), color: ReviewFormat.verdictColor(v)) }
                if pr.review?.origin == "auto" { StatusBadge(text: "Auto", color: AppTheme.accent) }
            }
            HStack(spacing: 10) {
                if let repo = pr.repo?.fullName { Label(repo, systemImage: "arrow.triangle.branch") }
                if let a = pr.author { Label(a, systemImage: "person") }
                if let u = pr.updatedAt { Text(u.relativeDescription) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            if let labels = pr.labels, !labels.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) { ForEach(labels, id: \.self) { StatusBadge(text: $0, color: .secondary) } }
                }
            }
            HStack(spacing: 8) {
                if pr.review != nil {
                    Label("View Review", systemImage: "chevron.right")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppTheme.accent)
                } else {
                    Button(action: onReview) {
                        if reviewing { ProgressView().controlSize(.mini) } else { Label("Review with Optio", systemImage: "eye") }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AppTheme.accent)
                    .controlSize(.mini)
                    .disabled(reviewing)
                }
                Spacer()
                Button(action: onMerge) {
                    if merging { ProgressView().controlSize(.mini) } else { Label("Approve & Merge", systemImage: "arrow.triangle.merge") }
                }
                .buttonStyle(.bordered)
                .tint(.green)
                .controlSize(.mini)
                .disabled(merging)
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
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
