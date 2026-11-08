import SwiftUI

/// Keeps prose in the existing inline renderer, but gives pipe tables their own
/// layout. A table scrolls sideways without widening the conversation itself.
struct ChatMarkdown: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(ChatMarkdownBlocks.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let source):
                    Text(LocalizedStringKey(source))
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .table(let table):
                    ChatMarkdownTable(table: table)
                }
            }
        }
        .font(.body)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ChatMarkdownTable: View {
    let table: ChatMarkdownBlocks.Table
    @ScaledMetric(relativeTo: .body) private var cellWidth = 160

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                row(table.headers, header: true)
                ForEach(table.rows.indices, id: \.self) { index in
                    row(table.rows[index], header: false)
                        .background(index.isMultiple(of: 2) ? Color(.secondarySystemBackground) : Color(.systemBackground))
                }
            }
            // A horizontal scroller must take the grid's full wrapped height.
            .fixedSize(horizontal: false, vertical: true)
            .overlay(Rectangle().stroke(Color(.separator), lineWidth: 0.5))
            .padding(.bottom, 6)
        }
        .accessibilityIdentifier("markdown-table")
        .accessibilityHint("Scroll horizontally to read more columns")
    }

    private func row(_ cells: [String], header: Bool) -> some View {
        GridRow(alignment: .top) {
            ForEach(table.headers.indices, id: \.self) { column in
                let alignment = table.alignments[column]
                Text((try? AttributedString(markdown: cells[column], options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(cells[column]))
                    .fontWeight(header ? .semibold : .regular)
                    .multilineTextAlignment(alignment == .center ? .center : alignment == .right ? .trailing : .leading)
                    .frame(width: cellWidth, alignment: alignment == .center ? .center : alignment == .right ? .trailing : .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .background(header ? Color(.tertiarySystemFill) : Color.clear)
                    .overlay(Rectangle().stroke(Color(.separator), lineWidth: 0.5))
                    .accessibilityAddTraits(header ? .isHeader : [])
            }
        }
    }
}

/// Table recognition is deliberately block-level: require a matching delimiter
/// row, and leave fenced code and incomplete streaming headers as prose.
enum ChatMarkdownBlocks {
    enum Alignment: Equatable { case left, center, right }
    struct Table: Equatable {
        let headers: [String]
        let alignments: [Alignment]
        let rows: [[String]]
    }
    enum Block: Equatable {
        case prose(String)
        case table(Table)
    }

    static func parse(_ source: String) -> [Block] {
        let lines = source.components(separatedBy: "\n")
        var blocks: [Block] = []
        var prose: [String] = []
        var fence: (Character, Int)?
        var index = 0
        func flush() {
            if !prose.isEmpty {
                blocks.append(.prose(prose.joined(separator: "\n")))
                prose.removeAll()
            }
        }
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let first = trimmed.first, first == "`" || first == "~" {
                let count = trimmed.prefix(while: { $0 == first }).count
                if count >= 3 {
                    if let active = fence {
                        if first == active.0, count >= active.1,
                           trimmed.dropFirst(count).trimmingCharacters(in: .whitespaces).isEmpty { fence = nil }
                    } else { fence = (first, count) }
                    prose.append(line)
                    index += 1
                    continue
                }
            }
            if fence == nil, index + 1 < lines.count,
               let headers = cells(line), let separators = cells(lines[index + 1]),
               headers.count == separators.count,
               separators.allSatisfy({ $0.range(of: "^:?-+:?$", options: .regularExpression) != nil }) {
                flush()
                let alignments: [Alignment] = separators.map {
                    $0.hasSuffix(":") ? ($0.hasPrefix(":") ? .center : .right) : .left
                }
                index += 2
                var rows: [[String]] = []
                while index < lines.count, let values = cells(lines[index]),
                      !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```"),
                      !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("~~~") {
                    // GFM pads missing cells and ignores excess cells.
                    rows.append(Array((values + Array(repeating: "", count: headers.count)).prefix(headers.count)))
                    index += 1
                }
                blocks.append(.table(Table(headers: headers, alignments: alignments, rows: rows)))
            } else {
                prose.append(line)
                index += 1
            }
        }
        flush()
        return blocks
    }

    private static func cells(_ line: String) -> [String]? {
        // Four-space indentation belongs to code, not a top-level table.
        guard !line.hasPrefix("    "), !line.hasPrefix("\t") else { return nil }
        let source = line.trimmingCharacters(in: .whitespaces)
        guard !source.isEmpty else { return nil }
        var values: [String] = []
        var value = ""
        var escaped = false
        var hasPipe = false
        for character in source {
            if escaped {
                // Escaped pipes are content, including inside inline code.
                if character == "|" { value.removeLast() }
                value.append(character)
                escaped = false
            } else if character == "\\" {
                value.append(character)
                escaped = true
            } else if character == "|" {
                values.append(value)
                value = ""
                hasPipe = true
            } else { value.append(character) }
        }
        guard hasPipe else { return nil }
        values.append(value)
        if values.first == "" { values.removeFirst() }
        if values.last == "" { values.removeLast() }
        guard !values.isEmpty else { return nil }
        return values.map { $0.trimmingCharacters(in: .whitespaces) }
    }
}
