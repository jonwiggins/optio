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

    /// Compact native capture for the README and product site, using the same
    /// production views and fixtures as the exhaustive contact sheets below.
    func testProductGalleryGlances() throws {
        try sheet("product-glances", columns: 2, dark: true) {
            cell("Home Screen widget", size: CGSize(width: 364, height: 170)) {
                WorkBoard(entry: GlanceFixtures.single, budget: 2, expandedRows: false)
            }
            cell("Live Activity", size: CGSize(width: 364, height: 170), fit: true, inset: 0) {
                WatchLockScreenView(state: WatchState.Samples.waitingOne)
            }
            cell("Dynamic Island", size: CGSize(width: 364, height: 170), fit: true) {
                IslandMock(state: WatchState.Samples.waitingTwo)
            }
            cell("Apple Watch Smart Stack", size: CGSize(width: 184, height: 122), inset: 0) {
                WatchSmartStackView(state: WatchState.Samples.waitingOne)
            }
        }
    }

    func testStartWidgetStates() throws {
        try sheet("start-widget", columns: 3) {
            for (label, entry) in [("ready", RunFixtures.idle), ("confirm", RunFixtures.armed), ("started", RunFixtures.started), ("choose work", RunFixtures.unconfigured), ("signed out", RunFixtures.signedOut)] {
                cell(label, size: CGSize(width: 170, height: 170)) { RunView(entry: entry) }
            }
        }
    }

    func testStartWidgetAtSmallSizes() throws {
        let long = RunEntry(date: .now, target: RunTargetEntity(id: "job:long", name: "Build and deploy the preview environment", kind: .job), confirm: true, signedIn: true, startedAt: nil, armedAt: .now.addingTimeInterval(-1))
        try sheet("start-small-type", columns: 4) {
            for (label, entry) in [("ready", RunFixtures.idle), ("confirm · long name", long), ("started", RunFixtures.started), ("choose work", RunFixtures.unconfigured)] {
                for size in [148.0, 170.0] {
                    cell("\(label) · \(Int(size))pt", size: CGSize(width: size, height: size)) {
                        RunView(entry: entry).environment(\.dynamicTypeSize, .xxLarge)
                    }
                }
            }
        }
    }

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
            for (label, e) in entries { cell(label, size: CGSize(width: 364, height: 170)) { WorkBoard(entry: e, budget: 2, expandedRows: false) } }
        }
        try sheet("sessions-large", columns: 3) {
            for (label, e) in entries.prefix(6) { cell(label, size: CGSize(width: 364, height: 382)) { WorkBoard(entry: e, budget: 6, expandedRows: true) } }
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
            ("waiting · 5", WatchState.Samples.waiting), ("waiting · 3", WatchState.Samples.waitingThree),
            ("waiting · 2", WatchState.Samples.waitingTwo), ("waiting · 1", WatchState.Samples.waitingOne),
            ("waiting · task", WatchState.Samples.waitingTask), ("waiting · legacy row", WatchState.Samples.waitingLegacy),
            ("working · 3", WatchState.Samples.working), ("working · 7", WatchState.Samples.workingMany),
            ("working · task", WatchState.Samples.workingTask), ("working · agent", WatchState.Samples.workingAgent),
            ("offline", WatchState.Samples.offline), ("done", WatchState.Samples.done),
        ]
        try sheet("live-activity-lock-screen", columns: 2) {
            for (label, s) in states { cell(label, size: CGSize(width: 364, height: 160), fit: true, inset: 0) { WatchLockScreenView(state: s) } }
        }
    }

    func testDynamicIslandRegions() throws {
        let states: [(String, WatchState)] = [
            ("waiting · 5", WatchState.Samples.waiting), ("waiting · 3", WatchState.Samples.waitingThree),
            ("waiting · 2", WatchState.Samples.waitingTwo), ("waiting · 1", WatchState.Samples.waitingOne),
            ("waiting · task", WatchState.Samples.waitingTask),
            ("working · 3", WatchState.Samples.working), ("working · 7", WatchState.Samples.workingMany),
            ("working · task", WatchState.Samples.workingTask),
            ("offline", WatchState.Samples.offline), ("done", WatchState.Samples.done),
        ]
        try sheet("dynamic-island", columns: 2, dark: true) {
            for (label, s) in states {
                cell(label, size: CGSize(width: 364, height: 170), fit: true) { IslandMock(state: s) }
            }
        }
    }

    func testWatchSmartStackFamilies() throws {
        let states: [(String, WatchState)] = [
            ("needs you", WatchState.Samples.waiting), ("one waiting", WatchState.Samples.waitingOne),
            ("resume task", WatchState.Samples.waitingTask), ("working", WatchState.Samples.working),
            ("long session", LongContent.waitingOne), ("offline", WatchState.Samples.offline),
            ("complete", WatchState.Samples.done), ("quiet", .quiet),
        ]
        for (label, size) in [("40mm", CGSize(width: 160, height: 100)), ("large", CGSize(width: 184, height: 122))] {
            try sheet("watch-smart-stack-\(label)", columns: 4, dark: true) {
                for (name, state) in states {
                    cell(name, size: size, inset: 0) { WatchSmartStackView(state: state) }
                }
                cell("stale", size: size, inset: 0) { WatchSmartStackView(state: LongContent.waitingOne, isStale: true) }
            }
            for (name, state) in states {
                for (_, textSize) in Self.textSizes {
                    let view = WatchSmartStackView(state: state).environment(\.dynamicTypeSize, textSize)
                    let measured = UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: size.width, height: .greatestFiniteMagnitude))
                    XCTAssertLessThanOrEqual(measured.height, size.height, "\(name) · \(label) · \(textSize): \(measured)")
                }
            }
        }
    }

    func testAccentedWidgetsAndLiveActivityStaleness() throws {
        try sheet("accented-and-stale", columns: 2, dark: true) {
            cell("medium · accented", size: CGSize(width: 364, height: 170)) {
                WorkBoard(entry: GlanceFixtures.waiting, budget: 2).environment(\.widgetRenderingMode, .accented)
            }
            cell("small · accented", size: CGSize(width: 170, height: 170)) {
                SessionsSmall(entry: GlanceFixtures.waiting).environment(\.widgetRenderingMode, .accented)
            }
            cell("Live Activity · stale", size: CGSize(width: 364, height: 160), fit: true, inset: 0) {
                WatchLockScreenView(state: WatchState.Samples.waitingOne, isStale: true)
            }
        }
    }

    // MARK: - Phone widths × text sizes
    //
    // Standard values (status word, timer, counts, chip values) must render whole at
    // every width and text size; only free text (title, reason, preview, a long path)
    // may truncate. These sheets put realistic, long content through the Live Activity,
    // the island and the Sessions widget at a small and a large phone's sizes, at the
    // default text size and at xxLarge.

    private static let textSizes: [(String, DynamicTypeSize)] = [("default", .large), ("xxLarge", .xxLarge)]
    /// Lock-screen banner widths: 4.7"/5.4" phones, 6.1"–6.3", Pro Max.
    private static let bannerWidths: [(String, CGFloat)] = [("343", 343), ("361", 361), ("398", 398)]

    func testLiveActivityAtPhoneWidths() throws {
        let states: [(String, WatchState)] = [
            ("waiting · 12", LongContent.waiting), ("waiting · 3", LongContent.waitingThree),
            ("waiting · 2", LongContent.waitingTwo), ("waiting · 1", LongContent.waitingOne),
            ("waiting · task", LongContent.waitingTask), ("working · 11", LongContent.working), ("working · 3", LongContent.workingThree),
            ("working · 1", LongContent.workingOne), ("after Later", LongContent.afterLater),
        ]
        for (textLabel, dts) in Self.textSizes {
            try sheet("la-widths-\(textLabel)", columns: 3) {
                for (label, s) in states {
                    for (w, width) in Self.bannerWidths {
                        cell("\(label) · \(w)pt", size: CGSize(width: width, height: 150), fit: true, inset: 0) {
                            WatchLockScreenView(state: s).environment(\.dynamicTypeSize, dts)
                        }
                    }
                }
            }
        }
    }

    func testWatchCopy() {
        XCTAssertEqual(WatchCopy.summaryLine(WatchState(phase: .done, summary: "Sessions ended. 3 answered, 1 PR merged.")), "3 answered, 1 PR merged.",
                       "the headline already says Sessions ended")
        XCTAssertEqual(WatchCopy.summaryLine(WatchState(phase: .done, summary: "Quiet.")), "Quiet.", "the server's summary stands")
        XCTAssertNil(WatchCopy.summaryLine(WatchState(phase: .done, summary: "Sessions ended.")))
        XCTAssertNil(WatchCopy.summaryLine(WatchState(phase: .done)))
        XCTAssertEqual(WatchCopy.moreLine(LongContent.waiting), "+10 more")
        XCTAssertNil(WatchCopy.moreLine(LongContent.waitingThree))
        XCTAssertEqual(WatchCopy.tiles(LongContent.waiting).map(\.count), [12, 14, 3, 6, 2])
        XCTAssertEqual(WatchCopy.tiles(LongContent.working).map(\.id), [.needsYou, .running], "no server tiles, two tiles")
        XCTAssertEqual(WatchCopy.moreLine(LongContent.working), "+9 more", "running sessions past the two listed")
        XCTAssertNil(WatchCopy.moreLine(LongContent.workingThree))
    }

    /// The lock screen clips a Live Activity past 160 pt, and the expanded island is held
    /// to about the same: every state fits at every width, at the default text size and
    /// at the largest the Watch allows.
    func testLiveActivityFitsItsHeight() {
        let states: [(String, WatchState)] = [
            ("waiting · 12", LongContent.waiting), ("waiting · 3", LongContent.waitingThree), ("waiting · 2", LongContent.waitingTwo),
            ("waiting · 1", LongContent.waitingOne), ("waiting · task", LongContent.waitingTask), ("working · 11", LongContent.working),
            ("working · 3", LongContent.workingThree), ("working · 1", LongContent.workingOne), ("after Later", LongContent.afterLater),
            ("waiting · 5", WatchState.Samples.waiting), ("waiting · legacy row", WatchState.Samples.waitingLegacy),
            ("offline", WatchState.Samples.offline), ("done", WatchState.Samples.done),
        ]
        func height(_ view: some View, width: CGFloat) -> CGFloat {
            UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
        }
        for (textLabel, dts) in Self.textSizes {
            for (label, s) in states {
                for (w, width) in Self.bannerWidths {
                    let h = height(WatchLockScreenView(state: s).environment(\.dynamicTypeSize, dts), width: width)
                    XCTAssertLessThanOrEqual(h, 160, "lock screen · \(label) · \(w)pt · \(textLabel): \(h) pt")
                }
                let island = VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .top, spacing: 8) {
                        WatchExpandedLeading(state: s)
                        Spacer(minLength: 0)
                        WatchExpandedTrailing(state: s)
                    }
                    WatchExpandedBottom(state: s)
                }
                let h = height(island.environment(\.dynamicTypeSize, dts), width: 350)
                XCTAssertLessThanOrEqual(h, 160, "island · \(label) · \(textLabel): \(h) pt")
            }
        }
    }

    func testDynamicIslandAtPhoneWidths() throws {
        let states: [(String, WatchState)] = [
            ("waiting · 12", LongContent.waiting), ("waiting · 3", LongContent.waitingThree),
            ("waiting · 2", LongContent.waitingTwo), ("waiting · 1", LongContent.waitingOne),
            ("waiting · task", LongContent.waitingTask), ("working · 11", LongContent.working), ("working · 3", LongContent.workingThree),
            ("working · 1", LongContent.workingOne), ("after Later", LongContent.afterLater),
        ]
        for (textLabel, dts) in Self.textSizes {
            try sheet("island-widths-\(textLabel)", columns: 2, dark: true) {
                for (label, s) in states {
                    for (w, width) in [("small", CGFloat(350)), ("large", CGFloat(404))] {
                        cell("\(label) · \(w)", size: CGSize(width: width, height: 170), fit: true, inset: 0) {
                            IslandMock(state: s).environment(\.dynamicTypeSize, dts)
                        }
                    }
                }
            }
        }
    }

    func testSessionsWidgetAtPhoneSizes() throws {
        // (small, medium, large) family sizes: iPhone SE and Pro Max.
        let phones: [(String, CGSize, CGSize, CGSize)] = [
            ("SE", CGSize(width: 148, height: 148), CGSize(width: 321, height: 148), CGSize(width: 321, height: 324)),
            ("Pro Max", CGSize(width: 170, height: 170), CGSize(width: 364, height: 170), CGSize(width: 364, height: 382)),
        ]
        let entries: [(String, GlanceEntry)] = [("waiting · long", LongContent.entry), ("waiting · 2 servers", GlanceFixtures.waiting)]
        for (textLabel, dts) in Self.textSizes {
            try sheet("widget-sizes-\(textLabel)", columns: 4) {
                for (label, e) in entries {
                    for (phone, small, medium, large) in phones {
                        cell("small · \(label) · \(phone)", size: small) { SessionsSmall(entry: e).environment(\.dynamicTypeSize, dts) }
                        cell("medium · \(label) · \(phone)", size: medium) { WorkBoard(entry: e, budget: 2, expandedRows: false).environment(\.dynamicTypeSize, dts) }
                        cell("large · \(label) · \(phone)", size: large) { WorkBoard(entry: e, budget: 6, expandedRows: true).environment(\.dynamicTypeSize, dts) }
                    }
                }
            }
            try sheet("widget-accessories-\(textLabel)", columns: 3, accessory: true) {
                for (label, e) in entries {
                    cell(label, size: CGSize(width: 76, height: 76), accessory: true) { SessionsCircular(entry: e).environment(\.dynamicTypeSize, dts) }
                    cell(label, size: CGSize(width: 160, height: 72), accessory: true) { SessionsRectangular(entry: e).padding(6).environment(\.dynamicTypeSize, dts) }
                    cell(label, size: CGSize(width: 234, height: 26), accessory: true) { SessionsInline(entry: e).font(.caption).environment(\.dynamicTypeSize, dts) }
                }
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
    private func cell<V: View>(_ label: String, size: CGSize, accessory: Bool = false, fit: Bool = false, inset: CGFloat? = nil, @ViewBuilder _ content: () -> V) -> Cell {
        let body = content()
            .padding(inset ?? (accessory ? 0 : 16))
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
                    WatchExpandedLeading(state: state)
                    Spacer(minLength: 0)
                    WatchExpandedTrailing(state: state)
                }
                WatchExpandedBottom(state: state)
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

/// Content at the lengths people actually see: a user-titled session, a machine with a
/// long name, a deep directory, a long reason.
private enum LongContent {
    static let now = Date()
    static let host = "Jon’s MacBook Pro"
    static let head = WatchItem(
        kind: .local, id: "l1", title: "Refactor the session sizing so the laptop keeps its grid", mono: "optio",
        reason: "Claude stopped — reply to continue", preview: "Should I also update the Android port? (y/n)",
        since: now.addingTimeInterval(-14 * 60 - 32), state: "needs_you", link: "optio://local/l1?compose=1",
        source: .localTerminal, when: "github", where: WatchWhere(target: .machine, detail: "\(host) · ~/repos/optio/apps/web"),
        who: "claude-code", then: .waitsForMe, statusLabel: "needs you")
    static let second = WatchItem(
        kind: .local, id: "l2", title: "claude-code · optio", mono: "optio", reason: "Waiting on a permission",
        since: now.addingTimeInterval(-3 * 60), state: "needs_you", link: "optio://local/l2?compose=1",
        source: .localTerminal, when: "now", where: WatchWhere(target: .machine, detail: "\(host) · ~/repos/optio"),
        who: "claude-code", then: .waitsForMe, statusLabel: "needs you")
    static let task = WatchItem(
        kind: .task, id: "k1", title: "Migrate workspace settings to Drizzle", mono: "feat/settings-drizzle-migration",
        reason: "Merge conflict — resume?", since: now.addingTimeInterval(-47 * 60), state: "needs_attention",
        link: "optio://tasks/k1", prUrl: "https://github.com/jonwiggins/optio/pull/612",
        source: .repoTask, when: "on a trigger", where: WatchWhere(target: .pod, detail: "jonwiggins/optio"),
        who: "codex", then: .exits, statusLabel: "needs attention")
    static let pr = WatchItem(
        kind: .task, id: "k2", title: "fix: login redirect loops on expired PAT", mono: "fix/login-redirect-expired-pat",
        reason: "PR #581 open · CI running", since: now.addingTimeInterval(-2 * 3600 - 5 * 60), state: "pr_opened",
        link: "optio://tasks/k2", prUrl: "https://github.com/jonwiggins/optio/pull/581",
        source: .repoTask, when: "now", where: WatchWhere(target: .pod, detail: "jonwiggins/optio"),
        who: "claude-code", then: .exits, statusLabel: "PR open")

    static let busy = WatchItem(
        kind: .local, id: "l3", title: "Port the terminal sizing arbiter to the Android client", mono: "optio",
        since: now.addingTimeInterval(-6 * 60 - 12), state: "working", link: "optio://local/l3?compose=1",
        source: .localTerminal, when: "now", where: WatchWhere(target: .machine, detail: "\(host) · ~/repos/optio"),
        who: "claude-code", then: .waitsForMe, statusLabel: "working")
    static let agentRow = WatchItem(
        kind: .agent, id: "a1", title: "Vesper", mono: "@vesper", since: now.addingTimeInterval(-41 * 60), state: "running",
        link: "optio://agents/a1?compose=1", source: .persistentAgent, when: "messages", where: WatchWhere(target: .pod, detail: "@vesper"),
        who: "claude-code", then: .waitsForMessages, statusLabel: "thinking")

    static let waiting = WatchState(phase: .waiting, head: task, others: [head, second], needsYouCount: 12, runningCount: 14,
                                    waitingCount: 3, recurringCount: 6, agentCount: 2, asOf: now)
    static let waitingThree = WatchState(phase: .waiting, head: task, others: [head, second], needsYouCount: 3, runningCount: 14,
                                         waitingCount: 3, recurringCount: 6, agentCount: 2, asOf: now)
    static let waitingTwo = WatchState(phase: .waiting, head: head, others: [second], needsYouCount: 2, runningCount: 14,
                                       waitingCount: 3, recurringCount: 6, agentCount: 2, asOf: now)
    static let waitingOne = WatchState(phase: .waiting, head: head, needsYouCount: 1, runningCount: 14,
                                       waitingCount: 3, recurringCount: 6, agentCount: 2, asOf: now)
    static let waitingTask = WatchState(phase: .waiting, head: task, needsYouCount: 1, runningCount: 2, asOf: now)
    static let working = WatchState(phase: .working, head: busy, others: [agentRow, pr], needsYouCount: 0, runningCount: 11, asOf: now)
    static let workingThree = WatchState(phase: .working, head: busy, others: [agentRow, pr], needsYouCount: 0, runningCount: 3,
                                         waitingCount: 3, recurringCount: 6, agentCount: 2, asOf: now)
    static let workingOne = WatchState(phase: .working, head: pr, needsYouCount: 0, runningCount: 1, asOf: now)
    static let afterLater = WatchState(phase: .waiting, head: head, needsYouCount: 1, runningCount: 3, asOf: now)
        .handling("l1", at: now) { $0.snoozedUntil = now.addingTimeInterval(15 * 60) }!

    static let server = ServerProfile(id: "srv-long", name: host, url: URL(string: "http://jons-macbook-pro.tailnet.ts.net:30400")!, color: .slate)
    static let entry: GlanceEntry = {
        func tag(_ i: WatchItem) -> WatchItem { var i = i; i.serverId = server.id; i.serverName = server.shortName; return i }
        let snap = NeedsYouSnapshot(needsYou: [tag(head), tag(second), tag(task)], running: [tag(pr)], hostsOnline: 1, hostsTotal: 1,
                                    counts: SessionTileCounts(waiting: 3, recurring: 6, agents: 2), asOf: now)
        return GlanceEntry(date: now, slices: [GlanceSlice(server: server, reachability: .live, snapshot: snap, tasks: [], unreachableSince: nil)])
    }()
}
