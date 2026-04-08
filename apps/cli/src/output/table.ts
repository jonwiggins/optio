import { bold, dim } from "./colors.js";

interface Column {
  header: string;
  key: string;
  width?: number;
}

export function printTable(columns: Column[], rows: Record<string, string>[]): void {
  // Compute column widths
  const widths = columns.map((col) => {
    const headerLen = col.header.length;
    const maxDataLen = rows.reduce((max, row) => Math.max(max, (row[col.key] ?? "").length), 0);
    return col.width ?? Math.max(headerLen, maxDataLen);
  });

  // Print header
  const header = columns.map((col, i) => bold(col.header.padEnd(widths[i]))).join("  ");
  process.stdout.write(header + "\n");
  process.stdout.write(dim(widths.map((w) => "─".repeat(w)).join("──")) + "\n");

  // Print rows
  for (const row of rows) {
    const line = columns.map((col, i) => (row[col.key] ?? "").padEnd(widths[i])).join("  ");
    process.stdout.write(line + "\n");
  }
}
