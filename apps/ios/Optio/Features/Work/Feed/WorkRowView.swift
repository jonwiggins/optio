import SwiftUI

/// One session as a row: status dot, name, `statusLabel · note`, the four
/// attribute chips (when / where / who / then), recency and PR link. Shared by
/// the Sessions list and the Overview board (`session-row.tsx`).
struct WorkRowView: View {
    let row: WorkRow
    /// Replaces the Where chip's text where the place is already said around the
    /// row (the Machines screen lists a machine's work under it, so its rows
    /// name only the directory).
    var whereLabel: String? = nil

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
                        LinkChip(url: url, glyph: .pr(PRGlyphState(row.prState)), text: "PR", mono: false)
                    }
                }
                .font(.subheadline)
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 2) {
                    attr(row.whenGlyph, row.when, a11y: row.origin?.label)
                    attr(.symbol(row.where.systemImage), whereLabel ?? row.where.label, mono: true)
                    attr(row.whoGlyph, row.whoLabel)
                    attr(.symbol(row.then.systemImage), row.then.label)
                }
            }
        }
        .padding(.vertical, Spacing.row)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([row.name, row.statusLabel, row.origin.map { "from \($0.label)" }, row.prUrl == nil ? nil : PRGlyphState(row.prState).label].compactMap { $0 }.joined(separator: ", "))
    }

    private func attr(_ glyph: Glyph, _ label: String, mono: Bool = false, a11y: String? = nil) -> some View {
        HStack(spacing: 4) {
            Group {
                if case .symbol(let name) = glyph {
                    Image(systemName: name).font(.caption2).foregroundStyle(.quaternary)
                } else {
                    // Brand marks read at secondary weight; quaternary washes them out.
                    GlyphView(glyph: glyph, size: 11, label: a11y).foregroundStyle(.secondary)
                }
            }
            .frame(width: 12)
            Text(label)
                .font(mono ? .caption.monospaced() : .caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
