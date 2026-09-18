import SwiftUI

/// Editable repo settings — the subset of the web's repo page that fits a phone form:
/// general, container image, agent (Claude Code options), PR lifecycle, review,
/// concurrency, and pod policy. Saved with one PATCH like the web.
struct RepoSettingsView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let repo: RepoRow
    var onSaved: () async -> Void

    @State private var defaultBranch = "main"
    @State private var defaultAgentType = "claude-code"
    @State private var imagePreset = "base"
    @State private var extraPackages = ""
    @State private var setupCommands = ""
    @State private var claudeModel = "opus"
    @State private var claudeContextWindow = "1m"
    @State private var claudeThinking = true
    @State private var claudeEffort = "high"
    @State private var maxTurnsCoding = 250
    @State private var maxTurnsReview = 10
    @State private var cautiousMode = false
    @State private var planningModeEnabled = false
    @State private var reviewEnabled = false
    @State private var reviewTrigger = "on_ci_pass"
    @State private var reviewAgentType = ""
    @State private var reviewModel = ""
    @State private var testCommand = ""
    @State private var autoResume = false
    @State private var autoMerge = false
    @State private var externalReviewMode = "off"
    @State private var externalReviewWaitForCi = true
    @State private var maxConcurrentTasks = 2
    @State private var maxPodInstances = 1
    @State private var maxAgentsPerPod = 2
    @State private var networkPolicy = "unrestricted"
    @State private var secretProxy = false
    @State private var offPeakOnly = false
    @State private var dockerInDocker = false
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("General") {
                TextField("Default branch", text: $defaultBranch)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                Picker("Default agent", selection: $defaultAgentType) {
                    ForEach(MoreAgentTypes.all, id: \.0) { Text($0.1).tag($0.0) }
                }
            }

            Section {
                Picker("Preset", selection: $imagePreset) {
                    ForEach(MoreImagePresets.all, id: \.0) { Text($0.1).tag($0.0) }
                }
                if let desc = MoreImagePresets.all.first(where: { $0.0 == imagePreset })?.2 {
                    Text(desc).font(.footnote).foregroundStyle(.secondary)
                }
                TextField("Extra apt packages (comma-separated)", text: $extraPackages)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                TextField("Setup commands (one per line)", text: $setupCommands, axis: .vertical)
                    .font(.footnote.monospaced())
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                    .lineLimit(2...6)
            } header: {
                Text("Container image")
            } footer: {
                Text("Setup commands run inside the pod after cloning.")
            }

            Section("Claude Code") {
                Picker("Model", selection: $claudeModel) {
                    Text("Opus").tag("opus"); Text("Sonnet").tag("sonnet"); Text("Haiku").tag("haiku")
                }
                Picker("Context window", selection: $claudeContextWindow) {
                    Text("200k").tag("200k"); Text("1m").tag("1m")
                }
                Toggle("Extended thinking", isOn: $claudeThinking)
                Picker("Effort", selection: $claudeEffort) {
                    Text("Low").tag("low"); Text("Medium").tag("medium"); Text("High").tag("high")
                }
                Stepper("Max turns: \(maxTurnsCoding)", value: $maxTurnsCoding, in: 1...1000, step: 10)
            }

            Section {
                Toggle(isOn: $cautiousMode.animation()) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Cautious mode")
                        Text("Draft PRs, no auto-merge; a human marks ready and merges.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .onChange(of: cautiousMode) { _, on in if on { autoMerge = false } }
                Toggle(isOn: $planningModeEnabled) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Planning mode")
                        Text("Agent plans and waits for approval before coding.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Toggle("Auto-resume on CI failure, conflicts, or review changes", isOn: $autoResume)
                Toggle("Auto-merge when checks pass and review completes", isOn: $autoMerge)
                    .disabled(cautiousMode)
            } header: {
                Text("PR lifecycle (Optio-opened PRs)")
            }

            Section {
                Toggle("Automatic code review", isOn: $reviewEnabled.animation())
                if reviewEnabled {
                    Picker("Trigger", selection: $reviewTrigger) {
                        Text("After CI passes").tag("on_ci_pass")
                        Text("Immediately on PR open").tag("on_pr")
                        Text("Manual only").tag("manual")
                    }
                    Picker("Review agent", selection: $reviewAgentType) {
                        Text("Inherit (\(MoreAgentTypes.label(repo.effectiveReviewAgentType ?? defaultAgentType)))").tag("")
                        ForEach(MoreAgentTypes.all, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    TextField("Review model (blank = inherit\(repo.effectiveReviewModel.map { ": \($0)" } ?? ""))", text: $reviewModel)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    TextField("Test command (blank = rely on CI)", text: $testCommand)
                        .font(.body.monospaced())
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    Stepper("Review max turns: \(maxTurnsReview)", value: $maxTurnsReview, in: 1...100)
                }
            } header: {
                Text("Code review")
            }

            Section {
                Picker("Mode", selection: $externalReviewMode) {
                    Text("Off").tag("off")
                    Text("On request").tag("on_request")
                    Text("On PR (hold)").tag("on_pr_hold")
                    Text("On PR (post)").tag("on_pr_post")
                }
                if externalReviewMode != "off" {
                    Toggle("Wait for CI before reviewing", isOn: $externalReviewWaitForCi)
                }
            } header: {
                Text("External PR review")
            } footer: {
                Text("Reviews for PRs opened by humans or other bots. Author and label filters are editable on the web.")
            }

            Section {
                Stepper("Max concurrent tasks: \(maxConcurrentTasks)", value: $maxConcurrentTasks, in: 1...50)
                Stepper("Max pod instances: \(maxPodInstances)", value: $maxPodInstances, in: 1...20)
                Stepper("Max agents per pod: \(maxAgentsPerPod)", value: $maxAgentsPerPod, in: 1...50)
            } header: {
                Text("Concurrency")
            } footer: {
                Text("Capacity = pod instances × agents per pod (\(maxPodInstances * maxAgentsPerPod)).")
            }

            Section("Pod policy") {
                Picker("Network egress", selection: $networkPolicy) {
                    Text("Unrestricted").tag("unrestricted")
                    Text("Restricted").tag("restricted")
                }
                Toggle("Secret proxy (Envoy sidecar)", isOn: $secretProxy)
                Toggle("Off-peak scheduling only", isOn: $offPeakOnly)
                Toggle("Docker-in-Docker", isOn: $dockerInDocker)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button { Task { await save() } } label: {
                    if saving { ProgressView() } else { Text("Save") }
                }
                .disabled(saving)
            }
        }
        .onAppear(perform: populate)
        .moreErrorAlert($errorMessage)
    }

    private func populate() {
        defaultBranch = repo.defaultBranch ?? "main"
        defaultAgentType = repo.defaultAgentType ?? "claude-code"
        imagePreset = repo.imagePreset ?? "base"
        extraPackages = repo.extraPackages ?? ""
        setupCommands = repo.setupCommands ?? ""
        claudeModel = repo.claudeModel ?? "opus"
        claudeContextWindow = repo.claudeContextWindow ?? "1m"
        claudeThinking = repo.claudeThinking ?? true
        claudeEffort = repo.claudeEffort ?? "high"
        maxTurnsCoding = repo.maxTurnsCoding ?? 250
        maxTurnsReview = repo.maxTurnsReview ?? 10
        cautiousMode = repo.cautiousMode ?? false
        planningModeEnabled = repo.planningModeEnabled ?? false
        reviewEnabled = repo.reviewEnabled ?? false
        reviewTrigger = repo.reviewTrigger ?? "on_ci_pass"
        reviewAgentType = repo.reviewAgentType ?? ""
        reviewModel = repo.reviewModel ?? ""
        testCommand = repo.testCommand ?? ""
        autoResume = repo.autoResume ?? false
        autoMerge = repo.autoMerge ?? false
        externalReviewMode = repo.externalReviewMode ?? "off"
        externalReviewWaitForCi = repo.externalReviewWaitForCi ?? true
        maxConcurrentTasks = repo.maxConcurrentTasks ?? 2
        maxPodInstances = repo.maxPodInstances ?? 1
        maxAgentsPerPod = repo.maxAgentsPerPod ?? 2
        networkPolicy = repo.networkPolicy ?? "unrestricted"
        secretProxy = repo.secretProxy ?? false
        offPeakOnly = repo.offPeakOnly ?? false
        dockerInDocker = repo.dockerInDocker ?? false
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let input = RepoUpdateInput(
            defaultBranch: defaultBranch.trimmingCharacters(in: .whitespaces),
            defaultAgentType: defaultAgentType,
            imagePreset: imagePreset,
            extraPackages: extraPackages.isEmpty ? nil : extraPackages,
            setupCommands: setupCommands.isEmpty ? nil : setupCommands,
            claudeModel: claudeModel,
            claudeContextWindow: claudeContextWindow,
            claudeThinking: claudeThinking,
            claudeEffort: claudeEffort,
            maxTurnsCoding: maxTurnsCoding,
            maxTurnsReview: maxTurnsReview,
            maxConcurrentTasks: maxConcurrentTasks,
            maxPodInstances: maxPodInstances,
            maxAgentsPerPod: maxAgentsPerPod,
            cautiousMode: cautiousMode,
            planningModeEnabled: planningModeEnabled,
            reviewEnabled: reviewEnabled,
            reviewTrigger: reviewTrigger,
            testCommand: testCommand,
            reviewAgentType: reviewAgentType.isEmpty ? .null : .string(reviewAgentType),
            reviewModel: reviewModel.isEmpty ? nil : reviewModel,
            autoResume: autoResume,
            autoMerge: cautiousMode ? false : autoMerge,
            externalReviewMode: externalReviewMode,
            externalReviewWaitForCi: externalReviewWaitForCi,
            networkPolicy: networkPolicy,
            secretProxy: secretProxy,
            offPeakOnly: offPeakOnly,
            dockerInDocker: dockerInDocker
        )
        do {
            _ = try await api.updateRepo(repo.id, input)
            await onSaved()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
