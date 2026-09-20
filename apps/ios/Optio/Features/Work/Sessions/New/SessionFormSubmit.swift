import Foundation

// Port of `apps/web/src/components/session-form/submit.ts`: turn a draft into
// the row(s) its kind needs. Each branch calls the same endpoint the
// dedicated form for that kind calls, so nothing about how a Task, Job,
// automation, terminal, or agent runs changes — only where you make it.

extension SessionForm {
    /// Where the app goes once the session exists.
    struct Created: Sendable {
        let kind: Kind
        let destination: SessionDestination
        let toast: String
    }

    /// The generic trigger row (schedule / webhook / ticket) a draft asks for, if any.
    static func genericTrigger(_ d: Draft) -> (type: String, config: [String: AnyCodable])? {
        let t = d.trigger
        switch t.type {
        case .manual: return nil
        case .schedule:
            return ("schedule", ["cronExpression": .string((t.cronExpression ?? "").trimmingCharacters(in: .whitespaces))])
        case .webhook:
            return ("webhook", ["path": .string(t.webhookPath ?? "")])
        case .ticket:
            var config: [String: AnyCodable] = ["source": .string((t.ticketSource ?? .github).rawValue)]
            if let labels = t.ticketLabels, !labels.isEmpty { config["labels"] = .array(labels.map { .string($0) }) }
            return ("ticket", config)
        }
    }

    /// Only the options the user actually set (blank selects mean "default").
    static func setOptions(_ d: Draft) -> [String: AnyCodable]? {
        var out: [String: AnyCodable] = [:]
        for (k, v) in d.agentOptions where !v.isBlank { out[k] = v.anyCodable }
        return out.isEmpty ? nil : out
    }

    /// The model the draft picked for its runtime, for rows that carry just a model.
    static func pickedModel(_ d: Draft) -> String? {
        guard d.runtime != terminal else { return nil }
        let v = d.agentOptions[modelField(forRuntime: d.runtime)]?.stringValue ?? ""
        return v.isEmpty ? nil : v
    }

    /// The run-location fields a `POST /api/tasks` body carries (`runLocationPayload`):
    /// a pod spells "none" as explicit nulls, exactly like the web.
    static func locationPayload(_ d: Draft) -> [String: AnyCodable] {
        guard d.location.runTarget == .local else {
            return ["runTarget": .string("cluster"), "localHostId": .null, "localDir": .null, "localSessionMode": .null]
        }
        return [
            "runTarget": .string("local"),
            "localHostId": .string(d.location.localHostId),
            "localDir": .string(d.location.localDir),
            "localSessionMode": .string(d.location.localSessionMode.rawValue),
        ]
    }
}

/// Runs the dispatch against the API. `repoUrl` is the effective repo (a
/// registered repo's URL on a pod, the checkout's normalized remote on a machine).
@MainActor
struct SessionFormSubmitter {
    let api: APIClient

    private struct IdEnvelope: Decodable { struct Row: Decodable { let id: String }; let task: Row }
    private struct RunEnvelope: Decodable { let runId: String }
    private struct SessionEnvelope: Decodable { struct Row: Decodable { let id: String }; let session: Row }

    func create(_ d: SessionForm.Draft, repoUrl: String, autoName: String) async throws -> SessionForm.Created {
        typealias F = SessionForm
        let kind = F.deriveKind(d)
        let trimmedName = d.name.trimmingCharacters(in: .whitespaces)
        let name = trimmedName.isEmpty ? autoName : trimmedName
        let prompt = d.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trigger = F.genericTrigger(d)
        let options = F.setOptions(d)
        let model = F.pickedModel(d)
        let description: AnyCodable? = d.description.isEmpty ? nil : .string(d.description)

        switch kind {
        case .repoTask:
            var body: [String: AnyCodable] = [
                "type": .string("repo-task"),
                "title": .string(name),
                "prompt": .string(prompt),
                "agentType": .string(d.runtime),
                "maxRetries": .int(d.maxRetries),
                "priority": .int(d.priority),
                "repoUrl": .string(repoUrl),
                "repoBranch": .string(d.repoBranch),
            ]
            if let description { body["description"] = description }
            if let options { body["metadata"] = .object(["agentOptions": .object(options)]) }
            if !d.dependsOn.isEmpty { body["dependsOn"] = .array(d.dependsOn.map { .string($0) }) }
            body.merge(F.locationPayload(d)) { _, new in new }
            let id = try await api.post("/api/tasks", body: body, as: IdEnvelope.self).task.id
            return .init(kind: kind, destination: .task(id), toast: "\(name) started — it will open a PR")

        case .repoBlueprint:
            var body: [String: AnyCodable] = [
                "type": .string("repo-blueprint"),
                "title": .string(name),
                "name": .string(name),
                "prompt": .string(prompt),
                "agentType": .string(d.runtime),
                "maxRetries": .int(d.maxRetries),
                "priority": .int(d.priority),
                "repoUrl": .string(repoUrl),
                "repoBranch": .string(d.repoBranch),
                "enabled": .bool(true),
            ]
            if let description { body["description"] = description }
            body["agentOptions"] = options.map { .object($0) } ?? .null
            body.merge(F.locationPayload(d)) { _, new in new }
            let id = try await api.post("/api/tasks", body: body, as: IdEnvelope.self).task.id
            if let trigger { try await createTaskTrigger(id, trigger) }
            return .init(kind: kind, destination: .blueprint(id), toast: "\(name) saved")

        case .standalone:
            var body: [String: AnyCodable] = [
                "type": .string("standalone"),
                "title": .string(name),
                "name": .string(name),
                "prompt": .string(prompt),
                "agentType": .string(d.runtime),
                "maxRetries": .int(d.maxRetries),
                "enabled": .bool(true),
            ]
            if let description { body["description"] = description }
            if let model { body["model"] = .string(model) }
            body["agentOptions"] = options.map { .object($0) } ?? .null
            body.merge(F.locationPayload(d)) { _, new in new }
            let id = try await api.post("/api/tasks", body: body, as: IdEnvelope.self).task.id
            if let trigger {
                try await createTaskTrigger(id, trigger)
                return .init(kind: kind, destination: .job(id), toast: "\(name) saved")
            }
            let runId = try await api.post("/api/tasks/\(id)/runs", body: ["params": AnyCodable.object([:])], as: RunEnvelope.self).runId
            return .init(kind: kind, destination: .jobRun(jobId: id, runId: runId), toast: "\(name) started")

        case .localBlueprint:
            let blueprint = try await api.createLocalBlueprint(LocalBlueprintBody(
                name: name,
                description: d.description.isEmpty ? nil : d.description,
                hostId: d.location.localHostId,
                dir: d.location.localDir,
                repoUrl: d.withRepo && !repoUrl.isEmpty ? repoUrl : nil,
                commandTemplate: prompt,
                agent: d.runtime == F.terminal ? nil : LocalAgentKind(rawValue: d.runtime),
                clearAgent: d.runtime == F.terminal,
                spawnMode: .auto,
                sessionMode: d.then == .waitsForMe ? .interactive : .headless
            ))
            if let event = d.when.event {
                _ = try await api.createLocalBlueprintTrigger(blueprint.id, CreateLocalTriggerBody(type: event.rawValue, config: d.event.config, enabled: true))
            } else if let trigger {
                _ = try await api.createLocalBlueprintTrigger(blueprint.id, CreateLocalTriggerBody(type: trigger.type, config: trigger.config, enabled: true))
            }
            return .init(kind: kind, destination: .localBlueprint(blueprint.id), toast: "\(name) saved")

        case .localTerminal:
            let spec: LocalTerminalSpec
            if d.runtime == F.terminal {
                spec = .shell
            } else {
                spec = .agent(.init(agent: LocalAgentKind(rawValue: d.runtime) ?? .claudeCode, prompt: prompt.isEmpty ? nil : prompt, model: model))
            }
            let terminal = try await api.createLocalTerminal(CreateLocalTerminalBody(hostId: d.location.localHostId, dir: d.location.localDir, title: name, spec: spec))
            return .init(kind: kind, destination: .localTerminal(terminal.id), toast: "\(name) opened")

        case .podSession:
            let session = try await api.post("/api/sessions", body: ["repoUrl": AnyCodable.string(repoUrl)], as: SessionEnvelope.self).session
            return .init(kind: kind, destination: .podSession(session.id), toast: "\(name) opened")

        case .persistentAgent:
            let slug = d.agent.slug.trimmingCharacters(in: .whitespaces)
            var body: [String: AnyCodable] = [
                "slug": .string(slug.isEmpty ? F.slugify(name) : slug),
                "name": .string(name),
                "agentRuntime": .string(d.runtime),
                "model": model.map { .string($0) } ?? .null,
                "agentOptions": options.map { .object($0) } ?? .null,
                "systemPrompt": d.agent.systemPrompt.isEmpty ? .null : .string(d.agent.systemPrompt),
                "agentsMd": .string(d.agent.agentsMd.isEmpty ? AgentFormSheet.defaultAgentsMd : d.agent.agentsMd),
                "initialPrompt": .string(prompt),
                "podLifecycle": .string(d.agent.podLifecycle.rawValue),
            ]
            if let description { body["description"] = description }
            struct AgentEnvelope: Decodable { struct Row: Decodable { let id: String }; let agent: Row }
            let id = try await api.post("/api/persistent-agents", body: body, as: AgentEnvelope.self).agent.id
            if let trigger {
                _ = try await api.post("/api/persistent-agents/\(id)/triggers", body: ["type": AnyCodable.string(trigger.type), "config": .object(trigger.config), "enabled": .bool(true)], as: APIClient.Empty.self)
            }
            return .init(kind: kind, destination: .agent(id), toast: "\(name) created")
        }
    }

    private func createTaskTrigger(_ id: String, _ trigger: (type: String, config: [String: AnyCodable])) async throws {
        _ = try await api.post("/api/tasks/\(id)/triggers", body: ["type": AnyCodable.string(trigger.type), "config": .object(trigger.config), "enabled": .bool(true)], as: APIClient.Empty.self)
    }
}
