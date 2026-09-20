import SwiftUI

/// The one way in: the five-attribute form (When → Where → Who → What → Then →
/// Name), native. Every entry point — Overview "+", Sessions "+", the empty
/// states, the browse-by-kind lists — presents this. A terminal on a paired
/// machine is one of its answers (Where: my machine · Who: Terminal), so the
/// old shortcut folded into the form.
struct NewSessionSheet: View {
    var body: some View {
        SessionFormView()
    }
}

/// Toolbar "+" that opens the sheet; one component so every screen offers the same entry.
struct NewSessionButton: View {
    @State private var show = false

    var body: some View {
        Button { show = true } label: { Image(systemName: "plus") }
            .accessibilityLabel("New session")
            .sheet(isPresented: $show) { NewSessionSheet() }
    }
}
