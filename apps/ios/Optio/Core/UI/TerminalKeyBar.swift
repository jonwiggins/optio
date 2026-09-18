import SwiftUI

/// The one extra-keys bar for terminals (Sessions and Optio Local). Keys a phone
/// keyboard lacks, a Ctrl menu, and an optional keyboard toggle. Floats over
/// the terminal on Liquid Glass; falls back to a material bar below iOS 26.
struct TerminalKeyBar: View {
    struct Key: Identifiable, Hashable {
        let id: String
        let label: String
        var systemImage: String? = nil
        let bytes: [UInt8]

        static let esc = Key(id: "esc", label: "esc", bytes: [0x1b])
        static let tab = Key(id: "tab", label: "tab", systemImage: "arrow.right.to.line", bytes: [0x09])
        static let ctrlC = Key(id: "ctrl-c", label: "^C", bytes: [0x03])
        static let ctrlD = Key(id: "ctrl-d", label: "^D", bytes: [0x04])
        static let pipe = Key(id: "pipe", label: "|", bytes: Array("|".utf8))
        static let tilde = Key(id: "tilde", label: "~", bytes: Array("~".utf8))
        static let dash = Key(id: "dash", label: "-", bytes: Array("-".utf8))
        static let slash = Key(id: "slash", label: "/", bytes: Array("/".utf8))
    }

    enum Arrow: String, CaseIterable, Identifiable {
        case up = "A", down = "B", right = "C", left = "D"
        var id: String { rawValue }
        var systemImage: String {
            switch self {
            case .up: return "arrow.up"
            case .down: return "arrow.down"
            case .left: return "arrow.left"
            case .right: return "arrow.right"
            }
        }
    }

    static let ctrlKeys: [(String, UInt8)] = [
        ("C", 0x03), ("D", 0x04), ("Z", 0x1a), ("L", 0x0c), ("R", 0x12),
        ("A", 0x01), ("E", 0x05), ("U", 0x15), ("K", 0x0b), ("W", 0x17),
    ]

    var keys: [Key] = [.esc, .tab, .ctrlC, .ctrlD, .pipe, .tilde, .dash, .slash]
    var enabled = true
    /// Whether the terminal is in application-cursor mode (arrows send `ESC O x`).
    var applicationCursor = false
    var send: ([UInt8]) -> Void
    /// nil hides the keyboard toggle.
    var keyboardShown: Bool? = nil
    var toggleKeyboard: (() -> Void)? = nil
    @State private var presses = 0

    var body: some View {
        HStack(spacing: Spacing.s) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Menu {
                        ForEach(Self.ctrlKeys, id: \.0) { label, code in
                            Button("Ctrl+\(label)") { press([code]) }
                        }
                    } label: {
                        keyCap { Text("ctrl") }
                    }
                    ForEach(keys) { key in
                        Button { press(key.bytes) } label: {
                            keyCap {
                                if let img = key.systemImage { Image(systemName: img) } else { Text(key.label) }
                            }
                        }
                    }
                    ForEach(Arrow.allCases) { arrow in
                        Button { press(Array("\u{1b}\(applicationCursor ? "O" : "[")\(arrow.rawValue)".utf8)) } label: {
                            keyCap { Image(systemName: arrow.systemImage) }
                        }
                    }
                }
                .padding(.horizontal, Spacing.s)
            }
            if let keyboardShown, let toggleKeyboard {
                Button(action: toggleKeyboard) {
                    keyCap { Image(systemName: keyboardShown ? "keyboard.chevron.compact.down" : "keyboard") }
                }
                .padding(.trailing, Spacing.s)
                .accessibilityLabel(keyboardShown ? "Hide keyboard" : "Show keyboard")
            }
        }
        .buttonStyle(.plain)
        .padding(.vertical, 6)
        .background(barBackground)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
        .sensoryFeedback(.impact(flexibility: .soft), trigger: presses)
    }

    private func press(_ bytes: [UInt8]) {
        presses += 1
        send(bytes)
    }

    @ViewBuilder
    private var barBackground: some View {
        if #available(iOS 26, *) {
            Rectangle().fill(.clear).glassEffect(.regular, in: Rectangle())
        } else {
            Rectangle().fill(.bar)
        }
    }

    private func keyCap<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .font(.system(.footnote, design: .monospaced).weight(.medium))
            .frame(minWidth: 36, minHeight: 30)
            .padding(.horizontal, 6)
            .background(.fill.tertiary, in: Radius.smallShape)
            .foregroundStyle(.primary)
            .contentShape(Radius.smallShape)
    }
}
