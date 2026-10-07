import Foundation

// Port of `apps/web/src/components/work-form/submit.ts`: the draft becomes a
// `WorkSpec` — the five attributes (`packages/shared/src/work/spec.ts`) — and
// `POST /api/work` derives the kind from them (`kindOfSpec`, the same rule as
// `deriveKind`) and writes the row, its trigger and, for a Job started now, its
// first run in one transaction: a rejected trigger leaves nothing behind.

extension WorkForm {
    /// Where the app goes once the work exists.
    struct Created: Sendable {
        let kind: Kind
        let destination: WorkDestination
        let toast: String
        /// A Pylon / Alertmanager / Datadog trigger's secret, returned this once
        /// (`WorkCreated.trigger.secret`): the form shows it before moving on,
        /// since no later read returns it.
        var secret: MintedSecret? = nil
    }

    struct MintedSecret: Hashable, Sendable {
        let type: EventTriggerType
        let triggerId: String
        let secret: String
    }

    /// `POST /api/work`'s reply (`WorkCreated` in @optio/shared).
    struct WorkCreated: Decodable, Sendable {
        struct Run: Decodable, Sendable { let id: String }
        struct Trigger: Decodable, Sendable {
            let id: String
            let secret: String?
        }

        let kind: String
        let id: String
        let href: String
        var run: Run? = nil
        var trigger: Trigger? = nil
    }

    /// The trigger row a draft asks for, if any — the same shape whatever kind of
    /// row it attaches to: a schedule, a webhook, a ticket filter, or a GitHub /
    /// Slack / Linear event.
    static func triggerFor(_ d: Draft) -> (type: String, config: [String: AnyCodable])? {
        if let event = d.when.event { return (event.rawValue, d.event.config) }
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

    /// The draft as the five attributes `/api/work` takes (web `specFor`). The
    /// server derives the kind from them and creates the row, its trigger, and —
    /// for a Job started now — its first run, together.
    static func specFor(_ d: Draft, repoUrl: String, name: String) -> [String: AnyCodable] {
        let kind = deriveKind(d)
        let local = isLocal(d)
        let trigger = triggerFor(d)
        let options = setOptions(d)
        let description = d.description.trimmingCharacters(in: .whitespacesAndNewlines)
        let branch = d.repoBranch.trimmingCharacters(in: .whitespaces)
        let runName = d.runName.trimmingCharacters(in: .whitespaces)
        var spec: [String: AnyCodable] = [
            "name": .string(name),
            "description": description.isEmpty ? .null : .string(description),
            "when": trigger.map { .object(["type": .string($0.type), "config": .object($0.config)]) } ?? .object(["type": .string("manual")]),
            "where": .object([
                "runTarget": .string(d.location.runTarget.rawValue),
                // A pod session is always in a repo pod; otherwise the repo is "with repo".
                "repoUrl": (d.withRepo || kind == .podSession) && !repoUrl.isEmpty ? .string(repoUrl) : .null,
                // Blank on a pod = the repo's default branch (the server resolves it,
                // #643). On a machine, a base branch is also what says "on a new branch".
                "repoBranch": !d.withRepo ? .null : !branch.isEmpty ? .string(branch) : local ? .string("main") : .null,
                "localHostId": local && !d.location.localHostId.isEmpty ? .string(d.location.localHostId) : .null,
                "localDir": local && !d.location.localDir.isEmpty ? .string(d.location.localDir) : .null,
            ]),
            "who": .object([
                "runtime": d.runtime == terminal ? .null : .string(d.runtime),
                "agentOptions": d.runtime == terminal ? .null : options.map { .object($0) } ?? .null,
                "model": pickedModel(d).map { .string($0) } ?? .null,
            ]),
            // A terminal that waits for you opens a shell: it has nothing to run.
            "what": .object([
                "prompt": .string(asksForPrompt(d) ? d.prompt.trimmingCharacters(in: .whitespacesAndNewlines) : ""),
                "runTitle": runName.isEmpty ? .null : .string(runName),
            ]),
            "then": .string(d.then.rawValue),
            "mergeWhenReady": .bool(d.mergeWhenReady),
            "maxRetries": .int(d.maxRetries),
            "priority": .int(d.priority),
        ]
        if kind == .repoTask, !d.dependsOn.isEmpty { spec["dependsOn"] = .array(d.dependsOn.map { .string($0) }) }
        if kind == .persistentAgent {
            let slug = d.agent.slug.trimmingCharacters(in: .whitespaces)
            spec["agent"] = .object([
                "slug": .string(slug.isEmpty ? slugify(name) : slug),
                "systemPrompt": d.agent.systemPrompt.isEmpty ? .null : .string(d.agent.systemPrompt),
                "agentsMd": .string(d.agent.agentsMd.isEmpty ? AgentFormSheet.defaultAgentsMd : d.agent.agentsMd),
                "podLifecycle": .string(d.agent.podLifecycle.rawValue),
            ])
        }
        // Owner + pod secrets ride on every Task, Job and agent (a machine run is always "me").
        if takesOwner(d) { spec.merge(accessPayload(d)) { _, new in new } }
        return spec
    }

    /// The kinds whose rows carry an owner (a pod or a machine run of a Task / Job / agent).
    static func takesOwner(_ d: Draft) -> Bool {
        switch deriveKind(d) {
        case .repoTask, .repoBlueprint, .standalone, .persistentAgent: return true
        case .localBlueprint, .localTerminal, .podSession: return false
        }
    }

    /// "Job 12", then "Job 12 (2)" … on a clash; a name you typed never changes.
    static func nameForAttempt(own: String, auto: String, attempt: Int) -> String {
        let own = own.trimmingCharacters(in: .whitespaces)
        if !own.isEmpty { return own }
        return attempt > 1 ? "\(auto) (\(attempt))" : auto
    }

    /// `details` from an API error body (`{ error, details }`): a 409 says which
    /// uniqueness it ran into (`name_taken`, `webhook_path_taken`).
    static func apiDetails(_ error: Error) -> String? {
        struct Body: Decodable { var details: String? }
        guard let api = error as? APIError, let body = api.body else { return nil }
        return (try? JSONDecoder().decode(Body.self, from: body))?.details
    }

    /// Only the work's own create can 409 on its name (a webhook path clash, which
    /// a new name doesn't fix, is `webhook_path_taken`).
    static func isNameClash(_ error: Error) -> Bool {
        (error as? APIError)?.status == 409 && apiDetails(error) == "name_taken"
    }

    /// Where a `WorkCreated` reply leads, what to say, and the secret it was given.
    static func made(_ created: WorkCreated, draft d: Draft, name: String) throws -> Created {
        guard let kind = Kind(rawValue: created.kind) else {
            throw APIError(status: 0, message: "The server made a kind of work this version of the app doesn't know (\(created.kind)).", body: nil)
        }
        let destination: WorkDestination
        switch kind {
        case .repoTask: destination = .task(created.id)
        case .repoBlueprint: destination = .blueprint(created.id)
        case .standalone: destination = created.run.map { .jobRun(jobId: created.id, runId: $0.id) } ?? .job(created.id)
        case .localBlueprint: destination = .localBlueprint(created.id)
        case .localTerminal: destination = .localTerminal(created.id)
        case .podSession: destination = .podSession(created.id)
        case .persistentAgent: destination = .agent(created.id)
        }
        var secret: MintedSecret?
        if let t = created.trigger, let s = t.secret, let type = d.when.event, type.selfSecret {
            secret = MintedSecret(type: type, triggerId: t.id, secret: s)
        }
        return Created(kind: kind, destination: destination, toast: toastFor(d, kind: kind, name: name, started: created.run != nil), secret: secret)
    }

    /// The toast a kind gets once it exists (web `toastFor`).
    static func toastFor(_ d: Draft, kind: Kind, name: String, started: Bool) -> String {
        switch kind {
        case .repoTask:
            return d.then == .untilMerged ? "\(name) started — it will work the PR until it merges" : "\(name) started — it will open a PR"
        case .localTerminal, .podSession: return "\(name) opened"
        case .persistentAgent: return "\(name) created"
        case .repoBlueprint, .standalone, .localBlueprint: return started ? "\(name) started" : "\(name) saved"
        }
    }
}

/// Runs the create against the API. `repoUrl` is the effective repo (a
/// registered repo's URL on a pod, the checkout's normalized remote on a machine).
@MainActor
struct WorkFormSubmitter {
    let api: APIClient

    /// Create the work the draft describes (`POST /api/work`). Jobs, scheduled
    /// Tasks and agents have unique names, and "Job N" is only a count: on a name
    /// clash keep the user's own name as an error, but bump an automatic one and
    /// try again (web `createWork`).
    func create(_ d: WorkForm.Draft, repoUrl: String, autoName: String) async throws -> WorkForm.Created {
        typealias F = WorkForm
        let auto = d.name.trimmingCharacters(in: .whitespaces).isEmpty
        var attempt = 1
        while true {
            let name = F.nameForAttempt(own: d.name, auto: autoName, attempt: attempt)
            do {
                let created = try await api.post("/api/work", body: F.specFor(d, repoUrl: repoUrl, name: name), as: F.WorkCreated.self)
                return try F.made(created, draft: d, name: name)
            } catch {
                if !auto || !F.isNameClash(error) || attempt >= 5 { throw error }
                attempt += 1
            }
        }
    }
}
