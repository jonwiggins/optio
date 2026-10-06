import SwiftUI
import UIKit

enum AppTheme {
    /// Semantic colours adapt to the app's appearance, including sheets.
    static let accent = adaptive(light: 0x6D28D9, dark: 0xB49AF7)
    static let secondaryText = adaptive(light: 0x655F6D, dark: 0xC0B9C9)
    static let mutedText = adaptive(light: 0x77717E, dark: 0x96909F)

    static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 255) / 255,
                           green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
}
