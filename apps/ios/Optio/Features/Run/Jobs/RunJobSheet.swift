import SwiftUI

/// "Run Job" sheet — mirrors RunWorkflowDialog + WorkflowParamsForm: renders
/// one input per `paramsSchema.properties` entry (string / number / boolean /
/// enum) and POSTs `/api/jobs/:id/runs`.
struct RunJobSheet: View {
    let job: JobSummary
    var onStarted: (JobRun) -> Void

    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: String] = [:]
    @State private var bools: [String: Bool] = [:]
    @State private var submitting = false
    @State private var error: Error?

    private var fields: [JobParamField] { job.paramFields }

    private var missingRequired: Bool {
        fields.contains { f in
            f.required && f.type != "boolean" && (values[f.name] ?? f.defaultValue?.stringValue ?? "").isEmpty
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Start a new run of **\(job.name)**").font(.subheadline)
                }
                if fields.isEmpty {
                    Section {
                        Text("This job takes no parameters.").font(.footnote).foregroundStyle(.secondary)
                    }
                } else {
                    Section("Parameters") {
                        ForEach(fields) { field in
                            fieldView(field)
                        }
                    }
                }
                if let error { Section { ErrorBanner(error: error) } }
            }
            .navigationTitle("Run Job")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(submitting) }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await run() } } label: {
                        if submitting { ProgressView() } else { Label("Run", systemImage: "play.fill") }
                    }
                    .disabled(submitting || missingRequired)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func fieldView(_ field: JobParamField) -> some View {
        let label = field.required ? "\(field.name) *" : field.name
        VStack(alignment: .leading, spacing: 4) {
            if field.type == "boolean" {
                Toggle(label, isOn: Binding(
                    get: { bools[field.name] ?? field.defaultValue?.boolValue ?? false },
                    set: { bools[field.name] = $0 }
                ))
            } else if !field.options.isEmpty {
                Picker(label, selection: Binding(
                    get: { values[field.name] ?? field.defaultValue?.stringValue ?? "" },
                    set: { values[field.name] = $0 }
                )) {
                    Text("Select…").tag("")
                    ForEach(field.options, id: \.self) { Text($0).tag($0) }
                }
            } else {
                LabeledContent(label) {
                    TextField(field.defaultValue.flatMap { $0.stringValue ?? $0.doubleValue.map { String($0) } } ?? "", text: Binding(
                        get: { values[field.name] ?? "" },
                        set: { values[field.name] = $0 }
                    ))
                    .multilineTextAlignment(.trailing)
                    .keyboardType(field.type == "number" || field.type == "integer" ? .decimalPad : .default)
                    .autocorrectionDisabled()
                }
            }
            if let d = field.description, !d.isEmpty {
                Text(d).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func buildParams() -> [String: AnyCodable]? {
        var out: [String: AnyCodable] = [:]
        for f in fields {
            switch f.type {
            case "boolean":
                if let b = bools[f.name] ?? f.defaultValue?.boolValue { out[f.name] = .bool(b) }
            case "number", "integer":
                let raw = values[f.name] ?? ""
                if let i = Int(raw) { out[f.name] = .int(i) }
                else if let d = Double(raw) { out[f.name] = .double(d) }
                else if let def = f.defaultValue { out[f.name] = def }
            default:
                let raw = values[f.name] ?? ""
                if !raw.isEmpty { out[f.name] = .string(raw) }
                else if let def = f.defaultValue { out[f.name] = def }
            }
        }
        return out.isEmpty ? nil : out
    }

    private func run() async {
        submitting = true
        error = nil
        defer { submitting = false }
        do {
            let run = try await api.runJob(job.id, params: buildParams())
            onStarted(run)
            dismiss()
        } catch {
            self.error = error
        }
    }
}
