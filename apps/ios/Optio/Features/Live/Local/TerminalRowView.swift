import SwiftUI

/// Navigation targets for local terminals and automations. Registered by the
/// stacks that list them (Overview, Sessions) and by Machines for automations.
enum LocalRoute: Hashable {
    case terminal(id: String)
    case blueprint(id: String)
}

/// One terminal row: state dot, title, `host · dir · command`, trailing
/// activity time or attention reason.
struct TerminalRowView: View {
    let terminal: LocalTerminal
    var hostName: String?

    private var needsYou: Bool { LocalPresentation.waitsOnYou(terminal) }

    private var trailing: (String, Tone?) {
        if needsYou { return (LocalPresentation.waitingLabel(terminal), .accent) }
        if terminal.state == .error { return ("Error", .danger) }
        if terminal.state == .exited, let code = terminal.exitCode, code != 0 { return ("exit \(Int(code))", .danger) }
        if terminal.state == .exited { return ("Finished", nil) }
        if terminal.state == .pending { return (terminal.pendingReason == .hostOffline ? "Host offline" : "Held", nil) }
        return (LocalPresentation.activityDescription(terminal), nil)
    }

    private var meta: Text? {
        var parts: [Text?] = []
        if let hostName { parts.append(Text(hostName)) }
        parts.append(Text.mono(LocalPresentation.dirTail(terminal.dir)))
        if let command = terminal.command, !command.isEmpty { parts.append(Text.mono(command)) }
        else if !specLabel.isEmpty { parts.append(Text(specLabel)) }
        return Text.meta(parts)
    }

    private var footer: Text? {
        if LocalPresentation.isDead(terminal), let msg = terminal.errorMessage, !msg.isEmpty { return Text(msg) }
        let links = LocalPresentation.workLinks(terminal)
        if !links.isEmpty { return Text(links.prefix(3).map(WorkLinkBadges.shortLabel).joined(separator: " · ")).font(.monoFootnote) }
        return nil
    }

    var body: some View {
        OptioRow(
            title: terminal.title,
            tone: LocalPresentation.rowTone(terminal),
            meta: meta,
            trailing: trailing.0,
            trailingTone: trailing.1,
            footer: footer,
            titleLineLimit: 1
        )
    }

    private var specLabel: String {
        switch terminal.spec {
        case .shell: return "shell"
        case .command(let p): return p.command
        case .agent(let p): return LocalPresentation.agentLabel(p.agent)
        case .unknown: return ""
        }
    }
}
