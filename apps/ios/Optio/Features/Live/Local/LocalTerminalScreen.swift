import Combine
import SwiftUI
import SwiftTerm

/// Focus view for one local terminal (`/local/:id`): header with state and
/// attention, then one of two faces — the **Transcript** (the agent's
/// conversation, reflowed for the phone, with a composer) or the **Screen**
/// (the SwiftTerm viewer fed by the stream WS, with an extra-keys bar).
///
/// The stream WS stays connected on both faces: its status / exit / attention
/// frames drive the header either way. Only the Screen face mounts SwiftTerm,
/// and even then the PTY is never resized until this phone claims the grid.
struct LocalTerminalScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    let terminalId: String
    var hosts: [LocalHost] = []
    /// Deep link `?compose=1` (Live Activity "Reply…"): raise the composer once loaded.
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
    @State private var stream: LocalTerminalStream?
    @State private var transcript: LocalTranscriptModel?
    /// An explicit Transcript ⇄ Screen choice; remembered for this screen's lifetime.
    @State private var viewChoice: LocalSessionView?

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
        .onChange(of: terminal?.id) { _, id in
            guard id != nil else { return }
            startStream()
            startTranscript()
        }
        // Remount the stream on leaving `pending` — it only attaches to a terminal
        // that is already launching/running when it connects.
        .onChange(of: terminal?.state == .pending) { was, isPending in
            if was, !isPending { startStream() }
        }
        .onChange(of: terminal.map(LocalPresentation.isDead)) { _, dead in
            if let dead { transcript?.setLive(!dead) }
        }
        .onDisappear {
            pollTask?.cancel(); pollTask = nil
            stream?.disconnect(); stream = nil
            transcript?.stop(); transcript = nil
        }
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
                        Text(LocalPresentation.waitsOnYou(terminal)
                             ? LocalPresentation.waitingLabel(terminal)
                             : LocalPresentation.stateLabel(terminal))
                            .font(.caption2)
                            .foregroundStyle(LocalPresentation.waitsOnYou(terminal) ? Tone.accent.textStyle : AnyShapeStyle(.secondary))
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

    // MARK: Faces

    private var hasTranscript: Bool { transcript?.hasEntries ?? false }

    private var resolvedView: LocalSessionView? {
        LocalSessionViewRule.resolve(
            choice: viewChoice,
            hasTranscript: hasTranscript,
            // A finished session's machine may still be reading its conversation off disk.
            loaded: (transcript?.loaded ?? false) && !(transcript?.readingConversation ?? false)
        )
    }

    @ViewBuilder
    private func content(_ terminal: LocalTerminal) -> some View {
        let view = resolvedView
        VStack(spacing: 0) {
            header(terminal, view: view)
            switch view {
            case nil:
                ZStack {
                    TerminalTheme.background(colorScheme)
                    ProgressView().tint(.secondary)
                }
            case .transcript?:
                LocalTranscriptFace(
                    terminalId: terminalId,
                    entries: transcript?.entries ?? [],
                    live: !LocalPresentation.isDead(terminal),
                    canSend: terminal.state == .running,
                    working: terminal.attentionState == .working,
                    autofocus: focusComposer,
                    onSend: sendToAgent
                )
            case .screen?:
                screenFace(terminal)
            }
        }
        .background(TerminalTheme.background(colorScheme))
    }

    @ViewBuilder
    private func screenFace(_ terminal: LocalTerminal) -> some View {
        if let stream {
            // A finished terminal replays the screen the daemon recorded at exit,
            // at the grid it ran at. Only when the stream has ended without a byte
            // — a row from before screens were recorded — does the persisted text
            // preview take the terminal's place. Never stack the two.
            if LocalPresentation.isDead(terminal), stream.settled, !stream.outputSeen,
               let preview = terminal.preview, !preview.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Last output").font(.sectionHeader).foregroundStyle(.secondary)
                    ScrollView {
                        Text(preview).font(.monoCaption).foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                }
                .padding(10)
                .frame(maxHeight: .infinity)
            } else {
                LocalTerminalStreamView(stream: stream, focusComposer: focusComposer)
            }
        } else {
            TerminalTheme.background(colorScheme)
        }
    }

    private func header(_ t: LocalTerminal, view: LocalSessionView?) -> some View {
        let needsYou = LocalPresentation.waitsOnYou(t)
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
        let showToggle = hasTranscript && view != nil
        return DetailHeader(
            state: LocalPresentation.stateLabel(t),
            tone: LocalPresentation.stateTone(t) == .accent ? .working : LocalPresentation.stateTone(t),
            line: detailLine,
            secondary: secondary,
            needsYou: needsYou ? LocalPresentation.waitingLabel(t).capitalizedFirst : nil,
            showsUsage: true
        ) {
            HStack(spacing: Spacing.s) {
                WorkLinkBadges(links: links, max: showToggle ? 1 : 2)
                if showToggle {
                    SessionViewToggle(view: view ?? .transcript) { viewChoice = $0 }
                }
            }
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

    private func startStream() {
        stream?.disconnect()
        let s = LocalTerminalStream(api: api, terminalId: terminalId)
        s.onStatus = { state, attention in applyStatus(state: state, attention: attention) }
        s.onExit = { code in
            if var t = self.terminal, !LocalPresentation.isDead(t) {
                t = LocalTerminal(copy: t, state: .exited, exitCode: code.map(Double.init))
                self.terminal = t
            }
            Task { await load(quiet: true) }
        }
        stream = s
        s.connect()
    }

    private func startTranscript() {
        guard transcript == nil, let terminal else { return }
        let t = LocalTranscriptModel(api: api, terminalId: terminalId)
        transcript = t
        t.start(live: !LocalPresentation.isDead(terminal))
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

    /// Transcript composer: the text plus Enter, over the stream when it's
    /// connected, else the REST fallback (`POST /input`).
    private func sendToAgent(_ text: String) async {
        let payload = text + "\r"
        if let stream, stream.connState == .connected {
            stream.sendInput(payload)
        } else {
            do { try await api.sendLocalTerminalInput(terminalId, data: payload) } catch { actionError = error.localizedDescription }
        }
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

// MARK: - Transcript ⇄ Screen toggle (session-view-toggle.tsx)

struct SessionViewToggle: View {
    let view: LocalSessionView
    var onChange: (LocalSessionView) -> Void

    var body: some View {
        Picker("Session view", selection: Binding(get: { view }, set: onChange)) {
            Image(systemName: "text.bubble")
                .accessibilityLabel("Transcript")
                .tag(LocalSessionView.transcript)
            Image(systemName: "terminal")
                .accessibilityLabel("Screen")
                .tag(LocalSessionView.screen)
        }
        .pickerStyle(.segmented)
        .fixedSize()
        .controlSize(.small)
    }
}

// MARK: - Transcript face (transcript-view.tsx + a composer)

struct LocalTranscriptFace: View {
    let terminalId: String
    let entries: [LocalTranscriptEntry]
    let live: Bool
    let canSend: Bool
    let working: Bool
    var autofocus = false
    var onSend: (String) async -> Void

    @State private var log: [AgentLogEntry] = []

    var body: some View {
        VStack(spacing: 0) {
            if entries.isEmpty {
                ContentUnavailableView {
                    Label(live ? "Nothing yet" : "No conversation recorded", systemImage: "text.bubble")
                } description: {
                    Text(live ? "The conversation shows up here as the agent works." : "Switch to Screen to see the terminal as it ran.")
                }
                .frame(maxHeight: .infinity)
            } else {
                AgentLogView(entries: log)
                    .frame(maxHeight: .infinity)
            }
            if live, !entries.isEmpty {
                HStack(spacing: 6) {
                    StateDot(tone: .working, size: 6)
                    Text("Session in progress").font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, Spacing.l)
                .padding(.bottom, 4)
            }
            if canSend {
                if working {
                    Text("Claude is working — sending will queue your message")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Spacing.l)
                        .padding(.bottom, 2)
                }
                ChatComposer(placeholder: "Message the agent", autofocus: autofocus, onSend: onSend)
            }
        }
        .onChange(of: entries.count, initial: true) { _, _ in
            log = LocalTranscriptLog.entries(entries, terminalId: terminalId)
        }
    }
}

// MARK: - Screen face (status strip + grid strip + SwiftTerm + extra keys)

struct LocalTerminalStreamView: View {
    @Environment(\.colorScheme) private var colorScheme
    let stream: LocalTerminalStream
    var focusComposer = false
    @State private var keyboardShown = false

    var body: some View {
        VStack(spacing: 0) {
            // Only speak up when the stream isn't healthy — the header carries the
            // state / attention badges, so a "connected · running" strip is noise.
            if stream.connState != .connected {
                strip(dot: connColor(stream.connState), text: Text(connLabel(stream.connState)))
            }
            if let grid = stream.foreignGrid {
                strip(dot: Tone.working.color, text: Text(stream.recorded ? "Recorded screen" : "Sized for another device") + Text("  \(grid.cols)×\(grid.rows)").foregroundStyle(.tertiary)) {
                    if !stream.recorded {
                        Button {
                            stream.claim()
                        } label: {
                            Label("Use this screen", systemImage: "arrow.up.left.and.arrow.down.right")
                                .font(.caption2.weight(.semibold))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.primary)
                    }
                }
            }
            ZStack(alignment: .top) {
                SwiftTermView(stream: stream)
                if let message = stream.errorMessage {
                    errorBanner(message)
                }
            }
            TerminalKeyBar(
                enabled: stream.connState == .connected,
                applicationCursor: stream.bridge.applicationCursor,
                send: { stream.typed(bytes: $0) },
                keyboardShown: keyboardShown,
                toggleKeyboard: {
                    if stream.bridge.isFocused { stream.bridge.blur() } else { stream.bridge.focus() }
                    keyboardShown = stream.bridge.isFocused
                }
            )
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in keyboardShown = true }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in keyboardShown = false }
        }
        .onAppear {
            if focusComposer {
                Task {
                    try? await Task.sleep(for: .milliseconds(600))
                    stream.bridge.focus()
                    keyboardShown = stream.bridge.isFocused
                }
            }
        }
    }

    private func strip<Trailing: View>(dot: SwiftUI.Color, text: Text, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) -> some View {
        HStack(spacing: 6) {
            Circle().fill(dot).frame(width: 6, height: 6)
            text.lineLimit(1)
            Spacer()
            trailing()
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(TerminalTheme.background(colorScheme))
        .overlay(alignment: .bottom) { Divider().opacity(0.5) }
    }

    private func errorBanner(_ message: String) -> some View {
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
        .floatingGlass(in: Radius.cardShape)
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

    func makeUIView(context: Context) -> LocalTerminalHostView {
        let font = UIFont.monospacedSystemFont(ofSize: TerminalSizing.baseFontPt, weight: .regular)
        let view = ScrollableTerminalView(frame: CGRect(x: 0, y: 0, width: 360, height: 400), font: font)
        view.terminalDelegate = context.coordinator
        TerminalTheme.apply(to: view, scheme: colorScheme)
        context.coordinator.scheme = colorScheme
        // Prompts to an agent are prose: keep iOS autocorrect, spell check and the
        // predictive bar. Smart quotes/dashes stay off so shell input survives.
        view.autocorrectionType = .default
        view.spellCheckingType = .default
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        // Our own extra-keys bar lives in SwiftUI; drop SwiftTerm's accessory.
        view.inputAccessoryView = nil
        view.allowMouseReporting = false
        // Taking the keyboard is the explicit "this screen is in use" signal.
        view.onFocus = { [weak stream] in stream?.claim() }
        let host = LocalTerminalHostView(terminal: view, baseFont: font)
        stream.bridge.attach(host, mode: stream.mode)
        return host
    }

    func updateUIView(_ uiView: LocalTerminalHostView, context: Context) {
        context.coordinator.stream = stream
        if stream.bridge.host !== uiView { stream.bridge.attach(uiView, mode: stream.mode) }
        if context.coordinator.scheme != colorScheme {
            context.coordinator.scheme = colorScheme
            TerminalTheme.apply(to: uiView.terminal, scheme: colorScheme)
            uiView.backgroundColor = uiView.terminal.backgroundColor
        }
    }

    static func dismantleUIView(_ uiView: LocalTerminalHostView, coordinator: Coordinator) {
        uiView.terminal.terminalDelegate = nil
        uiView.terminal.onFocus = nil
    }

    /// SwiftTerm calls its delegate on the main thread; the stream is main-actor.
    final class Coordinator: NSObject, TerminalViewDelegate {
        var stream: LocalTerminalStream
        var scheme: ColorScheme?
        init(stream: LocalTerminalStream) { self.stream = stream }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            MainActor.assumeIsolated { stream.viewGridChanged(TerminalGrid(cols: newCols, rows: newRows)) }
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

        /// Keystrokes and the terminal's own replies to queries (cursor position,
        /// device attributes) both arrive here, so this can't be the claim signal —
        /// a replayed `ESC[6n` would otherwise resize the PTY on attach. Keystrokes
        /// need the keyboard, and taking it (`onFocus`) is what claims the grid.
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
