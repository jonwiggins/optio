import AppIntents
import Foundation
import SwiftUI

/// A paired server, for the widget "Server" option. Read from the registry only:
/// the picker must work offline and never hit the network.
struct ServerEntity: AppEntity, Identifiable, Hashable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Optio Server")
    static let defaultQuery = ServerEntityQuery()

    var id: String
    var name: String
    var host: String
    var color: ServerColor

    init(_ p: ServerProfile) {
        id = p.id
        name = p.name
        host = p.host
        color = p.color
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(host)")
    }

    var profile: ServerProfile? { ServerRegistry.profile(id) }
}

struct ServerEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [ServerEntity] {
        ServerRegistry.all.filter { identifiers.contains($0.id) }.map(ServerEntity.init)
    }

    func suggestedEntities() async throws -> [ServerEntity] {
        ServerRegistry.configured.map(ServerEntity.init)
    }

    func defaultResult() async -> ServerEntity? { nil }
}

/// Configuration shared by Needs You and In Flight: which server to show. Nil means
/// every paired server, sectioned by name.
struct GlanceConfigurationIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Server"
    static let description = IntentDescription("Show one paired server, or all of them.")

    @Parameter(title: "Server", description: "Leave empty to show every paired server.")
    var server: ServerEntity?

    init() {}
    init(server: ServerEntity?) { self.server = server }
}
