import SwiftUI

/// The one way in: the five-attribute form (When → Where → Who → What → Then →
/// Name), native. Every entry point — Overview "+", Work "+", the empty
/// states, the browse-by-kind lists — presents this. A terminal on a paired
/// machine is one of its answers (Where: my machine · Who: Terminal), so the
/// old shortcut folded into the form.
struct NewWorkSheet: View {
    var body: some View {
        WorkFormView()
    }
}

/// Toolbar "+" that opens the sheet; one component so every screen offers the
/// same entry. Nothing for a viewer (`SessionStore.canCreateWork`): the server
/// would reject the form on submit.
struct NewSessionButton: View {
    @Environment(SessionStore.self) private var session
    @State private var show = false

    var body: some View {
        if session.canCreateWork {
            Button { show = true } label: { Image(systemName: "plus") }
                .accessibilityLabel("New work")
                .sheet(isPresented: $show) { NewWorkSheet() }
        }
    }
}
