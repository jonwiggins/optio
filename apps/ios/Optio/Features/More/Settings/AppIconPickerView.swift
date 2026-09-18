import SwiftUI

/// One selectable home-screen icon. `assetName` is the `AppIcon-*` appiconset
/// (nil = the primary icon); `previewName` is a plain imageset holding the same
/// 1024px PNG, because `UIImage(named:)` cannot load appiconsets.
struct AppIconOption: Identifiable, Hashable {
    let assetName: String?
    let name: String
    let story: String

    var id: String { assetName ?? "default" }
    var previewName: String { "IconPreview-\(assetName.map { String($0.dropFirst("AppIcon-".count)) } ?? "Default")" }

    static let all: [AppIconOption] = [
        .init(assetName: nil, name: "Optio", story: "The original. White bot on Optio purple."),
        .init(assetName: "AppIcon-Midnight", name: "Midnight", story: "Lights off, one eye still on. It's watching your PRs."),
        .init(assetName: "AppIcon-Terminal", name: "Terminal", story: "The shell you left open. The bot is the prompt; the caret is you."),
        .init(assetName: "AppIcon-Blueprint", name: "Blueprint", story: "Every robot starts as a drawing on blue paper."),
        .init(assetName: "AppIcon-Sticker", name: "Sticker", story: "Peeled off a laptop lid and slapped on slightly crooked."),
        .init(assetName: "AppIcon-Retro", name: "Retro", story: "A 1983 monitor in a basement lab. Phosphor green and the hum."),
        .init(assetName: "AppIcon-Sunrise", name: "Sunrise", story: "It worked through the night. Morning, and the PR is up."),
    ]

    /// The option matching what iOS currently shows on the home screen.
    static var current: AppIconOption {
        let active = UIApplication.shared.alternateIconName
        return all.first { $0.assetName == active } ?? all[0]
    }
}

/// Rounded thumbnail of an icon, drawn from its preview imageset.
struct AppIconThumbnail: View {
    let option: AppIconOption
    var size: CGFloat = 60

    var body: some View {
        Image(option.previewName)
            .resizable()
            .interpolation(.high)
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
    }
}

/// Grid of home-screen icons. Selection is handed straight to iOS via
/// `setAlternateIconName`; nothing is persisted here because the system
/// remembers the choice.
struct AppIconPickerView: View {
    @State private var selected: String? = UIApplication.shared.alternateIconName
    @State private var errorMessage: String?
    @State private var feedbackTick = 0

    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 16)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(AppIconOption.all) { option in
                    Button { choose(option) } label: {
                        IconCard(option: option, isSelected: option.assetName == selected)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(option.name)
                    .accessibilityAddTraits(option.assetName == selected ? .isSelected : [])
                }
            }
            .padding()
            Text("The icon on your home screen changes right away.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
                .padding(.bottom, 24)
        }
        .navigationTitle("App icon")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.selection, trigger: feedbackTick)
        .moreErrorAlert($errorMessage)
    }

    private func choose(_ option: AppIconOption) {
        guard option.assetName != selected else { return }
        guard UIApplication.shared.supportsAlternateIcons else {
            errorMessage = "This device doesn't support alternate app icons."
            return
        }
        let previous = selected
        selected = option.assetName
        feedbackTick += 1
        UIApplication.shared.setAlternateIconName(option.assetName) { error in
            if let error {
                selected = previous
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct IconCard: View {
    let option: AppIconOption
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            AppIconThumbnail(option: option, size: 88)
                .overlay {
                    RoundedRectangle(cornerRadius: 88 * 0.22, style: .continuous)
                        .strokeBorder(Color.accentColor, lineWidth: isSelected ? 3 : 0)
                        .padding(-5)
                }
                .padding(5)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(option.name).font(.headline)
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Color.accentColor)
                    }
                }
                Text(option.story)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

#Preview {
    NavigationStack { AppIconPickerView() }
}
