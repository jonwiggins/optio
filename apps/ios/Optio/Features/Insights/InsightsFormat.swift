import Foundation
import SwiftUI

/// Formatting helpers shared by the Overview and Insights screens (mirrors the
/// small helpers at the top of the web analytics/costs/cluster pages).
enum InsightsFormat {
    /// "owner/repo" from a git URL.
    static func repoShortName(_ repoUrl: String) -> String {
        var s = repoUrl
        if s.hasSuffix(".git") { s.removeLast(4) }
        let parts = s.split(separator: "/").filter { !$0.isEmpty }
        guard parts.count >= 2 else { return repoUrl }
        return "\(parts[parts.count - 2])/\(parts[parts.count - 1])"
    }

    static func cost(_ value: Double?) -> String { Cost.format(value) }

    static func cost(_ value: String?) -> String { cost(Double(value ?? "")) }

    static func duration(_ seconds: Double?) -> String {
        guard let s = seconds, s > 0 else { return "—" }
        if s < 60 { return "\(Int(s))s" }
        if s < 3600 { return "\(Int((s / 60).rounded()))m" }
        let h = Int(s / 3600)
        let m = Int(((s.truncatingRemainder(dividingBy: 3600)) / 60).rounded())
        return m > 0 ? "\(h)h \(m)m" : "\(h)h"
    }

    static func tokens(_ count: Double?) -> String {
        guard let c = count, c > 0 else { return "0" }
        if c >= 1_000_000 { return String(format: "%.1fM", c / 1_000_000) }
        if c >= 1_000 { return String(format: "%.1fK", c / 1_000) }
        return String(Int(c))
    }

    static func modelShortName(_ model: String?) -> String {
        guard let model, model != "unknown", !model.isEmpty else { return "Unknown" }
        let l = model.lowercased()
        if l.contains("opus") { return "Opus" }
        if l.contains("sonnet") { return "Sonnet" }
        if l.contains("haiku") { return "Haiku" }
        return model
    }

    static func percent(_ value: Double?) -> String {
        guard let v = value else { return "—" }
        return "\(Int(v.rounded()))%"
    }

    /// Formats K8s quantities like "32813152Ki".
    static func k8sResource(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "—" }
        if value.hasSuffix("Ki"), let ki = Double(value.dropLast(2)) {
            if ki >= 1_048_576 { return String(format: "%.1f Gi", ki / 1_048_576) }
            if ki >= 1024 { return String(format: "%.0f Mi", ki / 1024) }
            return "\(Int(ki)) Ki"
        }
        if value.hasSuffix("Mi"), let mi = Double(value.dropLast(2)) {
            if mi >= 1024 { return String(format: "%.1f Gi", mi / 1024) }
            return "\(Int(mi)) Mi"
        }
        if value.hasSuffix("Gi"), let gi = Double(value.dropLast(2)) { return "\(Int(gi)) Gi" }
        if let bytes = Double(value) {
            if bytes >= 1_073_741_824 { return String(format: "%.1f Gi", bytes / 1_073_741_824) }
            if bytes >= 1_048_576 { return String(format: "%.0f Mi", bytes / 1_048_576) }
        }
        return value
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .iso8601)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Parses the analytics `date` buckets ("2026-09-17" or a full ISO timestamp).
    static func day(_ s: String?) -> Date? {
        guard let s else { return nil }
        if let d = dayFormatter.date(from: String(s.prefix(10))) { return d }
        return s.isoDate
    }

    static func action(_ action: String) -> String {
        action.replacingOccurrences(of: "[._]", with: " ", options: .regularExpression).capitalized
    }
}

/// Small period picker shared by Analytics and Costs (7d / 14d / 30d / 90d).
struct PeriodPicker: View {
    @Binding var days: Int
    var options: [Int] = [7, 14, 30, 90]

    var body: some View {
        Picker("Period", selection: $days) {
            ForEach(options, id: \.self) { Text("\($0)d").tag($0) }
        }
        .pickerStyle(.segmented)
    }
}

/// Card container with an uppercase caption title, matching the web's panels.
struct InsightCard<Content: View>: View {
    let title: String
    var systemImage: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text(title).font(.sectionHeader).foregroundStyle(.secondary)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
    }
}

/// Label · value · thin bar, used for "rate by repo/model" lists.
struct RateBar: View {
    let label: String
    let valueText: String
    let fraction: Double
    var color: Color = ChartPalette.color(1)

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(label).font(.footnote).lineLimit(1)
                Spacer()
                Text(valueText).font(.footnote.monospacedDigit()).foregroundStyle(.secondary).contentTransition(.numericText())
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.fill.secondary)
                    Capsule().fill(color).frame(width: geo.size.width * min(max(fraction, 0), 1))
                }
            }
            .frame(height: 5)
        }
    }
}

/// Friendly state for admin-only endpoints that answered 403.
struct AdminOnlyState: View {
    var what: String = "This section"

    var body: some View {
        EmptyState(title: "Admins only", systemImage: "lock", message: "\(what) is only available to workspace admins.")
    }
}

extension Error {
    var isForbidden: Bool { (self as? APIError)?.status == 403 }
}
