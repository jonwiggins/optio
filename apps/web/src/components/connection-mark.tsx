import type { ComponentType } from "react";
import { Database, FolderOpen, Globe, KeyRound, Plug, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { brandFor, brandIconComponent } from "@/components/brand-icon";

/**
 * The mark for a catalog row — a connection, a secret, an MCP server: the
 * provider's brand logo when it has one (`brand-icon.tsx`), its generic icon
 * key otherwise (database, folder, terminal, globe), else the kind's icon.
 * Always drawn inside a logo tile so every row keeps the same silhouette.
 */

export type ConnectionMarkKind = "connection" | "secret" | "mcpServer";

type Glyph = ComponentType<{ className?: string }>;

/** Generic provider icon keys (the catalog's `icon`) → lucide. */
const ICON_KEY_GLYPHS: Record<string, Glyph> = {
  database: Database,
  postgres: Database,
  folder: FolderOpen,
  terminal: Terminal,
  globe: Globe,
};

const KIND_GLYPHS: Record<ConnectionMarkKind, Glyph> = {
  connection: Plug,
  secret: KeyRound,
  mcpServer: Plug,
};

/** How the glyph was picked, for tests and debugging (`data-mark` on the tile). */
function resolveMark(
  icon: string | null | undefined,
  kind: ConnectionMarkKind | undefined,
): { Glyph: Glyph; mark: string } {
  const brand = brandFor(icon);
  if (brand) return { Glyph: brandIconComponent(brand), mark: `brand:${brand}` };
  const key = (icon ?? "").toLowerCase();
  if (Object.hasOwn(ICON_KEY_GLYPHS, key))
    return { Glyph: ICON_KEY_GLYPHS[key], mark: `icon:${key}` };
  if (kind && Object.hasOwn(KIND_GLYPHS, kind))
    return { Glyph: KIND_GLYPHS[kind], mark: `kind:${kind}` };
  return { Glyph: Plug, mark: "kind:connection" };
}

/** The lucide-compatible component for an icon key / kind (no tile), for places that need just the glyph. */
export function connectionIconComponent(
  icon?: string | null,
  kind?: ConnectionMarkKind,
): ComponentType<{ className?: string }> {
  return resolveMark(icon, kind).Glyph;
}

const TILE_SIZE = {
  sm: { tile: "w-5 h-5 rounded", glyph: "w-3 h-3" },
  md: { tile: "w-7 h-7 rounded-md", glyph: "w-4 h-4" },
  lg: { tile: "w-8 h-8 rounded-md", glyph: "w-[18px] h-[18px]" },
} as const;

/**
 * The mark for a catalog entry: a brand logo, a provider's generic icon, or the
 * kind's icon, always inside a logo tile so every row has the same silhouette.
 * Decorative: callers put the name next to it.
 */
export function ConnectionMark({
  icon,
  kind,
  size = "md",
  className,
}: {
  icon?: string | null;
  kind?: ConnectionMarkKind;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const { Glyph, mark } = resolveMark(icon, kind);
  const s = TILE_SIZE[size];
  return (
    <span
      aria-hidden="true"
      data-mark={mark}
      className={cn(
        "inline-flex items-center justify-center shrink-0 bg-bg-hover border border-border/60 text-text",
        s.tile,
        className,
      )}
    >
      <Glyph className={cn("shrink-0", s.glyph)} />
    </span>
  );
}
