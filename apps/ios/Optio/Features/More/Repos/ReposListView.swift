import SwiftUI
import Observation

@Observable
@MainActor
final class ReposListModel {
    var repos: [RepoRow] = []
    var loading = false
    var error: Error?

    func load(api: APIClient) async {
        loading = repos.isEmpty
        defer { loading = false }
        do {
            repos = try await api.listRepos()
            error = nil
        } catch {
            self.error = error
        }
    }
}

struct ReposListView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @State private var model = ReposListModel()
    @State private var showNew = false

    var body: some View {
        List {
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let error = model.error, model.repos.isEmpty {
                ErrorRow(error: error) { Task { await model.load(api: api) } }
            } else if model.repos.isEmpty {
                EmptyState(title: "No repositories", systemImage: "folder",
                           message: context.isAdmin ? "Add a repository to get started." : "Ask a workspace admin to add one.")
            } else {
                ForEach(model.repos) { repo in
                    NavigationLink {
                        RepoDetailView(repoId: repo.id) { await model.load(api: api) }
                    } label: {
                        row(repo)
                    }
                }
            }
        }
        .navigationTitle("Repos")
        .toolbar {
            if context.isAdmin {
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: { Image(systemName: "plus") }
                }
            }
        }
        .task { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
        .sheet(isPresented: $showNew) {
            NewRepoSheet { await model.load(api: api) }
        }
    }

    private func row(_ repo: RepoRow) -> some View {
        OptioRow(
            title: repo.displayName,
            meta: Text.meta([
                Text.mono(repo.defaultBranch ?? "main"),
                Text(repo.imagePreset ?? "base"),
                repo.autoMerge == true ? Text("auto-merge") : nil,
                repo.isPrivate == true ? Text("private") : nil,
            ]),
            titleLineLimit: 1
        )
    }
}
