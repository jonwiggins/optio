import SwiftUI
import WidgetKit
import XCTest

/// Renders every Sessions widget family and the Live Activity regions over the
/// fixtures into labelled contact sheets (light + dark PNGs). They land in
/// `OPTIO_WIDGET_SHOT_DIR` when set, else in the simulator's tmp directory
/// (`…/CoreSimulator/Devices/<udid>/data/tmp/optio-widget-shots`, logged as
/// `widget shots →`). Hostless: `xcodebuild test -scheme WidgetSnapshots`.
@MainActor
final class WidgetContactSheetTests: XCTestCase {
    private var outDir: URL {
        if let dir = ProcessInfo.processInfo.environment["OPTIO_WIDGET_SHOT_DIR"] { return URL(fileURLWithPath: dir, isDirectory: true) }
        return FileManager.default.temporaryDirectory.appendingPathComponent("optio-widget-shots", isDirectory: true)
    }

    override func setUp() {
        super.setUp()
        NSLog("widget shots → %@", outDir.path)
    }

    // MARK: - Sheets

    func testSessionsHomeScreenFamilies() throws {
        let entries: [(String, GlanceEntry)] = [
            ("waiting · 2 servers", GlanceFixtures.waiting), ("single", GlanceFixtures.single), ("one of two", GlanceFixtures.one),
            ("legacy server (no tiles)", GlanceFixtures.legacy), ("quiet", GlanceFixtures.quiet), ("idle", GlanceFixtures.idle),
            ("offline", GlanceFixtures.offline), ("partial", GlanceFixtures.partial), ("stale", GlanceFixtures.stale), ("signed out", GlanceFixtures.signedOut),
        ]
        try sheet("sessions-small", columns: 4) {
            for (label, e) in entries { cell(label, size: CGSize(width: 170, height: 170)) { SessionsSmall(entry: e) } }
        }
        try sheet("sessions-medium", columns: 2) {
            for (label, e) in entries { cell(label, size: CGSize(width: 364, height: 170)) { SessionsBoard(entry: e, budget: 2, expandedRows: false) } }
        }
        try sheet("sessions-large", columns: 3) {
            for (label, e) in entries.prefix(6) { cell(label, size: CGSize(width: 364, height: 382)) { SessionsBoard(entry: e, budget: 6, expandedRows: true) } }
        }
    }

    func testSessionsAccessoryFamilies() throws {
        let entries: [(String, GlanceEntry)] = [
            ("waiting", GlanceFixtures.waiting), ("one of two", GlanceFixtures.one), ("quiet", GlanceFixtures.quiet),
            ("idle", GlanceFixtures.idle), ("offline", GlanceFixtures.offline), ("signed out", GlanceFixtures.signedOut),
        ]
        try sheet("sessions-accessories", columns: 3, accessory: true) {
            for (label, e) in entries {
                cell(label, size: CGSize(width: 76, height: 76), accessory: true) { SessionsCircular(entry: e) }
                cell(label, size: CGSize(width: 172, height: 76), accessory: true) { SessionsRectangular(entry: e).padding(6) }
                cell(label, size: CGSize(width: 234, height: 26), accessory: true) { SessionsInline(entry: e).font(.caption) }
            }
        }
    }

    func testLiveActivityLockScreen() throws {
        let states: [(String, WatchState)] = [
            ("waiting", WatchState.Samples.waiting), ("waiting · task", WatchState.Samples.waitingTask),
            ("waiting · legacy row", WatchState.Samples.waitingLegacy), ("working", WatchState.Samples.working),
            ("working · agent", WatchState.Samples.workingAgent), ("offline", WatchState.Samples.offline), ("done", WatchState.Samples.done),
        ]
        try sheet("live-activity-lock-screen", columns: 2) {
            for (label, s) in states { cell(label, size: CGSize(width: 364, height: 160), fit: true) { WatchLockScreenView(state: s) } }
        }
    }

    func testDynamicIslandRegions() throws {
        let states: [(String, WatchState)] = [
            ("waiting", WatchState.Samples.waiting), ("waiting · task", WatchState.Samples.waitingTask),
            ("working", WatchState.Samples.working), ("working · agent", WatchState.Samples.workingAgent),
            ("offline", WatchState.Samples.offline), ("done", WatchState.Samples.done),
        ]
        try sheet("dynamic-island", columns: 2, dark: true) {
            for (label, s) in states {
                cell(label, size: CGSize(width: 364, height: 170), fit: true) { IslandMock(state: s) }
            }
        }
    }

    // MARK: - Harness

    private struct Cell: Identifiable {
        let id = UUID()
        let label: String
        let view: AnyView
        let size: CGSize
    }

    @resultBuilder
    private enum CellBuilder {
        static func buildBlock(_ parts: [Cell]...) -> [Cell] { parts.flatMap { $0 } }
        static func buildExpression(_ cell: Cell) -> [Cell] { [cell] }
        static func buildExpression(_ cells: [Cell]) -> [Cell] { cells }
        static func buildArray(_ parts: [[Cell]]) -> [Cell] { parts.flatMap { $0 } }
        static func buildOptional(_ part: [Cell]?) -> [Cell] { part ?? [] }
        static func buildEither(first: [Cell]) -> [Cell] { first }
        static func buildEither(second: [Cell]) -> [Cell] { second }
    }

    /// One widget-shaped cell: the view clipped to its family size on the widget's
    /// container background, with a caption. `fit` lets the height grow to the content.
    private func cell<V: View>(_ label: String, size: CGSize, accessory: Bool = false, fit: Bool = false, @ViewBuilder _ content: () -> V) -> Cell {
        let body = content()
            .padding(accessory ? 0 : 14)
            .frame(width: size.width, height: fit ? nil : size.height, alignment: .topLeading)
            .frame(minHeight: fit ? size.height : nil)
        let framed: AnyView = accessory
            ? AnyView(body.environment(\.widgetRenderingMode, .vibrant).background(Color.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 12, style: .continuous)))
            : AnyView(body.background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous)))
        return Cell(label: label, view: framed, size: size)
    }

    private func sheet(_ name: String, columns: Int, accessory: Bool = false, dark: Bool? = nil, @CellBuilder _ cells: () -> [Cell]) throws {
        let all = cells()
        XCTAssertFalse(all.isEmpty)
        let schemes: [ColorScheme] = dark == true ? [.dark] : (accessory ? [.dark] : [.light, .dark])
        for scheme in schemes {
            let grid = LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16, alignment: .top), count: columns), alignment: .leading, spacing: 20) {
                ForEach(all) { c in
                    VStack(alignment: .leading, spacing: 6) {
                        c.view
                        Text(c.label).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(24)
            .background(scheme == .dark ? Color(white: 0.08) : Color(uiColor: .systemGroupedBackground))
            .environment(\.colorScheme, scheme)
            .frame(width: CGFloat(columns) * (all.map(\.size.width).max()! + 16) + 48)

            let renderer = ImageRenderer(content: grid)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage, "\(name) rendered nothing")
            XCTAssertGreaterThan(image.size.width, 100)
            XCTAssertGreaterThan(image.size.height, 40)
            try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
            let url = outDir.appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png")
            try XCTUnwrap(image.pngData()).write(to: url)
        }
    }
}

/// The island's regions laid out the way iOS does (approximately): expanded on top,
/// compact and minimal underneath. The real island is only visible on device.
private struct IslandMock: View {
    let state: WatchState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Expanded
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 8) {
                    WatchExpandedLeading(state: state).frame(width: 96, alignment: .leading)
                    WatchExpandedCenter(state: state)
                    WatchExpandedTrailing(state: state)
                }
                if let head = state.head, state.phase == .waiting || state.phase == .working {
                    SessionChips(item: head, short: true, grid: true, font: .caption2, spacing: 14).padding(.leading, 4)
                }
                WatchCountsLine(state: state)
                WatchButtons(state: state)
            }
            .padding(14)
            .background(Color.black, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(WatchCopy.tint(state.phase).opacity(0.6), lineWidth: 1))

            HStack(spacing: 12) {
                // Compact
                HStack(spacing: 0) {
                    WatchCompactLeading(state: state).padding(.leading, 10)
                    Circle().fill(Color(white: 0.15)).frame(width: 26, height: 26).padding(.horizontal, 10)
                    WatchCompactTrailing(state: state).padding(.trailing, 12)
                }
                .frame(height: 36)
                .background(Color.black, in: Capsule())
                // Minimal
                HStack(spacing: 0) {
                    Circle().fill(Color(white: 0.15)).frame(width: 26, height: 26).padding(.leading, 5)
                    WatchMinimal(state: state).padding(.horizontal, 8)
                }
                .frame(height: 36)
                .background(Color.black, in: Capsule())
                Spacer(minLength: 0)
            }
        }
        .environment(\.colorScheme, .dark)
    }
}
