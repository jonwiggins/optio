import SwiftUI

/// Tasks row: dot + title + `repo · agent · #519 · $0.78` + trailing time / terminal state.
struct TaskRowView: View {
    let task: TaskRow
    var subtasks: [TaskRow] = []

    private var stalled: Bool { task.isStalled == true && task.state == "running" }

    private var tone: Tone {
        if stalled { return .accent }
        return Tone.forState(task.state)
    }

    private var meta: Text? {
        var parts: [Text?] = [Text(task.repoShortName)]
        if let n = task.prNumber { parts.append(Text.mono("#\(n)")) }
        else if task.prUrl != nil, let last = task.prUrl?.split(separator: "/").last { parts.append(Text.mono("#\(last)")) }
        parts.append(Text(RunFormatting.agentLabel(task.agentType)))
        if let cost = Cost.formatIfNonZero(task.costUsd) { parts.append(Text(cost)) }
        if task.taskType == "review" { parts.append(Text("review")) }
        return Text.meta(parts)
    }

    private var trailing: (String, Tone?)? {
        switch task.state {
        case "completed":
            if task.prState == "merged" { return ("Merged", .success) }
            return ("Done", nil)
        case "failed": return ("Failed" + (task.completedAt.map { " \($0.relativeDescription)" } ?? ""), .danger)
        case "cancelled": return ("Cancelled", nil)
        case "pr_opened":
            if let checks = task.prChecksStatus, checks != "none" {
                return ("CI \(checks)", checks == "passing" ? .success : checks == "failing" ? .danger : nil)
            }
            return ("PR open", nil)
        case "needs_attention": return ("Needs you", .accent)
        default:
            if stalled { return ("Stalled", .accent) }
            return (task.createdAt?.relativeDescription ?? "", nil)
        }
    }

    private var footer: Text? {
        if (task.state == "failed" || task.state == "needs_attention"), let err = task.errorMessage, !err.isEmpty {
            return Text(err)
        }
        if task.pendingReason == "waiting_for_off_peak" { return Text("Held for off-peak window") }
        if !subtasks.isEmpty {
            return Text("\(subtasks.count) subtask\(subtasks.count == 1 ? "" : "s") · \(subtasks.filter { $0.state == "completed" }.count) done")
        }
        return nil
    }

    var body: some View {
        OptioRow(
            title: task.title,
            tone: tone,
            meta: meta,
            trailing: trailing?.0,
            trailingTone: trailing?.1,
            footer: footer
        )
    }
}
