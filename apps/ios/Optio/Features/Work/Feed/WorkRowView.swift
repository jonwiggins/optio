import SwiftUI

/// One session as a row: status dot, name, `statusLabel · note`, the four
/// attribute chips (when / where / who / then), recency and PR link. Shared by
/// the Sessions list and the Overview board (`session-row.tsx`).
struct WorkRowView: View {
    let row: WorkRow

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.s) {
            StateDot(tone: row.status.tone).padding(.top, 7)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(alignment: .firstTextBaseline) {
                    Text(row.name.isEmpty ? "Untitled" : row.name)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: Spacing.s)
                    if let last = row.lastActivity {
                        Text(last.relativeDescription)
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                            .lineLimit(1)
                    }
                }
                HStack(spacing: 4) {
                    Text(row.statusLabel)
                        .foregroundStyle(row.status == .needsYou || row.status == .failed ? row.status.tone.textStyle : AnyShapeStyle(.secondary))
                    if let note = row.note {
                        Text("·").foregroundStyle(.tertiary)
                        Text(note).foregroundStyle(.tertiary).lineLimit(1)
                    }
                    if let pr = row.prUrl, let url = URL(string: pr) {
                        Spacer(minLength: Spacing.s)
                        Link(destination: url) {
                            HStack(spacing: 3) {
                                Image(systemName: "arrow.triangle.pull")
                                Text("PR")
                            }
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.fill.tertiary, in: Radius.smallShape)
                            .foregroundStyle(AppTheme.accent)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .font(.subheadline)
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 2) {
                    attr(row.whenSystemImage, row.when)
                    attr(row.where.systemImage, row.where.label, mono: true)
                    attr(row.whoSystemImage, row.whoLabel)
                    attr(row.then.systemImage, row.then.label)
                }
            }
        }
        .padding(.vertical, Spacing.row)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.name), \(row.statusLabel)")
    }

    private func attr(_ systemImage: String, _ label: String, mono: Bool = false) -> some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.caption2)
                .foregroundStyle(.quaternary)
                .frame(width: 12)
            Text(label)
                .font(mono ? .caption.monospaced() : .caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
