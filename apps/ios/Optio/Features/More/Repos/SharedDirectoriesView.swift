import SwiftUI
import Observation

@Observable
@MainActor
final class SharedDirectoriesModel {
    let repoId: String
    var directories: [SharedDirectoryRow] = []
    var usage: [String: String] = [:]
    var loading = false
    var error: Error?

    init(repoId: String) { self.repoId = repoId }

    func load(api: APIClient) async {
        loading = directories.isEmpty
        defer { loading = false }
        do {
            directories = try await api.listSharedDirectories(repoId: repoId)
            error = nil
        } catch {
            self.error = error
        }
    }
}

struct SharedDirectoriesView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @State private var model: SharedDirectoriesModel
    let maxPodInstances: Int

    @State private var showAdd = false
    @State private var pendingClear: SharedDirectoryRow?
    @State private var pendingDelete: SharedDirectoryRow?
    @State private var showRecycle = false
    @State private var busyId: String?
    @State private var notice: String?
    @State private var errorMessage: String?

    init(repoId: String, maxPodInstances: Int) {
        _model = State(initialValue: SharedDirectoriesModel(repoId: repoId))
        self.maxPodInstances = maxPodInstances
    }

    var body: some View {
        List {
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let error = model.error, model.directories.isEmpty {
                ErrorBanner(error: error) { Task { await model.load(api: api) } }
            } else if model.directories.isEmpty {
                EmptyState(title: "No shared directories", systemImage: "externaldrive",
                           message: "Add a persistent cache (npm, pip, cargo…) to speed up agent pods.")
            } else {
                Section {
                    ForEach(model.directories) { dir in
                        row(dir)
                    }
                } footer: {
                    Text("Each directory is a per-pod PVC; with \(maxPodInstances) pod instance\(maxPodInstances == 1 ? "" : "s") that is \(maxPodInstances) volume\(maxPodInstances == 1 ? "" : "s") per directory. Recycle pods after adding or removing one.")
                }
            }
            if context.isAdmin && !model.directories.isEmpty {
                Section {
                    Button { showRecycle = true } label: {
                        Label("Recycle pods to apply mounts", systemImage: "arrow.clockwise")
                    }
                }
            }
        }
        .navigationTitle("Shared directories")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if context.isAdmin {
                ToolbarItem(placement: .primaryAction) {
                    Button { showAdd = true } label: { Image(systemName: "plus") }
                }
            }
        }
        .task { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
        .sheet(isPresented: $showAdd) {
            NewSharedDirectorySheet(repoId: model.repoId) { await model.load(api: api) }
        }
        .confirmationDialog("Clear \"\(pendingClear?.name ?? "")\"?", isPresented: Binding(
            get: { pendingClear != nil }, set: { if !$0 { pendingClear = nil } }
        ), titleVisibility: .visible) {
            Button("Clear contents", role: .destructive) {
                guard let dir = pendingClear else { return }
                Task { await run(dir.id) { try await api.clearSharedDirectory(repoId: model.repoId, dirId: dir.id); notice = "Cleared \(dir.name ?? "directory")." } }
            }
        } message: {
            Text("Empties the persistent volume. Caches will rebuild on the next run.")
        }
        .confirmationDialog("Delete \"\(pendingDelete?.name ?? "")\"?", isPresented: Binding(
            get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let dir = pendingDelete else { return }
                Task { await run(dir.id) { try await api.deleteSharedDirectory(repoId: model.repoId, dirId: dir.id); await model.load(api: api) } }
            }
        } message: {
            Text("Removes the directory and its volume.")
        }
        .confirmationDialog("Recycle idle pods?", isPresented: $showRecycle, titleVisibility: .visible) {
            Button("Recycle") {
                Task { await run("recycle") {
                    let n = try await api.recycleRepoPods(model.repoId)
                    notice = n == 0 ? "No idle pods to recycle." : "Recycled \(n) pod\(n == 1 ? "" : "s")."
                } }
            }
        }
        .alert("Done", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") { notice = nil }
        } message: { Text(notice ?? "") }
        .moreErrorAlert($errorMessage)
    }

    private func row(_ dir: SharedDirectoryRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(dir.name ?? dir.id).font(.headline)
                Spacer()
                if busyId == dir.id { ProgressView().controlSize(.small) }
                Text("\(dir.sizeGi ?? 0) Gi").font(.caption).foregroundStyle(.secondary)
            }
            Text("\(dir.mountLocation ?? "workspace")/\(dir.mountSubPath ?? "")")
                .font(.caption.monospaced()).foregroundStyle(.secondary)
            if let d = dir.description, !d.isEmpty {
                Text(d).font(.footnote).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                if let u = model.usage[dir.id] { Text("Usage: \(u)") }
                if let c = dir.lastClearedAt { Text("Cleared \(c.relativeDescription)") }
                if let m = dir.lastMountedAt { Text("Mounted \(m.relativeDescription)") }
            }
            .font(.caption2).foregroundStyle(.tertiary)
            if context.isAdmin {
                HStack {
                    Button("Check usage") {
                        Task { await run(dir.id) {
                            let u = try await api.sharedDirectoryUsage(repoId: model.repoId, dirId: dir.id)
                            model.usage[dir.id] = u ?? "unavailable"
                        } }
                    }
                    Spacer()
                    Button("Clear", role: .destructive) { pendingClear = dir }
                }
                .font(.footnote)
                .buttonStyle(.borderless)
                .disabled(busyId != nil)
            }
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing) {
            if context.isAdmin {
                Button(role: .destructive) { pendingDelete = dir } label: { Label("Delete", systemImage: "trash") }
            }
        }
    }

    private func run(_ id: String, _ op: () async throws -> Void) async {
        busyId = id
        defer { busyId = nil }
        do { try await op() } catch { errorMessage = error.moreDescription }
    }
}

struct NewSharedDirectorySheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let repoId: String
    var onSaved: () async -> Void

    private static let presets: [(String, String, String)] = [
        ("npm", "npm-cache", ".npm"),
        ("pnpm", "pnpm-store", ".local/share/pnpm/store"),
        ("pip", "pip-cache", ".cache/pip"),
        ("uv", "uv-cache", ".cache/uv"),
        ("cargo", "cargo-registry", ".cargo/registry"),
        ("Go modules", "go-mod", "go/pkg/mod"),
        ("Gradle", "gradle-cache", ".gradle"),
        ("Maven", "m2-repo", ".m2/repository"),
        ("HuggingFace", "hf-cache", ".cache/huggingface"),
        ("Poetry", "poetry-cache", ".cache/pypoetry"),
    ]

    @State private var preset = ""
    @State private var name = ""
    @State private var description = ""
    @State private var mountLocation = "home"
    @State private var mountSubPath = ""
    @State private var sizeGi = 10
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Preset") {
                    Picker("Preset", selection: $preset) {
                        Text("Custom").tag("")
                        ForEach(Self.presets, id: \.0) { Text("\($0.0) — \($0.2)").tag($0.0) }
                    }
                    .onChange(of: preset) { _, p in
                        guard let hit = Self.presets.first(where: { $0.0 == p }) else { return }
                        name = hit.1
                        mountSubPath = hit.2
                        mountLocation = "home"
                        description = "\(hit.0) cache"
                    }
                }
                Section {
                    TextField("Name (slug)", text: $name)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    TextField("Description (optional)", text: $description)
                    Picker("Mount location", selection: $mountLocation) {
                        Text("Home (~)").tag("home")
                        Text("Workspace").tag("workspace")
                    }
                    TextField("Sub-path (e.g. .npm)", text: $mountSubPath)
                        .font(.body.monospaced())
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    Stepper("Size: \(sizeGi) Gi", value: $sizeGi, in: 1...100)
                }
            }
            .navigationTitle("New Shared Directory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text("Add") }
                    }
                    .disabled(saving || name.isEmpty || mountSubPath.isEmpty)
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await api.createSharedDirectory(repoId: repoId, SharedDirectoryInput(
                name: name.trimmingCharacters(in: .whitespaces),
                description: description.isEmpty ? nil : description,
                mountLocation: mountLocation,
                mountSubPath: mountSubPath.trimmingCharacters(in: .whitespaces),
                sizeGi: sizeGi
            ))
            await onSaved()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
