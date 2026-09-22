/**
 * gen-model — the language-neutral front end shared by gen-swift and gen-kotlin.
 *
 * Reads the shared TypeScript protocol types and lowers every exported
 * interface / type alias / enum into a small declaration model — structs,
 * string / int enums, discriminated unions, aliases, each with its nested
 * declarations — that a back end renders in its own language. Every mapping
 * decision lives here (which union becomes an enum, how `extends` and
 * intersections flatten, how nested types are named, what degrades to "any
 * JSON"), so the Swift and Kotlin models cannot drift apart:
 *
 *   interface / object type alias   → struct
 *   string enum / string-literal union → string enum (back ends add an unknown fallback)
 *   numeric enum                    → int enum
 *   discriminated object union      → union with one variant per discriminator value
 *   `X | null`, `x?: X`             → optional
 *   unknown / any / functions / tuples / anything irregular → any (+ warning)
 *
 * Generic types, classes, functions and consts are skipped silently. Interfaces
 * with method members are skipped with a warning (they are not data).
 *
 * The front end is syntactic (AST-driven) so its output is predictable; the
 * type checker is only consulted for `keyof typeof X`-style aliases.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ── Model ───────────────────────────────────────────────────────────────────

/** A type as a back end spells it; nested types are named in their container. */
export type TypeRef =
  | { k: "string" | "number" | "boolean" | "date" | "any" }
  | { k: "array"; element: TypeRef; optional: boolean }
  | { k: "map"; value: TypeRef; optional: boolean }
  | { k: "entry"; entry: Entry }
  | { k: "nested"; name: string };

export interface Prop {
  /** Key on the wire. */
  jsonName: string;
  /** Member name: the wire key when it is a plain identifier, else its camelCase. */
  name: string;
  type: TypeRef;
  optional: boolean;
  docs: string[];
}

export interface EnumCase {
  raw: string;
  /** What the back end derives the case name from (TS member name or the literal). */
  source: string;
  docs: string[];
}

export interface IntEnumCase {
  value: number;
  source: string;
  docs: string[];
}

export type VariantPayload =
  /** No fields besides the discriminator; `name` is set when the back end names bare variants. */
  | { k: "none"; name: string | null }
  /** A reference to a named struct, which carries the discriminator itself. */
  | { k: "entry"; entry: Entry }
  /** Inline fields (minus the discriminator), nested in the union. */
  | { k: "inline"; struct: StructDecl };

export interface Variant {
  /** Discriminator values; the first one is written when encoding. */
  literals: string[];
  payload: VariantPayload;
}

export interface StructDecl {
  kind: "struct";
  name: string;
  docs: string[];
  props: Prop[];
  /** Declarations nested in this struct, in creation order. */
  nested: Decl[];
}

export interface StringEnumDecl {
  kind: "stringEnum";
  name: string;
  docs: string[];
  cases: EnumCase[];
  /** Location for warnings. */
  at: string;
}

export interface IntEnumDecl {
  kind: "intEnum";
  name: string;
  docs: string[];
  cases: IntEnumCase[];
}

export interface UnionDecl {
  kind: "union";
  name: string;
  docs: string[];
  /** Discriminator property. */
  key: string;
  variants: Variant[];
}

export interface AliasDecl {
  kind: "alias";
  name: string;
  docs: string[];
  type: TypeRef;
  optional: boolean;
}

export type Decl = StructDecl | StringEnumDecl | IntEnumDecl | UnionDecl | AliasDecl;

type DeclNode = ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration;

export type EntryKind = "struct" | "dict" | "enum" | "alias" | "skipped";

/** One exported declaration of the input files. */
export interface Entry {
  /** TypeScript name. */
  name: string;
  /** Name in the generated code (reserved names prefixed, collisions resolved). */
  typeName: string;
  file: string;
  sf: ts.SourceFile;
  node: DeclNode;
  kind: EntryKind;
}

export interface EntryModel {
  entry: Entry;
  /** Output declarations, in order: hoisted helpers first, then the entry's own. */
  decls: Decl[];
}

export interface Model {
  /** Emitted entries, ordered by file name then declaration order. */
  entries: EntryModel[];
  warnings: string[];
}

export interface ModelOptions {
  /** Generator name, for error messages. */
  tool: string;
  /** Files whose text matches are excluded (a hand-written twin exists). */
  skipFilePragma: RegExp;
  /** Top-level names that would shadow platform types; emitted with an `Optio` prefix. */
  reservedTypeNames: ReadonlySet<string>;
  /** Nested type names that would shadow something inside a container; get a `Value` suffix. */
  reservedNestedNames: ReadonlySet<string>;
  /** How the target spells "any JSON value" and a dictionary of it (for warnings). */
  anyName: string;
  anyDictName: string;
  union: {
    /** Name of the nested type for a variant with inline fields. */
    variantTypeName(literal: string): string;
    /** Name payload-less variants too (targets where every variant is a type). */
    nameBareVariants: boolean;
    /** Reserved names for variant types; defaults to `reservedNestedNames`. */
    reservedVariantNames?: ReadonlySet<string>;
    /** Names every union declares in its own scope. */
    scopeNames: readonly string[];
    /** Variant types also avoid every top-level type name. */
    avoidTopLevelNames: boolean;
  };
}

// ── Naming ─────────────────────────────────────────────────────────────────

/**
 * Top-level names every target prefixes with `Optio` (`Task.sleep`, `Error`, …
 * shadow Swift stdlib / Foundation types). Shared so type names match across
 * languages; a target may reserve more.
 */
export const SHARED_RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Task",
  "Error",
  "Result",
  "Data",
  "Date",
  "URL",
  "Notification",
  "Operation",
  "Timer",
  "Thread",
  "Bundle",
  "Process",
  "Optional",
  "Array",
  "Dictionary",
  "Set",
  "String",
  "Character",
  "Never",
  "Decoder",
  "Encoder",
]);

/** Nested type names that would shadow something important inside a struct (`Value` suffix). */
export const SHARED_RESERVED_NESTED_NAMES: ReadonlySet<string> = new Set([
  "Type",
  "Protocol",
  "Self",
  "Data",
  "Date",
  "String",
  "Int",
  "Double",
  "Bool",
  "Array",
  "Dictionary",
  "Optional",
  "Error",
  "Result",
  "Set",
  "Decoder",
  "Encoder",
  "CodingKeys",
  "AnyCodable",
]);

export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function words(s: string): string[] {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w === w.toUpperCase() ? w.toLowerCase() : w));
}

function capitalize(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function pascalCase(s: string): string {
  const ws = words(s);
  if (ws.length === 0) return "Empty";
  const out = ws.map(capitalize).join("");
  return /^[0-9]/.test(out) ? `_${out}` : out;
}

export function camelCase(s: string): string {
  const ws = words(s);
  if (ws.length === 0) return "empty";
  const [first, ...rest] = ws;
  const out = first.charAt(0).toLowerCase() + first.slice(1) + rest.map(capitalize).join("");
  return /^[0-9]/.test(out) ? `_${out}` : out;
}

function singular(name: string): string {
  if (/ies$/.test(name)) return name.replace(/ies$/, "y");
  if (/[^s]s$/.test(name)) return name.slice(0, -1);
  return `${name}Item`;
}

// ── Program ────────────────────────────────────────────────────────────────

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};

/**
 * Parsed standard-library files (lib.*.d.ts and bundled @types) reused across
 * programs. Parsing them dominates the cost of a program — hundreds of ms per
 * call — and every `buildModel` call builds a fresh program. Source files
 * are immutable, so sharing them between programs is safe (it is what the
 * compiler's own incremental `oldProgram` reuse does).
 */
const sharedLibSourceFiles = new Map<string, ts.SourceFile>();

function createCachingHost(): ts.CompilerHost {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const libDir = path.dirname(ts.getDefaultLibFilePath(COMPILER_OPTIONS));
  const baseGetSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const resolved = path.resolve(fileName);
    const cacheable =
      resolved.startsWith(libDir) || resolved.includes(`${path.sep}node_modules${path.sep}`);
    if (!cacheable) {
      return baseGetSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
    }
    const hit = sharedLibSourceFiles.get(resolved);
    if (hit) return hit;
    const sf = baseGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    );
    if (sf) sharedLibSourceFiles.set(resolved, sf);
    return sf;
  };
  return host;
}

// ── Front end ──────────────────────────────────────────────────────────────

interface Ctx {
  sf: ts.SourceFile;
  /** Declarations to nest inside the current container. */
  nested: Decl[];
  usedNames: Set<string>;
}

interface Mapped {
  type: TypeRef;
  optional: boolean;
}

/** A union member as found in the source, before its payload is lowered. */
interface RawVariant {
  literals: string[];
  /** Set when the member is a reference to a named struct. */
  ref?: Entry;
  /** Inline members: the fields other than the discriminator. */
  props: ts.PropertySignature[];
}

const ANY_TYPE: TypeRef = { k: "any" };
const STRING: TypeRef = { k: "string" };
const NUMBER: TypeRef = { k: "number" };
const BOOLEAN: TypeRef = { k: "boolean" };

export function buildModel(sourceFiles: string[], opts: ModelOptions): Model {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };
  const ANY = opts.anyName;

  const files = [...new Set(sourceFiles.map((f) => path.resolve(f)))].sort((a, b) => {
    const ba = path.basename(a);
    const bb = path.basename(b);
    return ba < bb ? -1 : ba > bb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });

  const program = ts.createProgram(files, COMPILER_OPTIONS, createCachingHost());
  const checker = program.getTypeChecker();

  const entries: Entry[] = [];
  const byName = new Map<string, Entry[]>();
  const takenTypeNames = new Map<string, Entry>();

  const rel = (file: string) => path.relative(process.cwd(), file);
  const where = (e: Entry) => `${rel(e.file)}:${e.name}`;

  // ── Pass 1: register every exported declaration ──────────────────────────

  function isExported(node: ts.Node): boolean {
    return (
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    );
  }

  function hasMethods(members: ts.NodeArray<ts.TypeElement>): boolean {
    return members.some(
      (m) =>
        ts.isMethodSignature(m) ||
        ts.isCallSignatureDeclaration(m) ||
        ts.isConstructSignatureDeclaration(m),
    );
  }

  function onlyIndexSignatures(members: ts.NodeArray<ts.TypeElement>): boolean {
    return members.length > 0 && members.every((m) => ts.isIndexSignatureDeclaration(m));
  }

  function classify(node: DeclNode, sf: ts.SourceFile): EntryKind | null {
    if (ts.isEnumDeclaration(node)) return "enum";
    if (node.typeParameters?.length) return null; // generics: skipped silently
    if (ts.isInterfaceDeclaration(node)) {
      if (hasMethods(node.members)) {
        warn(`${rel(sf.fileName)}:${node.name.text}: interface has method members; skipped`);
        return "skipped";
      }
      return onlyIndexSignatures(node.members) ? "dict" : "struct";
    }
    const t = unparen(node.type);
    if (ts.isTypeLiteralNode(t)) {
      if (hasMethods(t.members)) {
        warn(`${rel(sf.fileName)}:${node.name.text}: object type has method members; skipped`);
        return "skipped";
      }
      return onlyIndexSignatures(t.members) ? "dict" : "struct";
    }
    if (ts.isIntersectionTypeNode(t)) return "struct";
    return "alias";
  }

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`${opts.tool}: could not load ${file}`);
    // A file whose twin in the target language is hand-written (e.g. ActivityKit
    // content state in apps/ios/Shared) opts out with a leading pragma comment.
    if (opts.skipFilePragma.test(sf.getFullText())) continue;
    for (const stmt of sf.statements) {
      if (
        !(
          ts.isInterfaceDeclaration(stmt) ||
          ts.isTypeAliasDeclaration(stmt) ||
          ts.isEnumDeclaration(stmt)
        )
      )
        continue;
      if (!isExported(stmt)) continue;
      const kind = classify(stmt, sf);
      if (kind === null) continue;
      const name = stmt.name.text;
      let typeName = opts.reservedTypeNames.has(name) ? `Optio${name}` : name;
      if (takenTypeNames.has(typeName)) {
        const prefix = pascalCase(path.basename(file).replace(/\.[^.]+$/, ""));
        typeName = `${prefix}${name}`;
        let n = 2;
        while (takenTypeNames.has(typeName)) typeName = `${prefix}${name}${n++}`;
        const first = takenTypeNames.get(name)!;
        warn(
          `${rel(file)}:${name}: name collides with ${rel(first.file)}:${name}; emitted as ${typeName}`,
        );
      }
      const entry: Entry = { name, typeName, file, sf, node: stmt, kind };
      entries.push(entry);
      takenTypeNames.set(typeName, entry);
      const list = byName.get(name) ?? [];
      list.push(entry);
      byName.set(name, list);
    }
  }

  const topLevelNames = new Set(entries.map((e) => e.typeName));

  function resolveRef(name: string, ctx: Ctx): Entry | undefined {
    const list = byName.get(name);
    if (!list) return undefined;
    return list.find((e) => e.sf === ctx.sf) ?? list[0];
  }

  // ── Docs ─────────────────────────────────────────────────────────────────

  function docsOf(node: ts.Node, sf: ts.SourceFile): string[] {
    const lines: string[] = [];
    for (const d of ts.getJSDocCommentsAndTags(node)) {
      if (ts.isJSDoc(d) && d.comment) {
        const text = ts.getTextOfJSDocComment(d.comment) ?? "";
        for (const l of text.split("\n")) lines.push(l.trim());
      }
    }
    for (const r of ts.getTrailingCommentRanges(sf.text, node.end) ?? []) {
      const raw = sf.text.slice(r.pos, r.end);
      if (raw.startsWith("//")) lines.push(raw.slice(2).trim());
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  // ── Type mapping ─────────────────────────────────────────────────────────

  function unparen(node: ts.TypeNode): ts.TypeNode {
    while (ts.isParenthesizedTypeNode(node)) node = node.type;
    return node;
  }

  function isNullish(node: ts.TypeNode): boolean {
    node = unparen(node);
    if (node.kind === ts.SyntaxKind.UndefinedKeyword || node.kind === ts.SyntaxKind.VoidKeyword)
      return true;
    return ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
  }

  function stringLiteralOf(node: ts.TypeNode): string | null {
    node = unparen(node);
    if (ts.isLiteralTypeNode(node)) {
      if (ts.isStringLiteral(node.literal) || ts.isNoSubstitutionTemplateLiteral(node.literal))
        return node.literal.text;
    }
    return null;
  }

  /** All string literals of a literal or literal-union node, else null. */
  function stringLiteralsOf(node: ts.TypeNode): string[] | null {
    node = unparen(node);
    const parts = ts.isUnionTypeNode(node) ? flattenUnion(node) : [node];
    const out: string[] = [];
    for (const p of parts) {
      const s = stringLiteralOf(p);
      if (s === null) return null;
      out.push(s);
    }
    return out;
  }

  function flattenUnion(node: ts.UnionTypeNode): ts.TypeNode[] {
    const out: ts.TypeNode[] = [];
    for (const t of node.types) {
      const u = unparen(t);
      if (ts.isUnionTypeNode(u)) out.push(...flattenUnion(u));
      else out.push(u);
    }
    return out;
  }

  function uniqueNested(
    ctx: Ctx,
    base: string,
    reserved: ReadonlySet<string> = opts.reservedNestedNames,
  ): string {
    let name = reserved.has(base) ? `${base}Value` : base;
    let n = 2;
    while (ctx.usedNames.has(name)) name = `${base}${n++}`;
    ctx.usedNames.add(name);
    return name;
  }

  function checkerStringLiterals(node: ts.TypeNode): string[] | null {
    const t = checker.getTypeFromTypeNode(node);
    const parts = t.isUnion() ? t.types : [t];
    if (parts.length === 0) return null;
    const out: string[] = [];
    for (const p of parts) {
      if (!p.isStringLiteral()) return null;
      out.push(p.value);
    }
    return out.sort();
  }

  function plain(type: TypeRef, optional = false): Mapped {
    return { type, optional };
  }

  function mapType(node: ts.TypeNode, ctx: Ctx, hint: string, docs: string[] = []): Mapped {
    node = unparen(node);
    const k = node.kind;
    const any = (reason: string): Mapped => {
      warn(`${rel(ctx.sf.fileName)}: ${hint}: ${reason}; emitted as ${ANY}`);
      return plain(ANY_TYPE);
    };

    switch (k) {
      case ts.SyntaxKind.StringKeyword:
        return plain(STRING);
      case ts.SyntaxKind.NumberKeyword:
        return plain(NUMBER);
      case ts.SyntaxKind.BooleanKeyword:
        return plain(BOOLEAN);
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
      case ts.SyntaxKind.ObjectKeyword:
      case ts.SyntaxKind.NeverKeyword:
      case ts.SyntaxKind.SymbolKeyword:
      case ts.SyntaxKind.BigIntKeyword:
        return plain(ANY_TYPE);
      case ts.SyntaxKind.UndefinedKeyword:
      case ts.SyntaxKind.VoidKeyword:
        return plain(ANY_TYPE, true);
      case ts.SyntaxKind.TemplateLiteralType:
        return plain(STRING);
      case ts.SyntaxKind.FunctionType:
      case ts.SyntaxKind.ConstructorType:
        return any("function type");
      case ts.SyntaxKind.TupleType:
        return any("tuple type");
      default:
        break;
    }

    if (ts.isLiteralTypeNode(node)) {
      const lit = node.literal;
      if (lit.kind === ts.SyntaxKind.NullKeyword) return plain(ANY_TYPE, true);
      if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit)) return plain(STRING);
      if (ts.isNumericLiteral(lit) || ts.isPrefixUnaryExpression(lit)) return plain(NUMBER);
      if (lit.kind === ts.SyntaxKind.TrueKeyword || lit.kind === ts.SyntaxKind.FalseKeyword)
        return plain(BOOLEAN);
      return any("unsupported literal type");
    }

    if (ts.isArrayTypeNode(node)) {
      const el = mapType(node.elementType, ctx, singular(hint));
      return plain({ k: "array", element: el.type, optional: el.optional });
    }

    if (ts.isTypeReferenceNode(node)) return mapReference(node, ctx, hint);

    if (ts.isTypeLiteralNode(node)) return mapTypeLiteral(node, ctx, hint, docs);

    if (ts.isUnionTypeNode(node)) return mapUnion(flattenUnion(node), ctx, hint, docs);

    if (ts.isIntersectionTypeNode(node)) {
      const props = intersectionProps(node, ctx);
      if (!props) return any("irregular intersection");
      const name = uniqueNested(ctx, pascalCase(hint));
      ctx.nested.push(lowerStruct(name, docs, props, ctx));
      return plain({ k: "nested", name });
    }

    if (
      ts.isTypeOperatorNode(node) ||
      ts.isIndexedAccessTypeNode(node) ||
      ts.isTypeQueryNode(node)
    ) {
      const lits = checkerStringLiterals(node);
      if (lits) {
        const name = uniqueNested(ctx, pascalCase(hint));
        ctx.nested.push({
          kind: "stringEnum",
          name,
          docs,
          cases: lits.map((l) => ({ raw: l, source: l, docs: [] })),
          at: `${rel(ctx.sf.fileName)}: ${hint}`,
        });
        return plain({ k: "nested", name });
      }
      return any(`unresolvable type expression \`${node.getText(ctx.sf)}\``);
    }

    return any(`unsupported type syntax \`${node.getText(ctx.sf)}\``);
  }

  function mapReference(node: ts.TypeReferenceNode, ctx: Ctx, hint: string): Mapped {
    const any = (reason: string): Mapped => {
      warn(`${rel(ctx.sf.fileName)}: ${hint}: ${reason}; emitted as ${ANY}`);
      return plain(ANY_TYPE);
    };
    if (!ts.isIdentifier(node.typeName)) {
      return any(`qualified type \`${node.typeName.getText(ctx.sf)}\``);
    }
    const name = node.typeName.text;
    const args = node.typeArguments ?? [];

    switch (name) {
      case "Date":
        return plain({ k: "date" });
      case "Array":
      case "ReadonlyArray": {
        if (args.length !== 1) return any("Array without element type");
        const el = mapType(args[0], ctx, singular(hint));
        return plain({ k: "array", element: el.type, optional: el.optional });
      }
      case "Record": {
        if (args.length !== 2) return any("Record without type arguments");
        const key = unparen(args[0]);
        if (key.kind !== ts.SyntaxKind.StringKeyword && !stringLiteralsOf(key)) {
          return any("Record with non-string keys");
        }
        const val = mapType(args[1], ctx, singular(hint));
        return plain({ k: "map", value: val.type, optional: val.optional });
      }
      case "Readonly":
      case "NonNullable":
        if (args.length === 1) return mapType(args[0], ctx, hint);
        return any(`${name} without type argument`);
      case "Partial":
      case "Required":
      case "Pick":
      case "Omit":
      case "Promise":
      case "Map":
      case "Set":
        return any(`unsupported utility type ${name}`);
      default:
        break;
    }

    if (args.length) return any(`generic reference ${name}<…>`);
    const entry = resolveRef(name, ctx);
    if (!entry) return any(`unresolved type reference ${name}`);
    if (entry.kind === "skipped") return any(`reference to skipped type ${name}`);
    return plain({ k: "entry", entry });
  }

  function mapTypeLiteral(
    node: ts.TypeLiteralNode,
    ctx: Ctx,
    hint: string,
    docs: string[],
  ): Mapped {
    const index = node.members.find(ts.isIndexSignatureDeclaration);
    if (index) {
      const named = node.members.filter((m) => !ts.isIndexSignatureDeclaration(m));
      if (named.length) {
        warn(
          `${rel(ctx.sf.fileName)}: ${hint}: object with an index signature and ${named.length} named field(s); emitted as ${opts.anyDictName} (named fields dropped)`,
        );
        return plain({ k: "map", value: ANY_TYPE, optional: false });
      }
      const val = index.type ? mapType(index.type, ctx, singular(hint)) : plain(ANY_TYPE);
      return plain({ k: "map", value: val.type, optional: val.optional });
    }
    const name = uniqueNested(ctx, pascalCase(hint));
    ctx.nested.push(lowerStruct(name, docs, propsOfMembers(node.members, ctx), ctx));
    return plain({ k: "nested", name });
  }

  function mapUnion(members: ts.TypeNode[], ctx: Ctx, hint: string, docs: string[]): Mapped {
    const any = (reason: string): Mapped => {
      warn(`${rel(ctx.sf.fileName)}: ${hint}: ${reason}; emitted as ${ANY}`);
      return plain(ANY_TYPE);
    };
    const optional = members.some(isNullish);
    const rest = members.filter((m) => !isNullish(m));
    if (rest.length === 0) return plain(ANY_TYPE, true);

    if (rest.length === 1) {
      const m = mapType(rest[0], ctx, hint, docs);
      return plain(m.type, optional || m.optional);
    }

    const literals = rest.map(stringLiteralOf);
    if (literals.every((l) => l !== null)) {
      const name = uniqueNested(ctx, pascalCase(hint));
      ctx.nested.push({
        kind: "stringEnum",
        name,
        docs,
        cases: (literals as string[]).map((l) => ({ raw: l, source: l, docs: [] })),
        at: `${rel(ctx.sf.fileName)}: ${hint}`,
      });
      return plain({ k: "nested", name }, optional);
    }

    // Primitive widenings: "a" | "b" | string, 1 | 2 | number, true | false.
    const prim = primitiveOf(rest);
    if (prim) return plain(prim, optional);

    if (rest.every((m) => isObjectish(m, ctx))) {
      const variants = discriminatedVariants(rest, ctx, hint);
      if (variants) {
        const name = uniqueNested(ctx, pascalCase(hint));
        ctx.nested.push(lowerUnion(name, docs, variants.key, variants.variants, ctx));
        return plain({ k: "nested", name }, optional);
      }
      return any("object union without a common string-literal discriminator (`kind` / `type`)");
    }

    return any("irregular union");
  }

  function primitiveOf(members: ts.TypeNode[]): TypeRef | null {
    const kinds = new Set<"string" | "number" | "boolean">();
    for (const m of members) {
      const u = unparen(m);
      if (u.kind === ts.SyntaxKind.StringKeyword || stringLiteralOf(u) !== null)
        kinds.add("string");
      else if (
        u.kind === ts.SyntaxKind.NumberKeyword ||
        (ts.isLiteralTypeNode(u) &&
          (ts.isNumericLiteral(u.literal) || ts.isPrefixUnaryExpression(u.literal)))
      )
        kinds.add("number");
      else if (
        u.kind === ts.SyntaxKind.BooleanKeyword ||
        (ts.isLiteralTypeNode(u) &&
          (u.literal.kind === ts.SyntaxKind.TrueKeyword ||
            u.literal.kind === ts.SyntaxKind.FalseKeyword))
      )
        kinds.add("boolean");
      else return null;
    }
    return kinds.size === 1 ? { k: [...kinds][0] } : null;
  }

  function isObjectish(node: ts.TypeNode, ctx: Ctx): boolean {
    node = unparen(node);
    if (ts.isTypeLiteralNode(node)) return !node.members.some(ts.isIndexSignatureDeclaration);
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !node.typeArguments) {
      const e = resolveRef(node.typeName.text, ctx);
      return e?.kind === "struct";
    }
    return false;
  }

  // ── Properties ───────────────────────────────────────────────────────────

  function propsOfMembers(members: ts.NodeArray<ts.TypeElement>, ctx: Ctx): ts.PropertySignature[] {
    const out: ts.PropertySignature[] = [];
    for (const m of members) {
      if (ts.isPropertySignature(m)) {
        if (ts.isComputedPropertyName(m.name)) {
          warn(`${rel(ctx.sf.fileName)}: computed property \`${m.name.getText(ctx.sf)}\` skipped`);
          continue;
        }
        out.push(m);
      } else if (ts.isMethodSignature(m)) {
        warn(`${rel(ctx.sf.fileName)}: method \`${m.name.getText(ctx.sf)}\` skipped`);
      }
    }
    return out;
  }

  function propName(p: ts.PropertySignature): string {
    const n = p.name;
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
    if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      return n.text;
    return n.getText();
  }

  function mergeProps(lists: ts.PropertySignature[][]): ts.PropertySignature[] {
    const order: string[] = [];
    const map = new Map<string, ts.PropertySignature>();
    for (const list of lists) {
      for (const p of list) {
        const n = propName(p);
        if (!map.has(n)) order.push(n);
        map.set(n, p); // later declarations override inherited ones
      }
    }
    return order.map((n) => map.get(n)!);
  }

  const propsCache = new Map<Entry, ts.PropertySignature[] | null>();

  /** Flattened property list of a struct-kind entry (extends / intersections resolved). */
  function propsOfEntry(entry: Entry, seen: Set<Entry> = new Set()): ts.PropertySignature[] | null {
    if (propsCache.has(entry)) return propsCache.get(entry)!;
    if (seen.has(entry)) {
      warn(`${where(entry)}: circular extends chain`);
      return null;
    }
    seen.add(entry);
    const ctx = newCtx(entry.sf);
    let result: ts.PropertySignature[] | null = null;
    const node = entry.node;
    if (ts.isInterfaceDeclaration(node)) {
      const lists: ts.PropertySignature[][] = [];
      for (const h of node.heritageClauses ?? []) {
        if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const t of h.types) {
          const parentName = t.expression.getText(entry.sf);
          const parent = ts.isIdentifier(t.expression) ? resolveRef(parentName, ctx) : undefined;
          if (t.typeArguments?.length || !parent || parent.kind !== "struct") {
            warn(
              `${where(entry)}: cannot flatten \`extends ${t.getText(entry.sf)}\`; its fields are omitted`,
            );
            continue;
          }
          const parentProps = propsOfEntry(parent, seen);
          if (parentProps) lists.push(parentProps);
        }
      }
      lists.push(propsOfMembers(node.members, ctx));
      result = mergeProps(lists);
    } else if (ts.isTypeAliasDeclaration(node)) {
      const t = unparen(node.type);
      if (ts.isTypeLiteralNode(t)) result = propsOfMembers(t.members, ctx);
      else if (ts.isIntersectionTypeNode(t)) result = intersectionProps(t, ctx, seen);
    }
    propsCache.set(entry, result);
    return result;
  }

  function intersectionProps(
    node: ts.IntersectionTypeNode,
    ctx: Ctx,
    seen: Set<Entry> = new Set(),
  ): ts.PropertySignature[] | null {
    const lists: ts.PropertySignature[][] = [];
    for (const part of node.types) {
      const p = unparen(part);
      if (ts.isTypeLiteralNode(p) && !p.members.some(ts.isIndexSignatureDeclaration)) {
        lists.push(propsOfMembers(p.members, ctx));
        continue;
      }
      if (ts.isTypeReferenceNode(p) && ts.isIdentifier(p.typeName) && !p.typeArguments) {
        const e = resolveRef(p.typeName.text, ctx);
        if (e?.kind === "struct") {
          const props = propsOfEntry(e, seen);
          if (props) {
            lists.push(props);
            continue;
          }
        }
      }
      return null;
    }
    return mergeProps(lists);
  }

  function buildProps(sigs: ts.PropertySignature[], ctx: Ctx): Prop[] {
    const used = new Set<string>();
    const out: Prop[] = [];
    for (const sig of sigs) {
      const jsonName = propName(sig);
      let name = IDENT_RE.test(jsonName) ? jsonName : camelCase(jsonName);
      let n = 2;
      while (used.has(name)) name = `${name}${n++}`;
      used.add(name);
      const docs = docsOf(sig, ctx.sf);
      const mapped = sig.type ? mapType(sig.type, ctx, jsonName, []) : plain(ANY_TYPE);
      out.push({
        jsonName,
        name,
        type: mapped.type,
        optional: mapped.optional || !!sig.questionToken,
        docs,
      });
    }
    return out;
  }

  // ── Discriminated unions ─────────────────────────────────────────────────

  interface MemberShape {
    props: ts.PropertySignature[];
    /** Set when the member is a reference to a named struct. */
    ref?: Entry;
    ctx: Ctx;
  }

  function memberShape(node: ts.TypeNode, ctx: Ctx): MemberShape | null {
    node = unparen(node);
    if (ts.isTypeLiteralNode(node)) return { props: propsOfMembers(node.members, ctx), ctx };
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const e = resolveRef(node.typeName.text, ctx);
      if (!e || e.kind !== "struct") return null;
      const props = propsOfEntry(e);
      if (!props) return null;
      return { props, ref: e, ctx: newCtx(e.sf) };
    }
    return null;
  }

  function discriminatedVariants(
    members: ts.TypeNode[],
    ctx: Ctx,
    hint: string,
  ): { key: string; variants: RawVariant[] } | null {
    const shapes: MemberShape[] = [];
    for (const m of members) {
      const s = memberShape(m, ctx);
      if (!s) return null;
      shapes.push(s);
    }
    // Candidate keys: present in every member with a string-literal type.
    const literalKeys = (s: MemberShape) => {
      const keys = new Map<string, string[]>();
      for (const p of s.props) {
        if (!p.type || p.questionToken) continue;
        const lits = stringLiteralsOf(p.type);
        if (lits) keys.set(propName(p), lits);
      }
      return keys;
    };
    const perMember = shapes.map(literalKeys);
    const common = [...perMember[0].keys()].filter((k) => perMember.every((m) => m.has(k)));
    if (common.length === 0) return null;
    const key =
      common.find((k) => k === "kind") ?? common.find((k) => k === "type") ?? [...common].sort()[0];

    const variants: RawVariant[] = [];
    const seenLits = new Set<string>();
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      const literals = perMember[i].get(key)!;
      for (const l of literals) {
        if (seenLits.has(l)) {
          warn(
            `${rel(ctx.sf.fileName)}: ${hint}: discriminator value "${l}" appears in more than one member`,
          );
          return null;
        }
        seenLits.add(l);
      }
      if (s.ref) variants.push({ literals, ref: s.ref, props: [] });
      else variants.push({ literals, props: s.props.filter((p) => propName(p) !== key) });
    }
    return { key, variants };
  }

  // ── Lowering ─────────────────────────────────────────────────────────────

  function newCtx(sf: ts.SourceFile): Ctx {
    return { sf, nested: [], usedNames: new Set() };
  }

  function lowerStruct(
    name: string,
    docs: string[],
    sigs: ts.PropertySignature[],
    parent: Ctx,
  ): StructDecl {
    const ctx = newCtx(parent.sf);
    ctx.usedNames.add(name);
    const props = buildProps(sigs, ctx);
    return { kind: "struct", name, docs, props, nested: ctx.nested };
  }

  function lowerUnion(
    name: string,
    docs: string[],
    key: string,
    variants: RawVariant[],
    parent: Ctx,
  ): UnionDecl {
    const ctx = newCtx(parent.sf);
    ctx.usedNames.add(name);
    for (const n of opts.union.scopeNames) ctx.usedNames.add(n);
    if (opts.union.avoidTopLevelNames) for (const n of topLevelNames) ctx.usedNames.add(n);
    const reserved = opts.union.reservedVariantNames ?? opts.reservedNestedNames;
    const out: Variant[] = [];
    for (const v of variants) {
      if (v.ref) {
        out.push({ literals: v.literals, payload: { k: "entry", entry: v.ref } });
      } else if (v.props.length) {
        const typeName = uniqueNested(ctx, opts.union.variantTypeName(v.literals[0]), reserved);
        out.push({
          literals: v.literals,
          payload: { k: "inline", struct: lowerStruct(typeName, [], v.props, ctx) },
        });
      } else {
        const typeName = opts.union.nameBareVariants
          ? uniqueNested(ctx, opts.union.variantTypeName(v.literals[0]), reserved)
          : null;
        out.push({ literals: v.literals, payload: { k: "none", name: typeName } });
      }
    }
    return { kind: "union", name, docs, key, variants: out };
  }

  function lowerTsEnum(entry: Entry): Decl {
    const node = entry.node as ts.EnumDeclaration;
    const docs = docsOf(node, entry.sf);
    const members = node.members;
    const memberName = (m: ts.EnumMember) =>
      ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)
        ? m.name.text
        : m.name.getText(entry.sf);
    const allString = members.every((m) => m.initializer && ts.isStringLiteral(m.initializer));
    if (allString) {
      return {
        kind: "stringEnum",
        name: entry.typeName,
        docs,
        cases: members.map((m) => ({
          raw: (m.initializer as ts.StringLiteral).text,
          source: memberName(m),
          docs: docsOf(m, entry.sf),
        })),
        at: where(entry),
      };
    }
    const cases: IntEnumCase[] = [];
    let next = 0;
    for (const m of members) {
      let value = next;
      if (m.initializer) {
        const init = m.initializer;
        if (ts.isNumericLiteral(init)) value = Number(init.text);
        else if (
          ts.isPrefixUnaryExpression(init) &&
          init.operator === ts.SyntaxKind.MinusToken &&
          ts.isNumericLiteral(init.operand)
        )
          value = -Number(init.operand.text);
        else {
          warn(`${where(entry)}: enum has a non-literal initializer; emitted as typealias ${ANY}`);
          return { kind: "alias", name: entry.typeName, docs, type: ANY_TYPE, optional: false };
        }
      }
      next = value + 1;
      cases.push({ value, source: memberName(m), docs: docsOf(m, entry.sf) });
    }
    return { kind: "intEnum", name: entry.typeName, docs, cases };
  }

  function lowerEntry(entry: Entry): Decl[] | null {
    const docs = docsOf(entry.node, entry.sf);
    const ctx = newCtx(entry.sf);
    switch (entry.kind) {
      case "skipped":
        return null;
      case "enum":
        return [lowerTsEnum(entry)];
      case "dict": {
        const node = entry.node;
        const members = ts.isInterfaceDeclaration(node)
          ? node.members
          : (unparen((node as ts.TypeAliasDeclaration).type) as ts.TypeLiteralNode).members;
        const index = members.find(ts.isIndexSignatureDeclaration)!;
        const val = index.type ? mapType(index.type, ctx, entry.typeName) : plain(ANY_TYPE);
        return [
          ...ctx.nested,
          {
            kind: "alias",
            name: entry.typeName,
            docs,
            type: { k: "map", value: val.type, optional: val.optional },
            optional: false,
          },
        ];
      }
      case "struct": {
        const props = propsOfEntry(entry);
        if (!props) {
          warn(`${where(entry)}: irregular intersection; emitted as typealias ${ANY}`);
          return [{ kind: "alias", name: entry.typeName, docs, type: ANY_TYPE, optional: false }];
        }
        return [lowerStruct(entry.typeName, docs, props, ctx)];
      }
      case "alias": {
        const node = entry.node as ts.TypeAliasDeclaration;
        const single = stringLiteralOf(node.type);
        if (single !== null) {
          // A one-member "union" — still an enum so the server can grow it.
          return [
            {
              kind: "stringEnum",
              name: entry.typeName,
              docs,
              cases: [{ raw: single, source: single, docs: [] }],
              at: where(entry),
            },
          ];
        }
        const mapped = mapType(node.type, ctx, entry.typeName, docs);
        // A union / keyof alias emits a top-level enum named after the alias.
        const own = ctx.nested.filter((d) => d.name === entry.typeName);
        const others = ctx.nested.filter((d) => !own.includes(d));
        if (own.length && mapped.type.k === "nested" && mapped.type.name === entry.typeName) {
          if (mapped.optional) {
            warn(
              `${where(entry)}: \`null\` in a top-level union is dropped; declare fields using it as optional`,
            );
          }
          return [...others, ...own];
        }
        return [
          ...others,
          {
            kind: "alias",
            name: entry.typeName,
            docs,
            type: mapped.type,
            optional: mapped.optional,
          },
        ];
      }
    }
  }

  // ── Pass 2: lower ────────────────────────────────────────────────────────

  const out: EntryModel[] = [];
  for (const entry of entries) {
    const decls = lowerEntry(entry);
    if (decls === null) continue;
    out.push({ entry, decls });
  }
  return { entries: out, warnings };
}

// ── Inputs ─────────────────────────────────────────────────────────────────

/** `packages/shared/src/types/*.ts` (minus tests) plus `utils/extract-work-links.ts`. */
export function defaultInputs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const typesDir = path.resolve(here, "../src/types");
  const files = fs
    .readdirSync(typesDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map((f) => path.join(typesDir, f));
  files.push(path.resolve(here, "../src/utils/extract-work-links.ts"));
  return files;
}

/** Push a warning unless the same text is already listed. */
export function addWarning(warnings: string[], msg: string): void {
  if (!warnings.includes(msg)) warnings.push(msg);
}
