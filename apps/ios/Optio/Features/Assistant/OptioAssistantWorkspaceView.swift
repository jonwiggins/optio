import SwiftUI

struct OptioAssistantView: View {
    @Environment(APIClient.self) private var api
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Bindable var workspace: OptioAssistantWorkspace
    @State private var directory = false
    @State private var details = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    @State private var visible = false
    @State private var showSettings = false
    @State private var settingsContext = MoreContext()

    private var wide: Bool { sizeClass == .regular }
    private var showingChat: Bool { !details && (!directory || wide) }

    var body: some View {
        NavigationStack {
            HStack(spacing: 0) {
                if wide && session.canCreateWork {
                    sessionDirectory.frame(width: 300)
                    Divider()
                }
                VStack(spacing: 0) {
                    if let error = workspace.error {
                        HStack(alignment: .top) {
                            Text(error).font(.footnote)
                            Spacer()
                            Button("Refresh") { Task { await workspace.refresh(api: api) } }
                        }.padding().foregroundStyle(.red).background(Surface.card)
                    }
                    content
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Surface.page)
            .navigationTitle("Optio Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if session.canCreateWork {
                    ToolbarItem(placement: .primaryAction) {
                        Button { searchFocused = false; Task { if await workspace.create(api: api) { directory = false; details = false } } } label: {
                            Image(systemName: "square.and.pencil")
                        }.accessibilityLabel("New session")
                            .disabled(workspace.isLoading || workspace.isSaving || workspace.isLegacy)
                    }
                }
            }
            .serverSwitcherToolbar()
            .sheet(isPresented: $showSettings) {
                NavigationStack {
                    OptioAgentSettingsView()
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showSettings = false } } }
                }.environment(settingsContext)
            }
            .task {
                visible = true
                if session.canCreateWork { await workspace.start(api: api) }
                await settingsContext.refresh(api: api, session: session)
            }
            .onDisappear { visible = false; workspace.stop() }
            .onChange(of: scenePhase) { _, phase in
                guard visible else { return }
                if phase == .background { workspace.stop() }
                if phase == .active && session.canCreateWork { Task { await workspace.start(api: api) } }
            }
            .onChange(of: workspace.selectedID) { _, _ in details = false; markRead() }
            .onChange(of: workspace.selectedModel?.signature) { _, _ in markRead() }
            .onChange(of: workspace.selectedModel?.hasLoadedHistory) { _, _ in markRead() }
            .onChange(of: showingChat) { _, _ in markRead() }
        }
    }

    @ViewBuilder private var content: some View {
        if !session.canCreateWork {
            ContentUnavailableView("Member access required", systemImage: "lock", description: Text("Ask a workspace admin for access to Optio Agent."))
        } else if directory && !wide {
            sessionDirectory
        } else if let selected = workspace.selected, let model = workspace.selectedModel {
            if details {
                OptioSessionDetails(workspace: workspace, session: selected, model: model, back: { details = false }, settings: { showSettings = true })
                    .id(selected.id)
            } else {
                sessionHeading(selected)
                OptioConversationView(model: model).id(selected.id)
            }
        } else if workspace.isLoading {
            ProgressView("Loading your sessions…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 20) {
                Image(systemName: "sparkles").font(.system(size: 36)).foregroundStyle(AppTheme.accent)
                    .padding(22).background(AppTheme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 26))
                Text("Room for every idea").font(.title2.weight(.semibold))
                Text("Plan a change, find your work, or start something new. Each session has its own conversation.")
                    .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button { Task { if await workspace.create(api: api) { directory = false } } } label: {
                    Label("Start a session", systemImage: "plus")
                }.buttonStyle(.borderedProminent).disabled(workspace.isSaving || workspace.error != nil)
                Button("Agent settings") { showSettings = true }.font(.subheadline)
            }.padding(32).frame(maxWidth: 480).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func sessionHeading(_ selected: OptioAssistantWorkspace.Session) -> some View {
        HStack(spacing: 12) {
            if !wide {
                Button { directory = true } label: {
                    ZStack(alignment: .topTrailing) {
                        Image(systemName: "list.bullet").frame(width: 44, height: 44)
                        if workspace.attentionCount > 0 {
                            Circle().fill(AppTheme.accent).frame(width: 7, height: 7).padding(7)
                        }
                    }
                }.accessibilityLabel("All sessions")
                    .accessibilityValue("\(workspace.sessions.count) sessions, \(workspace.attentionCount) with updates")
            }
            Text(workspace.title(for: selected)).font(.subheadline.weight(.semibold)).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button { searchFocused = false; details = true } label: { Image(systemName: "info.circle").frame(width: 44, height: 44) }
                .accessibilityLabel("Session details")
        }.padding(.horizontal, wide ? 20 : 8).padding(.vertical, 4).background(Surface.page)
    }

    private var sessionDirectory: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Sessions").font(.title2.weight(.bold))
                Spacer()
                if !wide && workspace.selected != nil {
                    Button("Done") { directory = false }.font(.subheadline.weight(.semibold))
                }
            }.padding(.horizontal, 20).padding(.top, 20)
            Text("Work continues when you switch.").font(.footnote).foregroundStyle(.secondary)
                .padding(.horizontal, 20).padding(.top, 4).padding(.bottom, 16)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Find a session", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("Find a session").focused($searchFocused)
                    .submitLabel(.search).onSubmit { searchFocused = false }
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.accessibilityLabel("Clear search")
                }
            }.padding(12).background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 16).padding(.bottom, 12)
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(matches) { item in sessionRow(item) }
                    if matches.isEmpty {
                        ContentUnavailableView(query.isEmpty ? "No sessions yet" : "No matching sessions", systemImage: "bubble.left.and.bubble.right", description: Text(query.isEmpty ? "Start a conversation using the compose button." : "Try a different name or start a new session."))
                    }
                }.padding(.horizontal, 12).padding(.bottom, 16)
            }.scrollDismissesKeyboard(.interactively).refreshable { await workspace.refresh(api: api) }
            Button { showSettings = true } label: {
                Label("Agent settings", systemImage: "gearshape").font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).padding(20)
            }.background(Surface.page)
        }.background(Surface.page).accessibilityIdentifier("Session directory")
    }

    private var matches: [OptioAssistantWorkspace.Session] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return workspace.sessions.filter { needle.isEmpty || workspace.title(for: $0).localizedCaseInsensitiveContains(needle) }
    }

    private func sessionRow(_ item: OptioAssistantWorkspace.Session) -> some View {
        let model = workspace.models[item.id]
        let selected = workspace.selectedID == item.id
        let unread = workspace.isUnread(item.id)
        let approval = model?.needsApproval == true
        let busy = model?.status == .thinking || model?.status == .executing
        let color: Color = approval ? Tone.accent.color : busy ? Tone.working.color : unread ? AppTheme.accent : Color.secondary
        let preview = model?.rows.last?.text ?? ""
        let status = approval ? "Needs your approval" : unread && model?.status == .ready ? "New reply" : model?.statusLabel ?? "Connecting…"
        return Button {
            searchFocused = false
            workspace.selectedID = item.id
            directory = false
            details = false
            workspace.markRead(item.id)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                GlyphView(glyph: .agent(model?.runtime ?? "optio"), size: 24)
                    .foregroundStyle(AppTheme.secondaryText)
                    .frame(width: 38, height: 38).background(AppTheme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 6) {
                    Text(workspace.title(for: item)).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(2)
                    Text(preview.isEmpty ? "A fresh conversation" : preview)
                        .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                    HStack(spacing: 5) {
                        Circle().fill(color).frame(width: 5, height: 5)
                        Text(status)
                            .font(.caption.weight(.medium)).foregroundStyle(approval ? Tone.accent.color : .secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                if selected { Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(AppTheme.accent) }
            }.padding(14).background(selected ? AppTheme.accent.opacity(0.07) : Surface.card, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(selected ? AppTheme.accent.opacity(0.25) : Color.secondary.opacity(0.08)))
        }.buttonStyle(.plain).accessibilityIdentifier("Session \(item.id)")
            .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func markRead() {
        if showingChat, let id = workspace.selectedID { workspace.markRead(id) }
    }
}

private struct OptioSessionDetails: View {
    @Environment(APIClient.self) private var api
    @Bindable var workspace: OptioAssistantWorkspace
    let session: OptioAssistantWorkspace.Session
    @Bindable var model: OptioAssistantModel
    let back: () -> Void
    let settings: () -> Void
    @State private var name = ""
    @State private var clear = false
    @State private var end = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: back) { Label("Conversation", systemImage: "chevron.left") }
                Spacer()
                Text("Session details").font(.subheadline.weight(.semibold))
            }.padding(20)
            Form {
                Section("Session name") {
                    TextField("Session name", text: $name).accessibilityIdentifier("Session name")
                    Button("Save name") { Task { if await workspace.rename(session.id, title: name, api: api) { back() } } }
                        .disabled(workspace.isSaving || workspace.isLoading || workspace.isLegacy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 100 || name == session.title)
                }
                Section("Agent") {
                    LabeledContent("Status", value: model.statusLabel)
                    if let identity = model.identity { LabeledContent("Running with", value: identity) }
                    Button(action: settings) { Label("Agent settings", systemImage: "gearshape") }
                    if !model.hasLoadedHistory { Button("Reconnect") { model.reconnect(api: api) } }
                }
                Section {
                    Button(role: .destructive) { clear = true } label: { Label("Clear conversation", systemImage: "eraser") }.disabled(!model.canReset)
                    Button(role: .destructive) { end = true } label: { Label("End session", systemImage: "stop.circle") }
                        .disabled(!model.canReset || workspace.isSaving || workspace.isLoading || workspace.isLegacy)
                } footer: {
                    Text(model.canReset ? "Clearing removes messages and keeps your draft. Ending removes the session from this list; its saved history and created work are kept." : "Finish queued work and resolve approvals before clearing or ending this session.")
                }
                if workspace.isLegacy {
                    Section { Text("Update your Optio server to create, rename, and end multiple sessions.").foregroundStyle(.secondary) }
                }
            }.scrollContentBackground(.hidden)
        }
        .onAppear { name = workspace.title(for: session) }
        .confirmationDialog("Clear conversation history?", isPresented: $clear, titleVisibility: .visible) {
            Button("Clear conversation", role: .destructive) { Task { await model.reset(); back() } }
        } message: { Text("Your draft and created work are kept. Saved messages will be removed.") }
        .alert("End this session?", isPresented: $end) {
            Button("End session", role: .destructive) { Task { if await workspace.end(session.id, api: api) { back() } } }.accessibilityIdentifier("Confirm end session")
            Button("Cancel", role: .cancel) {}
        } message: { Text("This also closes the session on your other devices. Its saved history and created work are kept.") }
    }
}
