import SwiftTerm
import SwiftUI
import UIKit

/// Terminal colors that follow the app's light/dark appearance. Both SwiftTerm
/// wrappers (Sessions and Optio Local) call `apply` from make/update so switching
/// appearance re-themes a live terminal without reconnecting.
enum TerminalTheme {
    static func apply(to view: TerminalView, scheme: ColorScheme) {
        let dark = scheme == .dark
        view.nativeBackgroundColor = dark ? UIColor(red: 9 / 255, green: 9 / 255, blue: 11 / 255, alpha: 1)
                                          : UIColor(red: 250 / 255, green: 250 / 255, blue: 250 / 255, alpha: 1)
        view.nativeForegroundColor = dark ? UIColor(red: 244 / 255, green: 244 / 255, blue: 245 / 255, alpha: 1)
                                          : UIColor(red: 24 / 255, green: 24 / 255, blue: 27 / 255, alpha: 1)
        view.backgroundColor = view.nativeBackgroundColor
        view.caretColor = UIColor(red: 0x6D / 255, green: 0x28 / 255, blue: 0xD9 / 255, alpha: 1)
        view.keyboardAppearance = dark ? .dark : .light
        view.installColors(dark ? darkAnsi : lightAnsi)
    }

    /// 16 ANSI colors. Dark: a soft "zinc" palette; light: the same hues darkened
    /// so they stay legible on a near-white background.
    private static let darkAnsi: [SwiftTerm.Color] = [
        c(0x27272a), c(0xf87171), c(0x4ade80), c(0xfacc15), c(0x60a5fa), c(0xc084fc), c(0x22d3ee), c(0xd4d4d8),
        c(0x52525b), c(0xfca5a5), c(0x86efac), c(0xfde047), c(0x93c5fd), c(0xd8b4fe), c(0x67e8f9), c(0xfafafa),
    ]
    private static let lightAnsi: [SwiftTerm.Color] = [
        c(0x18181b), c(0xb91c1c), c(0x15803d), c(0xa16207), c(0x1d4ed8), c(0x6d28d9), c(0x0e7490), c(0x71717a),
        c(0x3f3f46), c(0xdc2626), c(0x16a34a), c(0xca8a04), c(0x2563eb), c(0x7c3aed), c(0x0891b2), c(0x09090b),
    ]

    private static func c(_ hex: UInt32) -> SwiftTerm.Color {
        SwiftTerm.Color(red: UInt16((hex >> 16) & 0xff) * 257, green: UInt16((hex >> 8) & 0xff) * 257, blue: UInt16(hex & 0xff) * 257)
    }
}
