import SwiftUI

/// Review detail — mirrors `/reviews/[id]`: PR link + state pipeline, editable
/// draft (verdict / summary / inline comments) with Save / Submit / Merge,
/// Re-review / Cancel, live agent logs (`/ws/pr-reviews/:id/logs` + REST
/// catch-up) with the chat thread rendered inline, a chat composer once a
/// draft exists, and the run history.
struct ReviewDetailView: View {
    let reviewId: String
    @Environment(APIClient.self) private var api
    @Environment(\.openURL) private var openURL
    @State private var model = ReviewDetailModel()
    @State private var logs = RunLogStream(
        logEventType: "pr_review_run:log",
        stateEventTypes: ["pr_review_run:state_changed", "pr_review:state_changed", "pr_review:stale"]
    )
    @State private var section: Section = .activity
    @State private var confirmCancel = false
    @State private var confirmMerge = false
    @State private var mergeMethod = "squash"

    enum Section: Hashable { case draft, activity, runs }

    private static let pipeline: [(String, String)] = [
        ("queued", "Queued"), ("waiting_ci", "CI"), ("reviewing", "Reviewing"), ("ready", "Ready"), ("submitted", "Submitted"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            if let review = model.review {
                header(review)
                DetailTabs(options: [
                    (Section.draft, "Draft"),
                    (Section.activity, "Activity"),
                    (Section.runs, "Runs"),
                ], selection: $section)
                switch section {
                case .draft: draftSection(review)
                case .activity: activitySection(review)
                case .runs: runsSection
                }
            } else if let error = model.error {
                ErrorRow(error: error) { Task { await model.load(reviewId, api: api) } }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(model.review.map { "PR #\($0.prNumber ?? 0)" } ?? "Review")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task {
            await model.load(reviewId, api: api)
            if model.review?.hasDraft == false { section = .activity } else { section = .draft }
            logs.onStateChanged = { Task { await model.load(reviewId, api: api, quiet: true) } }
            logs.start(api: api, wsPath: "/ws/pr-reviews/\(reviewId)/logs") { try await api.prReviewLogs(reviewId) }
        }
        .task(id: model.pollKey) {
            guard model.pollKey else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await model.load(reviewId, api: api, quiet: true)
            }
        }
        .onChange(of: model.runs.first?.id) { _, _ in
            // A new run (re-review / chat) means a new log target; refresh history.
            logs.reloadHistory { try await api.prReviewLogs(reviewId) }
        }
        .onDisappear { logs.stop() }
        .confirmationDialog("Cancel this review?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel Review", role: .destructive) { Task { await model.cancel(reviewId, api: api) } }
        }
        .confirmationDialog(mergeTitle, isPresented: $confirmMerge, titleVisibility: .visible) {
            ForEach(ReviewFormat.mergeMethods, id: \.0) { value, label in
                Button(label) { Task { await model.merge(method: value, api: api) } }
            }
        }
        .errorToast(Binding(get: { model.actionError }, set: { model.actionError = $0 }))
        .transientMessage(model.toast) { model.toast = nil }
    }

    private var mergeTitle: String {
        if let s = model.prStatus, s.isOpen, !s.checksOk {
            return "CI is \(s.checksStatus ?? "unknown"). Branch protection may still block the merge. Merge anyway?"
        }
        return "Merge this PR?"
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                if let r = model.review {
                    Button { openURL(URL(string: r.prUrl)!) } label: { Label("View on \(r.platformName)", systemImage: "arrow.up.right.square") }
                    if r.canReReview {
                        Button { Task { await model.reReview(reviewId, api: api) } } label: { Label("Re-review", systemImage: "arrow.counterclockwise") }
                    }
                    Button { Task { await model.load(reviewId, api: api, quiet: true) } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    if r.canCancel {
                        Divider()
                        Button(role: .destructive) { confirmCancel = true } label: { Label("Cancel Review", systemImage: "xmark.circle") }
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .disabled(model.busy)
        }
    }

    // MARK: Header

    private func header(_ review: PrReview) -> some View {
        let s = model.prStatus
        let needsYou: String? = {
            if review.state == "ready" { return "Draft ready — read it and submit" }
            if review.state == "stale" { return "New commits since this review — consider re-reviewing" }
            return nil
        }()
        let secondary: Text? = {
            if review.state == "failed", let err = review.errorMessage, !err.isEmpty { return Text(err) }
            if review.isWorking { return Text(workingHint(review.state)) }
            return nil
        }()
        return VStack(spacing: 0) {
            DetailHeader(
                state: ReviewFormat.stateLabel(review.state),
                tone: ReviewFormat.stateTone(review.state) == .accent ? .working : ReviewFormat.stateTone(review.state),
                line: Text.meta([
                    Text(review.repoFullName),
                    Text.mono("#\(review.prNumber ?? 0)"),
                    review.verdict.map { Text(ReviewFormat.verdictLabel($0)) },
                    review.origin == "auto" ? Text("auto") : nil,
                    s?.checksStatus.map { Text("CI \($0)") },
                    s?.reviewStatus.map { Text("review \($0.replacingOccurrences(of: "_", with: " "))") },
                    (s?.prState).flatMap { $0 == "open" ? nil : Text("PR \($0)") },
                ]),
                secondary: secondary,
                needsYou: needsYou
            ) {
                if logs.connected { StateDot(tone: .working, size: 6).accessibilityLabel("Live") }
                Button {
                    if let url = URL(string: review.prUrl) { openURL(url) }
                } label: { Image(systemName: "arrow.up.right.square") }
                .buttonStyle(.plain).font(.subheadline).foregroundStyle(.secondary)
                .accessibilityLabel("Open pull request")
            }
            pipelineStrip(review.state)
                .padding(.horizontal, Spacing.l)
                .padding(.vertical, Spacing.s)
        }
    }

    private func workingHint(_ state: String) -> String {
        switch state {
        case "waiting_ci": return "Waiting for CI to finish — the agent starts reviewing once checks complete."
        case "queued": return "Queued — a worker will pick this up shortly."
        default: return "Agent is reviewing the PR. The draft appears when it's done."
        }
    }

    private func pipelineStrip(_ state: String) -> some View {
        let current: Int = {
            if state == "stale" { return 3 }
            if state == "failed" || state == "cancelled" { return -1 }
            return Self.pipeline.firstIndex { $0.0 == state } ?? -1
        }()
        return PipelineStrip(steps: Self.pipeline.map(\.1), current: current, failed: state == "failed" || state == "stale")
    }

    // MARK: Draft

    @ViewBuilder
    private func draftSection(_ review: PrReview) -> some View {
        if !review.hasDraft {
            VStack(spacing: 8) {
                if review.isWorking { ProgressView() }
                EmptyState(title: review.isWorking ? "Draft in progress" : "No draft", systemImage: "doc.text", message: review.isWorking ? workingHint(review.state) : "This review has no draft to show.")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Form {
                SwiftUI.Section("Verdict") {
                    HStack(spacing: 8) {
                        ForEach(["approve", "request_changes", "comment"], id: \.self) { v in
                            Button {
                                model.verdict = v
                                model.dirty = true
                            } label: {
                                Label(ReviewFormat.verdictLabel(v), systemImage: ReviewFormat.verdictIcon(v))
                                    .font(.caption.weight(.medium))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                            }
                            .buttonStyle(.bordered)
                            .tint(model.verdict == v ? ReviewFormat.verdictTone(v).color : Tone.idle.color)
                            .disabled(!review.isEditable)
                        }
                    }
                    .buttonStyle(.borderless)
                }
                SwiftUI.Section("Review Summary") {
                    TextEditor(text: Binding(get: { model.summary }, set: { model.summary = $0; model.dirty = true }))
                        .frame(minHeight: 120)
                        .disabled(!review.isEditable)
                }
                SwiftUI.Section("Inline Comments (\(model.comments.count))") {
                    ForEach(model.comments.indices, id: \.self) { i in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                TextField("path/to/file.ts", text: Binding(get: { model.comments[i].path }, set: { model.comments[i].path = $0; model.dirty = true }))
                                    .font(.caption.monospaced())
                                    .autocorrectionDisabled()
                                    .textInputAutocapitalization(.never)
                                TextField("line", text: Binding(
                                    get: { model.comments[i].line.map { String(Int($0)) } ?? "" },
                                    set: { model.comments[i].line = Double($0); model.dirty = true }
                                ))
                                .font(.caption.monospaced())
                                .keyboardType(.numberPad)
                                .frame(width: 56)
                                if review.isEditable {
                                    Button(role: .destructive) {
                                        model.comments.remove(at: i)
                                        model.dirty = true
                                    } label: { Image(systemName: "trash") }
                                        .buttonStyle(.borderless)
                                }
                            }
                            TextField("Comment", text: Binding(get: { model.comments[i].body }, set: { model.comments[i].body = $0; model.dirty = true }), axis: .vertical)
                                .lineLimit(2...6)
                        }
                        .disabled(!review.isEditable)
                    }
                    if review.isEditable {
                        Button { model.comments.append(.init(path: "", body: "")); model.dirty = true } label: { Label("Add comment", systemImage: "plus") }
                    }
                }
                SwiftUI.Section {
                    if review.isEditable {
                        if model.dirty {
                            Button { Task { await model.saveDraft(reviewId, api: api) } } label: {
                                HStack { if model.saving { ProgressView() }; Text("Save Draft") }
                            }
                            .disabled(model.saving)
                        }
                        Button { Task { await model.submit(reviewId, api: api) } } label: {
                            HStack { if model.submitting { ProgressView() }; Label("Submit Review", systemImage: "paperplane") }
                        }
                        .disabled(model.submitting || model.verdict.isEmpty)
                        .tint(AppTheme.accent)
                    }
                    if review.state == "submitted" {
                        Label("Submitted\(review.autoSubmitted == true ? " automatically" : "")", systemImage: "checkmark.circle")
                            .foregroundStyle(.green)
                    }
                    Button { confirmMerge = true } label: {
                        HStack {
                            if model.merging { ProgressView() }
                            Label(model.prStatus.map { $0.isOpen && !$0.checksOk ? "Merge anyway" : "Merge PR" } ?? "Merge PR", systemImage: "arrow.triangle.merge")
                        }
                    }
                    .tint(.primary)
                    .disabled(model.merging || !(model.prStatus?.isOpen ?? false))
                    if let s = model.prStatus, !s.isOpen {
                        Text("PR is \(s.prState ?? "closed")").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    // MARK: Activity (logs + chat)

    private func activitySection(_ review: PrReview) -> some View {
        VStack(spacing: 0) {
            if logs.entries.isEmpty && model.userMessages.isEmpty {
                VStack(spacing: 8) {
                    if review.isWorking { ProgressView() }
                    Text(review.isWorking ? "Waiting for output…" : "No logs recorded").foregroundStyle(.secondary).font(.footnote)
                    if let e = logs.error { Text(e.localizedDescription).font(.caption).foregroundStyle(.red) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ReviewActivityView(entries: logs.entries, userMessages: model.userMessages)
            }
            if review.hasDraft {
                ChatComposer(placeholder: "Ask the reviewer…", disabled: model.chatSending) { text in
                    await model.sendChat(reviewId, text: text, api: api)
                }
            }
        }
    }

    // MARK: Runs

    private var runsSection: some View {
        List {
            if model.runs.isEmpty {
                EmptyState(title: "No runs yet", systemImage: "circle.dotted")
            }
            ForEach(model.runs) { run in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        StatusBadge(text: run.state, tone: Tone.forState(run.state))
                        Text((run.kind ?? "run").capitalized).font(.subheadline.weight(.medium))
                        Spacer()
                        Text((run.startedAt ?? run.createdAt)?.relativeDescription ?? "").font(.caption).foregroundStyle(.secondary)
                    }
                    HStack(spacing: 8) {
                        if let d = run.durationText { Label(d, systemImage: "clock") }
                        if let m = run.modelUsed { Label(m, systemImage: "cpu") }
                        if let c = JobFormat.cost(run.costUsd, digits: 4) { Label(c, systemImage: "dollarsign.circle") }
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                    if let s = run.resultSummary, !s.isEmpty { Text(s).font(.caption).lineLimit(3) }
                    if let e = run.errorMessage, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.red).lineLimit(3) }
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

/// Log transcript with the user's chat turns interleaved by timestamp, the
/// way the web's LogViewer renders `userMessages` inline.
struct ReviewActivityView: View {
    let entries: [AgentLogEntry]
    let userMessages: [ReviewDetailModel.UserMessage]

    private enum Item: Identifiable {
        case log(Int, AgentLogEntry)
        case user(ReviewDetailModel.UserMessage)
        var id: String {
            switch self {
            case .log(let i, _): return "log-\(i)"
            case .user(let m): return "user-\(m.id)"
            }
        }
        var timestamp: String {
            switch self {
            case .log(_, let e): return e.timestamp
            case .user(let m): return m.timestamp
            }
        }
    }

    private var items: [Item] {
        let logs = entries.enumerated().map { Item.log($0.offset, $0.element) }
        let users = userMessages.map { Item.user($0) }
        return (logs + users).sorted { $0.timestamp < $1.timestamp }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(items) { item in
                        switch item {
                        case .log(_, let entry): AgentLogRow(entry: entry).id(item.id)
                        case .user(let m):
                            HStack {
                                Spacer(minLength: 40)
                                VStack(alignment: .trailing, spacing: 2) {
                                    Text(m.text)
                                        .padding(10)
                                        .background(AppTheme.accent.opacity(0.15), in: Radius.bubbleShape)
                                    if m.status != "sent" {
                                        Text(m.status == "failed" ? "Failed to send" : "Sending…")
                                            .font(.caption2).foregroundStyle(m.status == "failed" ? .red : .secondary)
                                    }
                                }
                            }
                            .id(item.id)
                        }
                    }
                }
                .padding()
            }
            .onChange(of: items.count) { _, _ in
                if let last = items.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }
}

@Observable @MainActor
final class ReviewDetailModel {
    /// Mutable mirror of the generated (immutable) `PrReviewFileComment`.
    struct DraftComment: Hashable {
        var path: String
        var line: Double?
        var side: String?
        var body: String
        init(path: String, line: Double? = nil, side: String? = nil, body: String) {
            self.path = path; self.line = line; self.side = side; self.body = body
        }
        init(_ c: PrReviewFileComment) { self.init(path: c.path, line: c.line, side: c.side, body: c.body) }
        var generated: PrReviewFileComment { PrReviewFileComment(path: path, line: line, side: side, body: body) }
    }

    struct UserMessage: Identifiable, Hashable {
        let id: String
        let text: String
        let timestamp: String
        var status: String // sending | sent | failed
    }

    var review: PrReview?
    var runs: [PrReviewRun] = []
    var prStatus: PrStatus?
    var userMessages: [UserMessage] = []
    var error: Error?
    var actionError: Error?
    var toast: String?

    var summary = ""
    var verdict = ""
    var comments: [DraftComment] = []
    var dirty = false
    var saving = false
    var submitting = false
    var merging = false
    var chatSending = false
    var busy = false

    var pollKey: Bool { (review?.isWorking ?? false) || chatSending }

    func load(_ id: String, api: APIClient, quiet: Bool = false) async {
        do {
            async let r = api.getPrReview(id)
            async let runs = api.listPrReviewRuns(id)
            let review = try await r
            self.runs = (try? await runs) ?? []
            self.review = review
            error = nil
            if !dirty {
                summary = review.summary ?? ""
                verdict = review.verdict ?? ""
                comments = (review.fileComments ?? []).map(DraftComment.init)
            }
            Task { prStatus = try? await api.prStatus(prUrl: review.prUrl) }
            if review.hasDraft {
                Task {
                    if let msgs = try? await api.listPrReviewChat(id) {
                        let local = userMessages.filter { $0.id.hasPrefix("local-") }
                        let hydrated = msgs.filter { $0.role == "user" }.map {
                            UserMessage(id: $0.id, text: $0.content, timestamp: $0.createdAt.map { RunLogRow.iso.string(from: $0) } ?? "", status: "sent")
                        }
                        // Drop local echoes the server now knows about.
                        let known = Set(hydrated.map(\.text))
                        userMessages = hydrated + local.filter { !known.contains($0.text) || $0.status != "sent" }
                    }
                }
            }
        } catch {
            if review == nil || !quiet { self.error = error } else { actionError = error }
        }
    }

    func saveDraft(_ id: String, api: APIClient) async {
        saving = true; defer { saving = false }
        do {
            review = try await api.updatePrReview(id, .init(summary: summary, verdict: verdict.isEmpty ? nil : verdict, fileComments: comments.map(\.generated)))
            dirty = false
            toast = "Draft saved"
        } catch { actionError = error }
    }

    func submit(_ id: String, api: APIClient) async {
        if dirty { await saveDraft(id, api: api); if dirty { return } }
        submitting = true; defer { submitting = false }
        do {
            review = try await api.submitPrReview(id)
            toast = "Review submitted"
        } catch { actionError = error }
    }

    func reReview(_ id: String, api: APIClient) async {
        busy = true; defer { busy = false }
        do {
            try await api.reReviewPr(id)
            toast = "Re-review started"
            dirty = false
            await load(id, api: api, quiet: true)
        } catch { actionError = error }
    }

    func cancel(_ id: String, api: APIClient) async {
        busy = true; defer { busy = false }
        do {
            try await api.cancelPrReview(id)
            toast = "Review cancelled"
            await load(id, api: api, quiet: true)
        } catch { actionError = error }
    }

    func merge(method: String, api: APIClient) async {
        guard let review else { return }
        merging = true; defer { merging = false }
        do {
            try await api.mergePullRequest(prUrl: review.prUrl, method: method)
            toast = "PR merged"
            prStatus = try? await api.prStatus(prUrl: review.prUrl)
        } catch { actionError = error }
    }

    func sendChat(_ id: String, text: String, api: APIClient) async {
        let localId = "local-\(UUID().uuidString)"
        let ts = RunLogRow.iso.string(from: Date())
        userMessages.append(UserMessage(id: localId, text: text, timestamp: ts, status: "sending"))
        chatSending = true
        do {
            try await api.postPrReviewChat(id, message: text)
            if let i = userMessages.firstIndex(where: { $0.id == localId }) { userMessages[i].status = "sent" }
            // Poll until the assistant replies (web: 3s ticks, 5 min cap).
            let start = Date()
            Task { [weak self] in
                while let self, !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(3))
                    let msgs = (try? await api.listPrReviewChat(id)) ?? []
                    let replied = msgs.contains { $0.role == "assistant" && ($0.createdAt ?? .distantPast) > start }
                    if replied || Date().timeIntervalSince(start) > 300 {
                        chatSending = false
                        await load(id, api: api, quiet: true)
                        return
                    }
                }
            }
        } catch {
            if let i = userMessages.firstIndex(where: { $0.id == localId }) { userMessages[i].status = "failed" }
            actionError = error
            chatSending = false
        }
    }
}
