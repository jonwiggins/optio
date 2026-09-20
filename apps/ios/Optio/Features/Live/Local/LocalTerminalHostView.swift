import SwiftTerm
import UIKit

/// Hosts the SwiftTerm view for an Optio Local terminal and owns its grid.
///
/// SwiftTerm derives cols × rows from the view's frame and font, and — unlike
/// xterm — does not reflow on resize, so this host never lets the frame drift
/// on its own: it sets font and frame together from the current `TerminalSizing.Mode`.
///
/// - `owner` / `unclaimed`: base font, frame = our bounds (natural fit).
/// - `passive(grid)`: the announced grid, shrunk to fit — font picked so
///   `cols` fit the width (and `rows` the height, so a glance shows the whole
///   screen), frame = exactly that grid. A grid clamped at the minimum font may
///   be wider than the screen; this scroll view then pans it.
final class LocalTerminalHostView: UIScrollView {
    let terminal: ScrollableTerminalView
    /// Called when the terminal's own grid changes (any mode). Only the owner
    /// tells the PTY; the stream decides.
    var onLayoutSettled: (() -> Void)?

    private let baseFont: UIFont
    private(set) var settled = false

    var mode: TerminalSizing.Mode = .unclaimed {
        didSet {
            guard mode != oldValue else { return }
            applyMode()
        }
    }

    init(terminal: ScrollableTerminalView, baseFont: UIFont) {
        self.terminal = terminal
        self.baseFont = baseFont
        super.init(frame: terminal.frame)
        addSubview(terminal)
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = true
        isScrollEnabled = false
        contentInsetAdjustmentBehavior = .never
        backgroundColor = terminal.backgroundColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        applyMode()
    }

    /// What a fit to our own screen would produce at the base font.
    func naturalGrid() -> TerminalGrid {
        let cell = Self.cellSize(for: baseFont, scale: displayScale)
        return TerminalGrid(
            cols: max(1, Int(bounds.width / cell.width)),
            rows: max(1, Int(bounds.height / cell.height))
        )
    }

    private var displayScale: CGFloat { max(traitCollection.displayScale, 1) }

    /// The cell a font renders at — the same arithmetic as SwiftTerm's
    /// `computeFontDimensions`, so a frame computed from it lands on exactly the
    /// intended grid.
    static func cellSize(for font: UIFont, scale: CGFloat, lineSpacing: CGFloat = 1) -> CGSize {
        let height = ceil((font.ascender - font.descender + font.leading) * lineSpacing)
        let width = ("W" as NSString).size(withAttributes: [.font: font]).width
        let snappedWidth = (width * scale).rounded() / scale
        let snappedHeight = ceil(height * scale) / scale
        return CGSize(width: max(1, snappedWidth), height: max(1, min(snappedHeight, 8192)))
    }

    private func applyMode() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        switch mode {
        case .owner, .unclaimed:
            setFontAndFrame(font: baseFont, frame: CGRect(origin: .zero, size: bounds.size))
            contentSize = bounds.size
            contentOffset = .zero
            isScrollEnabled = false
        case .passive(let grid):
            let base = Self.cellSize(for: baseFont, scale: displayScale)
            let pt = min(
                TerminalSizing.passiveFontPt(availableWidth: bounds.width, cols: grid.cols, cellWidthPerPt: base.width / baseFont.pointSize),
                TerminalSizing.passiveFontPt(availableWidth: bounds.height, cols: grid.rows, cellWidthPerPt: base.height / baseFont.pointSize)
            )
            let font = pt == baseFont.pointSize ? baseFont : baseFont.withSize(pt)
            let cell = Self.cellSize(for: font, scale: displayScale)
            // Half a cell of slack so Int(width / cell) can't round down a column.
            let size = CGSize(
                width: cell.width * (CGFloat(grid.cols) + 0.5),
                height: cell.height * (CGFloat(grid.rows) + 0.5)
            )
            setFontAndFrame(font: font, frame: CGRect(origin: .zero, size: size))
            contentSize = CGSize(width: max(size.width, bounds.width), height: max(size.height, bounds.height))
            isScrollEnabled = size.width > bounds.width + 0.5 || size.height > bounds.height + 0.5
        }
        if !settled {
            settled = true
            onLayoutSettled?()
        }
    }

    /// SwiftTerm truncates (never reflows) when the grid shrinks, and both a font
    /// change and a frame change resize it. Order the two so the intermediate
    /// grid is never smaller than both the current and the target grid: a
    /// shrinking font goes first (cols grow, then the frame trims to target), a
    /// growing font goes last (the frame lands ≥ target at the old cell, then
    /// the font trims to target).
    private func setFontAndFrame(font: UIFont, frame: CGRect) {
        let fontChanged = terminal.font.pointSize != font.pointSize
        let frameChanged = terminal.frame != frame
        guard fontChanged || frameChanged else { return }
        if fontChanged, font.pointSize < terminal.font.pointSize {
            terminal.font = font
            if frameChanged { terminal.frame = frame }
        } else {
            if frameChanged { terminal.frame = frame }
            if fontChanged { terminal.font = font }
        }
        terminal.setNeedsLayout()
        terminal.layoutIfNeeded()
    }
}
