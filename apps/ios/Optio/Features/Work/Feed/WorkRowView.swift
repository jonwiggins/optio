import SwiftUI

/// One session as a row: status dot, name, `statusLabel · note`, the four
/// attribute chips (when / where / who / then), recency and PR link. Shared by
/// the Sessions list and the Overview board (`session-row.tsx`).
struct WorkRowView: View {
    @Environment(SessionStore.self) private var session
    let row: WorkRow
    @ScaledMetric(relativeTo: .caption) private var attributeIconSize: CGFloat = 12
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Replaces the Where chip's text where the place is already said around the
    /// row (the Machines screen lists a machine's work under it, so its rows
    /// name only the directory).
    var whereLabel: String? = nil

    /// Private work carries the chip (Private · Name for someone else's, which
    /// only an admin sees); the organization's is the norm and carries none.
    private var privateTag: PrivateTag {
        PrivateTag(ownerUserId: row.ownerUserId, ownerName: row.ownerName,
                   viewerId: session.user?.id, isAdmin: session.user?.isAdmin ?? false)
    }

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.s) {
            StateDot(tone: row.status.tone).padding(.top, 7)
            VStack(alignment: .leading, spacing: Spacing.s) {
                HStack(alignment: .firstTextBaseline) {
                    Text(row.name.isEmpty ? "Untitled" : row.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    privateTag
                    Spacer(minLength: Spacing.s)
                    if let last = row.lastActivity {
                        Text(last.relativeDescription)
                            .font(.footnote)
                            .foregroundStyle(AppTheme.mutedText)
                            .monospacedDigit()
                            .lineLimit(1)
                    }
                }
                HStack(spacing: 4) {
                    Text(row.statusLabel)
                        .foregroundStyle(row.status == .needsYou || row.status == .failed ? row.status.tone.textStyle : AnyShapeStyle(AppTheme.secondaryText))
                    if let note = row.note {
                        Text("·").foregroundStyle(AppTheme.mutedText)
                        Text(note).foregroundStyle(AppTheme.mutedText).lineLimit(1)
                    }
                    if let pr = row.prUrl, let url = URL(string: pr) {
                        Spacer(minLength: Spacing.s)
                        LinkChip(url: url, glyph: .pr(PRGlyphState(row.prState)), text: "PR", mono: false)
                    }
                }
                .font(.subheadline)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: typeSize.isAccessibilitySize ? 1 : 2), alignment: .leading, spacing: Spacing.s) {
                    attr(row.whenGlyph, row.when, a11y: row.origin?.label)
                    attr(.symbol(row.where.systemImage), whereLabel ?? row.where.label, mono: true)
                    attr(row.whoGlyph, row.whoLabel)
                    attr(.symbol(row.then.systemImage), row.then.label)
                }
            }
        }
        .padding(.vertical, Spacing.row)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([row.name, privateTag.text, row.statusLabel, row.origin.map { "from \($0.label)" }, row.prUrl == nil ? nil : PRGlyphState(row.prState).label].compactMap { $0 }.joined(separator: ", "))
    }

    private func attr(_ glyph: Glyph, _ label: String, mono: Bool = false, a11y: String? = nil) -> some View {
        HStack(spacing: 4) {
            Group {
                if case .symbol(let name) = glyph {
                    Image(systemName: name).resizable().scaledToFit()
                        .frame(width: attributeIconSize, height: attributeIconSize)
                        .foregroundStyle(AppTheme.secondaryText)
                } else {
                    // Brand marks read at secondary weight; quaternary washes them out.
                    GlyphView(glyph: glyph, size: attributeIconSize - 1, label: a11y).foregroundStyle(AppTheme.secondaryText)
                }
            }
            .frame(width: attributeIconSize)
            Text(label)
                .font(mono ? .caption.monospaced() : .caption)
                .foregroundStyle(AppTheme.secondaryText)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
