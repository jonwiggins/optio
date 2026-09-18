import SwiftUI

/// The "Run" tab: Tasks · Jobs · Reviews · Issues · Scheduled, matching the web
/// sidebar group. One large title; the section switcher lives in the toolbar and
/// each section owns its own list → detail flow inside this stack.
struct RunHubView: View {
    enum Section: String, CaseIterable { case tasks, jobs, reviews, issues, scheduled }
    @State private var section: Section = .tasks
    @State private var path = NavigationPath()
    @Environment(AppRouter.self) private var router

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                HubSwitcher(options: [(Section.tasks, "Tasks"), (.jobs, "Jobs"), (.reviews, "Reviews"), (.issues, "Issues"), (.scheduled, "Scheduled")], selection: $section)
                Group {
                    switch section {
                    case .tasks: TasksListView()
                    case .jobs: JobsListView()
                    case .reviews: ReviewsListView()
                    case .issues: IssuesListView()
                    case .scheduled: ScheduledListView()
                    }
                }
                .id(section)
            }
            .navigationTitle("Run")
            .hubChrome()
            .navigationDestination(for: AppRouter.PendingDetail.self) { detail in
                TaskDetailView(taskId: detail.id, focusComposer: detail.compose)
            }
            .onAppear(perform: consumeRoute)
            .onChange(of: router.pendingSection) { _, _ in consumeRoute() }
            .onChange(of: router.pendingDetail) { _, _ in consumeRoute() }
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
        consumeDetail()
    }

    /// `optio://tasks/<id>` (widgets, Live Activity, notifications): replace the stack
    /// with the task detail so the deep link lands in one hop.
    private func consumeDetail() {
        guard let detail = router.pendingDetail, detail.kind == .task else { return }
        router.pendingDetail = nil
        path = NavigationPath([detail])
    }
}
