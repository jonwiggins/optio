import SwiftUI
import UIKit

/// A tappable link chip for a PR / issue / ticket URL, marked with its glyph.
struct LinkChip: View {
    let url: URL
    let glyph: Glyph
    let text: String
    var mono = true

    var body: some View {
        Link(destination: url) {
            HStack(spacing: 3) {
                GlyphView(glyph: glyph, size: 11)
                Text(text)
            }
            .font(mono ? .caption2.monospaced() : .caption2.weight(.medium))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.fill.tertiary, in: Radius.smallShape)
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel([glyph.accessibilityLabel, text].filter { !$0.isEmpty }.joined(separator: " "))
    }
}

extension Text {
    /// The runtime's name with its logo inline before it, for the `Text.meta`
    /// lines of detail headers ("◆ Claude Code"). Runtimes without a mark get
    /// the plain name. The logo is decorative; the name carries the meaning.
    @MainActor
    static func agent(_ runtime: String?, _ label: String, textStyle: UIFont.TextStyle = .subheadline) -> Text {
        guard let brand = Brand(agentType: runtime),
              let image = InlineMark.image(brand.assetName, pointSize: UIFontMetrics(forTextStyle: textStyle).scaledValue(for: 17))
        else { return Text(label) }
        return Text(image).baselineOffset(-3) + Text(" \(label)")
    }
}

/// Vector brand assets drawn at a text-sized point size, so they can sit inside
/// a `Text` (an asset `Image` there keeps its 18 pt intrinsic size).
@MainActor
private enum InlineMark {
    private static var cache: [String: Image] = [:]

    static func image(_ name: String, pointSize: CGFloat) -> Image? {
        let key = "\(name)@\(Int(pointSize * 2))"
        if let hit = cache[key] { return hit }
        guard let source = UIImage(named: name) else { return nil }
        let size = CGSize(width: pointSize, height: pointSize)
        let drawn = UIGraphicsImageRenderer(size: size).image { _ in source.draw(in: CGRect(origin: .zero, size: size)) }
        let image = Image(uiImage: drawn.withRenderingMode(.alwaysTemplate))
        cache[key] = image
        return image
    }
}
