import Foundation

enum ScheduleFormat {
    /// "Every day 09:00" / "Every Monday 09:00" / "Every hour" for common cron shapes; raw cron otherwise.
    static func humanize(_ t: TriggerRow) -> String {
        switch t.type {
        case "schedule": return t.cronExpression.map(cron) ?? "Schedule"
        case "webhook": return "Webhook"
        case "ticket":
            let src = (t.ticketSource ?? "github").capitalized
            return t.ticketLabels.isEmpty ? "\(src) tickets" : "\(src) tickets · \(t.ticketLabels.joined(separator: ", "))"
        default: return "Manual"
        }
    }

    static func cron(_ expr: String) -> String {
        let f = expr.split(separator: " ").map(String.init)
        guard f.count == 5, let m = Int(f[0]) else { return expr }
        let time: (String) -> String = { h in String(format: "%02d:%02d", Int(h) ?? 0, m) }
        let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        if f[1] == "*" { return m == 0 ? "Every hour" : "Every hour at :\(String(format: "%02d", m))" }
        guard Int(f[1]) != nil else { return expr }
        if f[2] == "*", f[3] == "*" {
            if f[4] == "*" { return "Every day \(time(f[1]))" }
            if f[4] == "1-5" { return "Weekdays \(time(f[1]))" }
            if let d = Int(f[4]), d >= 0, d < 7 { return "Every \(days[d]) \(time(f[1]))" }
        }
        return expr
    }
}

func triggerIcon(_ type: String) -> String {
    switch type {
    case "schedule": return "clock"
    case "webhook": return "link"
    case "ticket": return "ticket"
    default: return "hand.tap"
    }
}
