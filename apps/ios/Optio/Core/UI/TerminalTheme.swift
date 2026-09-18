import SwiftTerm
import SwiftUI
import UIKit

/// SwiftTerm view whose finger scrolling follows what the program wants.
///
/// With mouse reporting off (`allowMouseReporting = false`, our setting, so taps
/// focus the keyboard instead of clicking), stock `TerminalView` still attaches
/// its own pan recognizer when the program turns mouse mode on. That recognizer
/// never does anything, but it starves `UIScrollView`'s pan, so dragging went dead.
///
/// Claude Code (2.1.x) runs in the alternate screen with mouse tracking on and
/// scrolls its transcript itself in response to wheel events — there is no
/// terminal scrollback to drag through at all. So while the program tracks the
/// mouse, a vertical drag is translated into wheel reports (SGR buttons 64/65,
/// one per cell row of travel, with a short fling), exactly what a desktop
/// terminal does with the wheel. When mouse mode goes off again the native
/// scroll view takes back over and history scrolls as before.
final class ScrollableTerminalView: TerminalView {
    private var wheelPan: UIPanGestureRecognizer?
    private var wheelRemainder: CGFloat = 0
    private var flingTimer: Timer?
    private var flingVelocity: CGFloat = 0
    private var flingLocation: CGPoint = .zero

    override func mouseModeChanged(source: Terminal) {
        if allowMouseReporting {
            super.mouseModeChanged(source: source)
            return
        }
        if source.mouseMode != .off { enableWheelPan() } else { disableWheelPan() }
    }

    private func enableWheelPan() {
        guard wheelPan == nil else { return }
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleWheelPan(_:)))
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)
        wheelPan = pan
        wheelRemainder = 0
        // The program owns scrolling now; the scroll view's own pan would only fight it.
        isScrollEnabled = false
    }

    private func disableWheelPan() {
        stopFling()
        if let pan = wheelPan { removeGestureRecognizer(pan) }
        wheelPan = nil
        isScrollEnabled = true
    }

    @objc private func handleWheelPan(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            stopFling()
            wheelRemainder = 0
        case .changed:
            let dy = gesture.translation(in: self).y
            gesture.setTranslation(.zero, in: self)
            emitWheel(travel: dy, at: gesture.location(in: self))
        case .ended:
            startFling(velocity: gesture.velocity(in: self).y, at: gesture.location(in: self))
        case .cancelled, .failed:
            wheelRemainder = 0
        default:
            break
        }
    }

    /// Finger travel in points → wheel notches. Dragging down (positive) pulls
    /// older content into view, i.e. a wheel-up (button 4) report, matching the
    /// direction of a native scroll.
    private func emitWheel(travel: CGFloat, at location: CGPoint) {
        guard let cell = cellSize(), cell.height > 0 else { return }
        wheelRemainder += travel
        let notches = Int(wheelRemainder / cell.height)
        guard notches != 0 else { return }
        wheelRemainder -= CGFloat(notches) * cell.height
        let terminal = getTerminal()
        let button = notches > 0 ? 4 : 5
        let flags = terminal.encodeButton(button: button, release: false, shift: false, meta: false, control: false)
        let col = max(0, min(terminal.cols - 1, Int(location.x / cell.width)))
        let row = max(0, min(terminal.rows - 1, Int((location.y - contentOffset.y) / cell.height)))
        for _ in 0..<abs(notches) {
            terminal.sendEvent(buttonFlags: flags, x: col, y: row)
        }
    }

    private func cellSize() -> CGSize? {
        guard let px = cellSizeInPixels(source: getTerminal()) else { return nil }
        let scale = max(traitCollection.displayScale, 1)
        return CGSize(width: CGFloat(px.width) / scale, height: CGFloat(px.height) / scale)
    }

    // A short deceleration so a flick keeps scrolling a little, like the native view.
    private func startFling(velocity: CGFloat, at location: CGPoint) {
        stopFling()
        guard abs(velocity) > 300 else { return }
        flingVelocity = velocity
        flingLocation = location
        flingTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.emitWheel(travel: self.flingVelocity / 60, at: self.flingLocation)
            self.flingVelocity *= 0.93
            if abs(self.flingVelocity) < 120 { self.stopFling() }
        }
    }

    private func stopFling() {
        flingTimer?.invalidate()
        flingTimer = nil
        flingVelocity = 0
    }
}

/// Terminal colors that follow the app's light/dark appearance. Both SwiftTerm
/// wrappers (Sessions and Optio Local) call `apply` from make/update so switching
/// appearance re-themes a live terminal without reconnecting.
enum TerminalTheme {
    /// SwiftUI color matching the terminal canvas, for chrome around it (status strip, key bar).
    static func background(_ scheme: ColorScheme) -> SwiftUI.Color {
        scheme == .dark ? SwiftUI.Color(red: 9 / 255, green: 9 / 255, blue: 11 / 255)
                        : SwiftUI.Color(red: 250 / 255, green: 250 / 255, blue: 250 / 255)
    }

    static func apply(to view: TerminalView, scheme: ColorScheme) {
        let dark = scheme == .dark
        view.nativeBackgroundColor = dark ? UIColor(red: 9 / 255, green: 9 / 255, blue: 11 / 255, alpha: 1)
                                          : UIColor(red: 250 / 255, green: 250 / 255, blue: 250 / 255, alpha: 1)
        view.nativeForegroundColor = dark ? UIColor(red: 244 / 255, green: 244 / 255, blue: 245 / 255, alpha: 1)
                                          : UIColor(red: 24 / 255, green: 24 / 255, blue: 27 / 255, alpha: 1)
        view.backgroundColor = view.nativeBackgroundColor
        // Cursor matches the text (no accent): the terminal is a tool, not a brand surface.
        view.caretColor = view.nativeForegroundColor
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
