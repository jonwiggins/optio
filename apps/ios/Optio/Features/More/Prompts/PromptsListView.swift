import SwiftUI
import Observation

enum PromptKind: String, CaseIterable, Identifiable {
    case prompt, review, job, task
    var id: String { rawValue }

    var label: String {
        switch self {
        case .prompt: return "Coding prompt"
        case .review: return "Code review"
        case .job: return "Standalone task prompt"
        case .task: return "Repo task blueprint"
        }
    }

    var shortLabel: String {
        switch self {
        case .prompt: return "Coding"
        case .review: return "Review"
        case .job: return "Standalone"
        case .task: return "Tasks"
        }
    }

    static func label(for raw: String?) -> String {
        raw.flatMap(PromptKind.init(rawValue:))?.label ?? (raw ?? "prompt")
    }
}

@Observable
@MainActor
final class PromptsListModel {
    var templates: [PromptTemplateRow] = []
    var filter: String = "all"
    var loading = false
    var error: Error?

    var visible: [PromptTemplateRow] {
        filter == "all" ? templates : templates.filter { $0.kind == filter }
    }

    func load(api: APIClient) async {
        loading = templates.isEmpty
        defer { loading = false }
        do {
            templates = try await api.listPromptTemplates()
            error = nil
        } catch {
            self.error = error
        }
    }
}

struct PromptsListView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @State private var model = PromptsListModel()
    @State private var showEditor = false
    @State private var pendingDelete: PromptTemplateRow?
    @State private var errorMessage: String?

    private var filterOptions: [(String, String)] {
        [("all", "All")] + PromptKind.allCases.map { ($0.rawValue, $0.shortLabel) }
    }

    var body: some View {
        List {
            Section {
                ChipPicker(options: filterOptions, selection: $model.filter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let error = model.error, model.templates.isEmpty {
                ErrorBanner(error: error) { Task { await model.load(api: api) } }
            } else if model.visible.isEmpty {
                EmptyState(title: "No templates", systemImage: "text.quote",
                           message: model.filter == "all" ? "Create a reusable prompt template." : "No templates of this kind yet.")
            } else {
                Section {
                    ForEach(model.visible) { t in
                        NavigationLink {
                            PromptDetailView(template: t) { await model.load(api: api) }
                        } label: {
                            row(t)
                        }
                        .swipeActions(edge: .trailing) {
                            if context.isMember {
                                Button(role: .destructive) { pendingDelete = t } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Prompts")
        .toolbar {
            if context.isMember {
                ToolbarItem(placement: .primaryAction) {
                    Button { showEditor = true } label: { Image(systemName: "plus") }
                }
            }
        }
        .task { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
        .sheet(isPresented: $showEditor) {
            PromptEditorSheet(template: nil) { await model.load(api: api) }
        }
        .confirmationDialog("Delete \"\(pendingDelete?.name ?? "")\"?", isPresented: Binding(
            get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let t = pendingDelete else { return }
                Task {
                    do {
                        try await api.deletePromptTemplate(t.id)
                        await model.load(api: api)
                    } catch {
                        errorMessage = error.moreDescription
                    }
                }
            }
        }
        .moreErrorAlert($errorMessage)
    }

    private func row(_ t: PromptTemplateRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(t.name).font(.headline).lineLimit(1)
                Spacer()
                StatusBadge(text: PromptKind(rawValue: t.kind ?? "")?.shortLabel ?? (t.kind ?? "prompt"), color: AppTheme.accent)
            }
            if let d = t.description, !d.isEmpty {
                Text(d).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
            if let body = t.template {
                Text(body)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
            if let agent = t.defaultAgentType, !agent.isEmpty {
                Text(MoreAgentTypes.label(agent)).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
