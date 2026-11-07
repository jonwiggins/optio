import SwiftUI

/// A persistent, readable turn state beside the composer, even during silent work.
struct ChatActivityView: View {
    let title: String
    var active = false
    var symbol = "checkmark.circle"

    var body: some View {
        HStack(spacing: 8) {
            if active {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: symbol)
            }
            Text(title).font(.caption.weight(.medium))
            Spacer(minLength: 0)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, Spacing.l)
        .padding(.vertical, Spacing.s)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat-activity")
    }
}
