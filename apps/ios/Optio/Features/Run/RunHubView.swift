import SwiftUI

/// The "Run" tab: Tasks · Jobs · Reviews · Issues · Scheduled, matching the web
/// sidebar group. Each section owns its own list → detail flow inside this stack.
struct RunHubView: View {
    enum Section: String, CaseIterable { case tasks, jobs, reviews, issues, scheduled }
    @State private var section: Section = .tasks
    @Environment(AppRouter.self) private var router

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ChipPicker(options: [(.tasks, "Tasks"), (.jobs, "Jobs"), (.reviews, "Reviews"), (.issues, "Issues"), (.scheduled, "Scheduled")], selection: $section)
                Divider()
                switch section {
                case .tasks: TasksListView()
                case .jobs: JobsListView()
                case .reviews: ReviewsListView()
                case .issues: IssuesListView()
                case .scheduled: ScheduledListView()
                }
            }
            .onAppear(perform: consumeRoute)
            .onChange(of: router.pendingSection) { _, _ in consumeRoute() }
        }
    }

    /// Cross-tab deep link from `AppRouter.open(_:)`.
    private func consumeRoute() {
        guard let pending = router.pendingSection else { return }
        let mapped: Section? = switch pending {
        case .tasks: .tasks
        case .jobs: .jobs
        case .reviews: .reviews
        case .issues: .issues
        case .scheduled: .scheduled
        default: nil
        }
        guard let mapped else { return }
        section = mapped
        router.pendingSection = nil
    }
}
