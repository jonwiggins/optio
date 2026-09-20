import Foundation

/// Pure helpers behind "the PTY follows whoever is using it" — a port of the
/// web's `sizing.ts`.
///
/// One PTY has one grid. Viewers that interact (focus the terminal, type, tap
/// "Use this screen") claim it and size it to their own screen; viewers that
/// are only watching render the owner's grid shrunk to fit instead of fighting
/// over the PTY. Kept UIKit-free so the arithmetic is unit-testable.
struct TerminalGrid: Equatable, Hashable, Sendable {
    var cols: Int
    var rows: Int
}

enum TerminalSizing {
    /// The font the terminal renders at when the grid is ours (points).
    static let baseFontPt: CGFloat = 12
    /// Below this the text is a texture, not a terminal — stop shrinking.
    static let minPassiveFontPt: CGFloat = 5
    /// Resize requests we've sent that the daemon hasn't echoed yet (oldest first).
    static let maxPendingGrids = 32

    enum Mode: Equatable {
        /// No one has claimed the grid yet — render at our own natural fit.
        case unclaimed
        /// We asked for this grid; it's ours.
        case owner
        /// Another viewer sized the PTY; we render its grid scaled to fit.
        case passive(TerminalGrid)
    }

    /// Font size that fits `cols` columns into `availableWidth`, given the
    /// font's cell width as a fraction of its point size (≈0.6 for typical
    /// monospace; measured from the renderer when available). Never larger than
    /// the base size — a passive phone showing a 60-column laptop grid still
    /// gets the normal font, only oversize grids shrink.
    static func passiveFontPt(
        availableWidth: CGFloat,
        cols: Int,
        cellWidthPerPt: CGFloat,
        base: CGFloat = baseFontPt,
        min minPt: CGFloat = minPassiveFontPt
    ) -> CGFloat {
        guard availableWidth > 0, cols > 0, cellWidthPerPt > 0 else { return base }
        let fits = (availableWidth / (CGFloat(cols) * cellWidthPerPt)).rounded(.down)
        return Swift.max(minPt, Swift.min(base, fits))
    }

    /// Record a grid we just asked the daemon for.
    static func pushSentGrid(_ sent: [TerminalGrid], _ grid: TerminalGrid) -> [TerminalGrid] {
        var next = sent
        next.append(grid)
        if next.count > maxPendingGrids { next.removeFirst(next.count - maxPendingGrids) }
        return next
    }

    /// The daemon echoed `grid`: if it matches one of our pending requests, that
    /// request and every older one are answered (echoes arrive in order). Returns
    /// the remaining queue, or nil when the echo matched nothing we sent.
    static func ackSentGrid(_ sent: [TerminalGrid], _ grid: TerminalGrid) -> [TerminalGrid]? {
        guard let i = sent.firstIndex(of: grid) else { return nil }
        return Array(sent[(i + 1)...])
    }

    /// Next mode when the daemon announces the PTY grid. `natural` is what a fit
    /// to our own screen would produce; `sent` the grids we've asked for that
    /// haven't been echoed yet.
    ///
    /// Every echo of our own request is still ours — not just the latest: a
    /// claim can fit twice in quick succession, so the echo of the first request
    /// lands after the second was sent.
    ///
    /// `recorded`: the terminal has exited and this is the grid its final screen
    /// was drawn for. There is no PTY left to size, so the grid is pinned —
    /// always passive, even when it happens to equal our natural fit — so a
    /// rotation can never reflow the replayed screen into something else.
    static func onGridAnnounced(
        _ mode: Mode,
        _ grid: TerminalGrid,
        natural: TerminalGrid,
        sent: [TerminalGrid],
        recorded: Bool = false
    ) -> Mode {
        if recorded { return .passive(grid) }
        if mode == .owner {
            // One of our own requests echoed back — still ours. Anything else means
            // another viewer took over since.
            return sent.contains(grid) ? .owner : .passive(grid)
        }
        // Unclaimed or already passive: if the announced grid happens to be our
        // natural fit there's nothing to scale, and no reason to show the strip.
        return grid == natural ? .unclaimed : .passive(grid)
    }
}
