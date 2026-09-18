import SwiftUI

/// Transient confirmation capsule (sonner-style), floating on Liquid Glass.
/// Action failures use this too — never `.alert` for something that already happened.
struct ToastModifier: ViewModifier {
    let message: String?
    var tone: Tone = .working
    let dismiss: () -> Void

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let message {
                    HStack(spacing: Spacing.s) {
                        if tone == .danger {
                            Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                        } else if tone == .success {
                            Image(systemName: "checkmark.circle").foregroundStyle(.green)
                        }
                        Text(message).font(.footnote.weight(.medium)).lineLimit(2)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .floatingGlass()
                    .padding(.bottom, Spacing.m)
                    .padding(.horizontal, Spacing.l)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task {
                        try? await Task.sleep(for: .seconds(tone == .danger ? 4 : 2.5))
                        dismiss()
                    }
                    .onTapGesture(perform: dismiss)
                }
            }
            .animation(.snappy, value: message)
            .sensoryFeedback(tone == .danger ? .error : .success, trigger: message) { _, new in new != nil }
    }
}

extension View {
    func toast(_ message: String?, tone: Tone = .working, dismiss: @escaping () -> Void) -> some View {
        modifier(ToastModifier(message: message, tone: tone, dismiss: dismiss))
    }

    /// Back-compat name used by the Jobs / Reviews models.
    func transientMessage(_ message: String?, dismiss: @escaping () -> Void) -> some View {
        toast(message, dismiss: dismiss)
    }

    /// Shows an action error as a danger toast instead of an alert.
    func errorToast(_ error: Binding<Error?>) -> some View {
        toast(error.wrappedValue.map { ErrorText.humanize($0) }, tone: .danger) { error.wrappedValue = nil }
    }

    func errorToast(_ message: Binding<String?>) -> some View {
        toast(message.wrappedValue, tone: .danger) { message.wrappedValue = nil }
    }
}
