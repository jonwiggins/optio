import SwiftUI

/// Add a repository: paste a URL, validate it against the server, pick the
/// defaults, then create + patch like the web wizard does.
struct NewRepoSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    var onCreated: () async -> Void

    @State private var repoUrl = ""
    @State private var fullName = ""
    @State private var defaultBranch = "main"
    @State private var isPrivate = false
    @State private var validated = false
    @State private var validating = false
    @State private var validationError: String?
    @State private var imagePreset = "base"
    @State private var maxConcurrentTasks = 2
    @State private var reviewEnabled = false
    @State private var reviewTrigger = "on_ci_pass"
    @State private var autoResume = false
    @State private var autoMerge = false
    @State private var creating = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://github.com/owner/repo", text: $repoUrl)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .onChange(of: repoUrl) { _, _ in validated = false; validationError = nil }
                    Button {
                        Task { await validate() }
                    } label: {
                        if validating { ProgressView() } else { Label("Validate", systemImage: "magnifyingglass") }
                    }
                    .disabled(validating || repoUrl.trimmingCharacters(in: .whitespaces).isEmpty)
                    if let validationError {
                        Label(validationError, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(.red)
                    }
                    if validated {
                        Label("\(fullName) · \(isPrivate ? "private" : "public")", systemImage: "checkmark.circle.fill")
                            .font(.footnote).foregroundStyle(.green)
                    }
                } header: {
                    Text("Repository")
                } footer: {
                    Text("Optio fetches the repo metadata using the workspace GITHUB_TOKEN. If validation fails you can still fill in the details manually.")
                }

                Section("Details") {
                    TextField("owner/repo", text: $fullName)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    TextField("Default branch", text: $defaultBranch)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    Toggle("Private repository", isOn: $isPrivate)
                }

                Section("Container image") {
                    Picker("Preset", selection: $imagePreset) {
                        ForEach(MoreImagePresets.all, id: \.0) { Text($0.1).tag($0.0) }
                    }
                }

                Section("Agent") {
                    Stepper("Max concurrent tasks: \(maxConcurrentTasks)", value: $maxConcurrentTasks, in: 1...50)
                }

                Section("PR lifecycle") {
                    Toggle("Automatic code review", isOn: $reviewEnabled.animation())
                    if reviewEnabled {
                        Picker("Trigger", selection: $reviewTrigger) {
                            Text("After CI passes").tag("on_ci_pass")
                            Text("Immediately on PR open").tag("on_pr")
                            Text("Manual only").tag("manual")
                        }
                    }
                    Toggle("Auto-resume on CI failure / conflicts / review changes", isOn: $autoResume)
                    Toggle("Auto-merge when checks pass", isOn: $autoMerge)
                }
            }
            .navigationTitle("Add Repository")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await create() } } label: {
                        if creating { ProgressView() } else { Text("Create") }
                    }
                    .disabled(creating || repoUrl.isEmpty || fullName.isEmpty)
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private func validate() async {
        validating = true
        defer { validating = false }
        validationError = nil
        do {
            let res = try await api.validateRepo(url: repoUrl.trimmingCharacters(in: .whitespaces))
            if res.valid, let info = res.repo {
                fullName = info.fullName ?? fullName
                defaultBranch = info.defaultBranch ?? defaultBranch
                isPrivate = info.isPrivate ?? isPrivate
                validated = true
            } else {
                validationError = res.error ?? "Could not access repository"
                inferFullName()
            }
        } catch {
            validationError = error.moreDescription
            inferFullName()
        }
    }

    private func inferFullName() {
        guard fullName.isEmpty, let url = URL(string: repoUrl) else { return }
        let parts = url.path.split(separator: "/").map(String.init)
        if parts.count >= 2 {
            let repo = parts[1].hasSuffix(".git") ? String(parts[1].dropLast(4)) : parts[1]
            fullName = "\(parts[0])/\(repo)"
        }
    }

    private func create() async {
        creating = true
        defer { creating = false }
        do {
            let repo = try await api.createRepo(RepoCreateInput(
                repoUrl: repoUrl.trimmingCharacters(in: .whitespaces),
                fullName: fullName.trimmingCharacters(in: .whitespaces),
                defaultBranch: defaultBranch,
                isPrivate: isPrivate
            ))
            var patch = RepoUpdateInput()
            patch.imagePreset = imagePreset
            patch.maxConcurrentTasks = maxConcurrentTasks
            patch.reviewEnabled = reviewEnabled
            patch.reviewTrigger = reviewTrigger
            patch.autoResume = autoResume
            patch.autoMerge = autoMerge
            _ = try? await api.updateRepo(repo.id, patch)
            await onCreated()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
