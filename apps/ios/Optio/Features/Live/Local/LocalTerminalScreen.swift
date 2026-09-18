import Combine
import SwiftUI
import SwiftTerm

/// Focus view for one local terminal (`/local/:id`): header with state and
/// attention, the SwiftTerm viewer fed by the stream WS, and an extra-keys bar
/// for the keys a phone keyboard lacks.
struct LocalTerminalScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    let terminalId: String
    var hosts: [LocalHost] = []
    /// Deep link `?compose=1` (Live Activity "Reply…"): raise the keyboard once the stream connects.
    var focusComposer = false

    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var terminal: LocalTerminal?
    @State private var loadError: Error?
    @State private var actionError: String?
    @State private var busy = false
    @State private var confirmKill = false
    @State private var confirmDelete = false
    @State private var showSendText = false
    @State private var sendText = ""
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        Group {
            if let terminal {
                content(terminal)
            } else if let loadError {
                List { ErrorRow(error: loadError, what: "terminal") { Task { await load() } } }.listStyle(.plain)
            } else {
                TerminalTheme.background(colorScheme).ignoresSafeArea()
            }
        }
        .navigationTitle(terminal?.title ?? "Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task {
            await load()
            pollTask?.cancel()
            pollTask = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(10))
                    if Task.isCancelled { return }
                    await load(quiet: true)
                }
            }
        }
        .onDisappear { pollTask?.cancel(); pollTask = nil }
        .confirmationDialog("Kill this terminal's process?", isPresented: $confirmKill, titleVisibility: .visible) {
            Button("Kill (SIGTERM)", role: .destructive) { Task { await kill(nil) } }
            Button("Force kill (SIGKILL)", role: .destructive) { Task { await kill("SIGKILL") } }
        }
        .confirmationDialog("Delete terminal \"\(terminal?.title ?? "")\"?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await deleteTerminal() } }
        }
        .alert("Send text", isPresented: $showSendText) {
            TextField("Text to write to stdin", text: $sendText)
            Button("Send") { Task { await sendViaRest(sendText) } }
            Button("Send + Enter") { Task { await sendViaRest(sendText + "\r") } }
            Button("Cancel", role: .cancel) { sendText = "" }
        } message: {
            Text("REST fallback (POST /input) — useful when the stream is disconnected.")
        }
        .errorToast($actionError)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if let terminal {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(terminal.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    HStack(spacing: 5) {
                        if let tone = LocalPresentation.rowTone(terminal) { StateDot(tone: tone, size: 6) }
                        Text(terminal.attentionState == .needsYou && !LocalPresentation.isDead(terminal)
                             ? LocalPresentation.attentionLabel(terminal.attentionReason)
                             : LocalPresentation.stateLabel(terminal))
                            .font(.caption2)
                            .foregroundStyle(terminal.attentionState == .needsYou && !LocalPresentation.isDead(terminal) ? AnyShapeStyle(AppTheme.accent) : AnyShapeStyle(.secondary))
                            .lineLimit(1)
                    }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if LocalPresentation.canStart(terminal) {
                        Button { Task { await start() } } label: { Label("Start", systemImage: "play.fill") }
                    }
                    if LocalPresentation.canKill(terminal) {
                        Button(role: .destructive) { confirmKill = true } label: { Label("Kill", systemImage: "xmark.circle") }
                    }
                    if LocalPresentation.canDelete(terminal) {
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }
                    }
                    if terminal.state == .running {
                        Button { showSendText = true } label: { Label("Send text (REST)", systemImage: "text.cursor") }
                    }
                    Divider()
                    if let url = URL(string: terminal.ticketUrl ?? ""), terminal.ticketUrl != nil {
                        Link(destination: url) { Label("Open ticket", systemImage: "ticket") }
                    }
                    ForEach(terminal.links, id: \.url) { link in
                        if let url = URL(string: link.url) {
                            Link(destination: url) { Label(link.label, systemImage: link.kind == .pr ? "arrow.triangle.pull" : "circle.circle") }
                        }
                    }
                    Divider()
                    Text(terminal.dir).font(.caption.monospaced())
                    if let cmd = terminal.command { Text(cmd).font(.caption.monospaced()) }
                } label: {
                    if busy { ProgressView() } else { Image(systemName: "ellipsis.circle") }
                }
            }
        }
    }

    @ViewBuilder
    private func content(_ terminal: LocalTerminal) -> some View {
        VStack(spacing: 0) {
            header(terminal)
            if LocalPresentation.isDead(terminal), let preview = terminal.preview, !preview.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Last output").font(.sectionHeader).foregroundStyle(.secondary)
                    ScrollView {
                        Text(preview).font(.monoCaption).foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 180)
                }
                .padding(10)
                .background(TerminalTheme.background(colorScheme))
            }
            // Remount on leaving `pending` — the stream only attaches to a terminal
            // that is already launching/running when it connects.
            LocalTerminalStreamView(terminalId: terminalId, focusComposer: focusComposer) { state, attention in
                applyStatus(state: state, attention: attention)
            } onExit: { code in
                if var t = self.terminal, !LocalPresentation.isDead(t) {
                    t = LocalTerminal(copy: t, state: .exited, exitCode: code.map(Double.init))
                    self.terminal = t
                }
                Task { await load(quiet: true) }
            }
            .id(terminal.state == .pending ? "held" : "live")
        }
        .background(TerminalTheme.background(colorScheme))
    }

    private func header(_ t: LocalTerminal) -> some View {
        let needsYou = t.attentionState == .needsYou && !LocalPresentation.isDead(t)
        var facts: [Text?] = []
        if hosts.count > 1, let host = hosts.first(where: { $0.id == t.hostId }) { facts.append(Text(host.name)) }
        if t.state == .exited, let code = t.exitCode { facts.append(Text("exit \(Int(code))")) }
        if t.state == .pending, t.pendingReason == .hostOffline { facts.append(Text("starts when the host reconnects")) }
        if let cost = Cost.formatIfNonZero(t.costUsd) { facts.append(Text(cost)) }
        let links = LocalPresentation.workLinks(t)
        if !links.isEmpty { facts.append(Text(links.prefix(3).map(WorkLinkBadges.shortLabel).joined(separator: " · "))) }
        let detailLine = Text.meta(facts)
        let secondary: Text? = {
            if LocalPresentation.isDead(t), let msg = t.errorMessage, !msg.isEmpty { return Text(msg) }
            return Text.mono(t.dir)
        }()
        return DetailHeader(
            state: LocalPresentation.stateLabel(t),
            tone: LocalPresentation.stateTone(t) == .accent ? .working : LocalPresentation.stateTone(t),
            line: detailLine,
            secondary: secondary,
            needsYou: needsYou ? LocalPresentation.attentionLabel(t.attentionReason).capitalizedFirst : nil
        ) {
            WorkLinkBadges(links: links, max: 2)
        }
    }

    // MARK: Data

    private func load(quiet: Bool = false) async {
        do {
            terminal = try await api.getLocalTerminal(terminalId)
            loadError = nil
        } catch {
            if !quiet || terminal == nil { loadError = error }
        }
    }

    private func applyStatus(state: LocalTerminalState, attention: LocalAttentionState) {
        guard let t = terminal else { return }
        if t.state != state || t.attentionState != attention {
            terminal = LocalTerminal(copy: t, state: state, attentionState: attention)
        }
    }

    private func start() async {
        busy = true
        do { terminal = try await api.startLocalTerminal(terminalId) } catch { actionError = error.localizedDescription }
        busy = false
    }

    private func kill(_ signal: String?) async {
        busy = true
        do { try await api.killLocalTerminal(terminalId, signal: signal); await load(quiet: true) } catch { actionError = error.localizedDescription }
        busy = false
    }

    private func deleteTerminal() async {
        busy = true
        do { try await api.deleteLocalTerminal(terminalId); dismiss() } catch { actionError = error.localizedDescription; busy = false }
    }

    private func sendViaRest(_ text: String) async {
        sendText = ""
        guard !text.isEmpty else { return }
        do { try await api.sendLocalTerminalInput(terminalId, data: text) } catch { actionError = error.localizedDescription }
    }
}

/// Since the generated model is `let`-only, copy-with helpers for the few
/// fields the stream mutates locally.
extension LocalTerminal {
    init(copy t: LocalTerminal, state: LocalTerminalState? = nil, attentionState: LocalAttentionState? = nil, exitCode: Double? = nil) {
        self.init(
            id: t.id, hostId: t.hostId, userId: t.userId, workspaceId: t.workspaceId, title: t.title, dir: t.dir,
            command: t.command, spec: t.spec, state: state ?? t.state, pendingReason: t.pendingReason,
            exitCode: exitCode ?? t.exitCode, errorMessage: t.errorMessage,
            attentionState: attentionState ?? t.attentionState, attentionReason: t.attentionReason,
            spawnedBy: t.spawnedBy, blueprintId: t.blueprintId, triggerId: t.triggerId, ticketSource: t.ticketSource,
            ticketExternalId: t.ticketExternalId, ticketUrl: t.ticketUrl, preview: t.preview, links: t.links,
            costUsd: t.costUsd, lastActivityAt: t.lastActivityAt, createdAt: t.createdAt, updatedAt: t.updatedAt,
            startedAt: t.startedAt, endedAt: t.endedAt
        )
    }
}

// MARK: - Stream view (status strip + SwiftTerm + extra keys)

struct LocalTerminalStreamView: View {
    @Environment(\.colorScheme) private var colorScheme
    let terminalId: String
    var focusComposer = false
    var onStatus: (LocalTerminalState, LocalAttentionState) -> Void
    var onExit: (Int?) -> Void

    @Environment(APIClient.self) private var api
    @State private var stream: LocalTerminalStream?
    @State private var keyboardShown = false

    var body: some View {
        Group {
            if let stream {
                VStack(spacing: 0) {
                    statusStrip(stream)
                    ZStack(alignment: .top) {
                        SwiftTermView(stream: stream)
                        if let message = stream.errorMessage {
                            errorBanner(message, stream: stream)
                        }
                    }
                    TerminalKeyBar(
                        enabled: stream.connState == .connected,
                        applicationCursor: stream.bridge.applicationCursor,
                        send: { stream.sendInput(bytes: $0) },
                        keyboardShown: keyboardShown,
                        toggleKeyboard: {
                            if stream.bridge.isFocused { stream.bridge.blur() } else { stream.bridge.focus() }
                            keyboardShown = stream.bridge.isFocused
                        }
                    )
                    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in keyboardShown = true }
                    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in keyboardShown = false }
                }
            } else {
                TerminalTheme.background(colorScheme)
            }
        }
        .onAppear {
            if stream == nil {
                let s = LocalTerminalStream(api: api, terminalId: terminalId)
                s.onStatus = onStatus
                s.onExit = onExit
                stream = s
                s.connect()
                if focusComposer {
                    Task {
                        try? await Task.sleep(for: .milliseconds(600))
                        s.bridge.focus()
                        keyboardShown = s.bridge.isFocused
                    }
                }
            }
        }
        .onDisappear {
            stream?.disconnect()
            stream = nil
        }
    }

    private func statusStrip(_ stream: LocalTerminalStream) -> some View {
        HStack(spacing: 10) {
            HStack(spacing: 5) {
                Circle().fill(connColor(stream.connState)).frame(width: 6, height: 6)
                Text(connLabel(stream.connState))
            }
            if let state = stream.state {
                Text(state.rawValue.replacingOccurrences(of: "_", with: " "))
            }
            if let attention = stream.attentionState {
                Text(attention == .needsYou ? "needs you" : attention.rawValue)
                    .foregroundStyle(attention == .needsYou ? AnyShapeStyle(AppTheme.accent) : AnyShapeStyle(.secondary))
            }
            Spacer()
            if let size = stream.lastSentSize {
                Text("\(size.cols)×\(size.rows)").monospacedDigit()
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(TerminalTheme.background(colorScheme))
        .overlay(alignment: .bottom) { Divider().opacity(0.5) }
    }

    private func errorBanner(_ message: String, stream: LocalTerminalStream) -> some View {
        HStack(spacing: 8) {
            Image(systemName: stream.retrying ? "wifi.exclamationmark" : "exclamationmark.triangle")
            VStack(alignment: .leading, spacing: 2) {
                Text(message).font(.footnote.weight(.medium))
                if stream.retrying {
                    Text("Retrying every 2s — start `optio local up` on the host.").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if !stream.retrying, stream.connState == .disconnected {
                Button("Reconnect") { stream.reconnect() }.font(.caption.weight(.semibold))
            }
        }
        .padding(10)
        .floatingGlass(in: RoundedRectangle(cornerRadius: Radius.card))
        .foregroundStyle(stream.retrying ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.red))
        .padding(10)
    }

    private func connColor(_ s: LocalTerminalStream.ConnState) -> SwiftUI.Color {
        switch s {
        case .connecting: return Tone.idle.color
        case .connected: return Tone.success.color
        case .reconnecting: return Tone.idle.color
        case .disconnected: return Tone.danger.color
        }
    }

    private func connLabel(_ s: LocalTerminalStream.ConnState) -> String {
        switch s {
        case .connecting: return "connecting…"
        case .connected: return "connected"
        case .reconnecting: return "reconnecting…"
        case .disconnected: return "disconnected"
        }
    }
}

// MARK: - SwiftTerm wrapper

struct SwiftTermView: UIViewRepresentable {
    let stream: LocalTerminalStream
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator { Coordinator(stream: stream) }

    func makeUIView(context: Context) -> TerminalView {
        let font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        let view = TerminalView(frame: CGRect(x: 0, y: 0, width: 360, height: 400), font: font)
        view.terminalDelegate = context.coordinator
        TerminalTheme.apply(to: view, scheme: colorScheme)
        context.coordinator.scheme = colorScheme
        view.autocorrectionType = .no
        view.smartQuotesType = .no
        // Our own extra-keys bar lives in SwiftUI; drop SwiftTerm's accessory.
        view.inputAccessoryView = nil
        view.allowMouseReporting = false
        stream.bridge.attach(view)
        return view
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {
        context.coordinator.stream = stream
        if stream.bridge.view !== uiView { stream.bridge.attach(uiView) }
        if context.coordinator.scheme != colorScheme {
            context.coordinator.scheme = colorScheme
            TerminalTheme.apply(to: uiView, scheme: colorScheme)
        }
    }

    static func dismantleUIView(_ uiView: TerminalView, coordinator: Coordinator) {
        uiView.terminalDelegate = nil
    }

    /// SwiftTerm calls its delegate on the main thread; the stream is main-actor.
    final class Coordinator: NSObject, TerminalViewDelegate {
        var stream: LocalTerminalStream
        var scheme: ColorScheme?
        init(stream: LocalTerminalStream) { self.stream = stream }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            MainActor.assumeIsolated { stream.sendResize(cols: newCols, rows: newRows) }
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            let bytes = Array(data)
            MainActor.assumeIsolated { stream.sendInput(bytes: bytes) }
        }

        func scrolled(source: TerminalView, position: Double) {}

        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link) { MainActor.assumeIsolated { UIApplication.shared.open(url) } }
        }

        func bell(source: TerminalView) {
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }

        func clipboardCopy(source: TerminalView, content: Data) {
            UIPasteboard.general.string = String(decoding: content, as: UTF8.self)
        }

        func clipboardRead(source: TerminalView) -> Data? {
            UIPasteboard.general.string.map { Data($0.utf8) }
        }

        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}
