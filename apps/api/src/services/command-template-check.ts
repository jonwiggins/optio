/**
 * The save-time check for command templates — a Job with no agent, a Local
 * automation's command. `renderCommandTemplate` hands each `{{param}}` to
 * the command as a shell variable, so the shell that runs the command never
 * parses a value as code, bare or inside quotes. That holds for one parser
 * only. Where the template hands the value to a second one, the value is
 * code again:
 *
 * - **A second interpreter**: `sh -c "… {{x}} …"` (any shell, `su -c`,
 *   `kubectl exec … -- sh -c`), `eval`, `ssh host "…"`, `trap`, `watch`,
 *   `parallel`, an inline program (`python -c`, `node -e`, `perl -e`,
 *   `ruby -e`, `awk '…'`, `sed '…'`, …), or a shell reading its program from
 *   a pipe, a here-document or a here-string (`echo {{x}} | sh`).
 * - **Bash arithmetic**: `(( ))`, `$(( ))`, `let`, `[[ … -eq … ]]` and the
 *   other `[[ ]]` number comparisons, array subscripts, `${var:offset}`, and
 *   the places a value is taken as a variable name (`declare -i` / `-n`,
 *   `read`, `printf -v`, `test -v`). Bash evaluates `a[$(cmd)]` there, which
 *   runs `cmd`.
 *
 * `commandTemplateHazard` finds a placeholder in one of those places, so the
 * API can refuse the template when it is saved (created or changed; a stored
 * one keeps running). It reads the template the way bash would, closely
 * enough for the forms people write; it is a guardrail, not a proof — a
 * template that pipes a value into a program of its own is past what it can
 * see.
 */

const PLACEHOLDER = /^\{\{\s*(\w+)\s*\}\}/;
const CONDITIONAL = /\{\{#if\s+\w+\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

/** A `{{param}}` in a word: its name, where it starts in the word, and whether bash evaluates it as arithmetic there. */
interface Hole {
  name: string;
  at: number;
  arith: boolean;
}

interface Word {
  kind: "word";
  text: string;
  holes: Hole[];
}

interface Op {
  kind: "op";
  op: string;
  /**
   * A here-document's body (`<<EOF`), unless its delimiter is quoted (then
   * the body is literal): its placeholders, and its text, which bash expands
   * like a double-quoted string.
   */
  body?: Word;
}

type Token = Word | Op;

/** What is wrong with a template: the param and a message the API answers with. */
export interface CommandTemplateHazard {
  param: string;
  message: string;
}

/** Each way a template's `{{#if}}` blocks can come out: every one kept, every one dropped. */
function variants(template: string): string[] {
  const pick = (kept: boolean) =>
    template.replace(CONDITIONAL, (_m, body: string) => {
      const at = body.indexOf("{{else}}");
      if (at === -1) return kept ? body : "";
      return kept ? body.slice(0, at) : body.slice(at + "{{else}}".length);
    });
  return [...new Set([pick(true), pick(false)])];
}

const REDIRECTS = new Set([">", ">>", "<", "<>", ">|", ">&", "<&", "&>", "&>>"]);

/**
 * Bash's words and operators, with each placeholder's context. `heredoc`:
 * `src` is a here-document's body, expanded like a double-quoted string
 * whose `"` are plain characters.
 */
function lex(src: string, heredoc = false): Token[] {
  const tokens: Token[] = [];
  let word: Word | null = null;
  let quote: "'" | '"' | null = heredoc ? '"' : null;
  // Open `$(…)` / backtick command substitutions, with the quote they started in.
  const subs: Array<{ kind: "paren" | "tick"; quote: "'" | '"' | null; depth: number }> = [];
  let parens = 0;
  let arith = 0; // open parens of `$(( ))` / `(( ))`
  let arithBracket = 0; // `$[ ]`
  let subscript = 0; // inside `name[ … ]`
  const braces: Array<{ name: string; decided: boolean; arith: boolean }> = [];
  let heredocOp: Op | null = null; // a `<<` waiting for its delimiter word
  let pending: Array<{ op: Op; delim: string; strip: boolean; quoted: boolean }> = [];

  const add = (s: string) => {
    word ??= { kind: "word", text: "", holes: [] };
    word.text += s;
  };
  const endWord = () => {
    if (!word) return;
    const w: Word = word;
    word = null;
    if (heredocOp) {
      const raw = w.text;
      pending.push({
        op: heredocOp,
        delim: raw.replace(/['"\\]/g, ""),
        strip: heredocOp.op === "<<-",
        quoted: /['"\\]/.test(raw),
      });
      heredocOp = null;
      return;
    }
    tokens.push(w);
  };
  const op = (o: string) => {
    endWord();
    const t: Op = { kind: "op", op: o };
    tokens.push(t);
    if (o === "<<" || o === "<<-") heredocOp = t;
    return t;
  };
  const inArith = () =>
    arith > 0 || arithBracket > 0 || subscript > 0 || braces.some((b) => b.arith);

  let i = 0;
  while (i < src.length) {
    const placeholder = PLACEHOLDER.exec(src.slice(i, i + 200));
    if (placeholder) {
      word ??= { kind: "word", text: "", holes: [] };
      word.holes.push({ name: placeholder[1], at: word.text.length, arith: inArith() });
      word.text += placeholder[0];
      i += placeholder[0].length;
      continue;
    }
    const c = src[i];
    const next = src[i + 1] ?? "";

    // Arithmetic: everything is part of the expression until its parens close.
    if (arith > 0) {
      if (c === "(") arith++;
      else if (c === ")") arith--;
      add(c);
      i++;
      continue;
    }
    if (arithBracket > 0) {
      if (c === "[") arithBracket++;
      else if (c === "]") arithBracket--;
      add(c);
      i++;
      continue;
    }

    if (quote === "'") {
      if (c === "'") quote = null;
      add(c);
      i++;
      continue;
    }

    // `${…}`: is it `${name:offset}` (arithmetic)? Decided at the first character past the name.
    const brace = braces[braces.length - 1];
    if (brace && !brace.decided && c !== "}") {
      if (brace.name === "" && (c === "#" || c === "!")) {
        add(c);
        i++;
        continue;
      }
      if (/\w/.test(c)) {
        brace.name += c;
        add(c);
        i++;
        continue;
      }
      brace.decided = true;
      brace.arith = c === ":" && !"-=?+".includes(next);
    }

    if (c === "\\") {
      add(src.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (c === "$" && next === "(" && src[i + 2] === "(") {
      add("$((");
      arith = 2;
      i += 3;
      continue;
    }
    if (c === "$" && next === "[") {
      add("$[");
      arithBracket = 1;
      i += 2;
      continue;
    }
    if (c === "$" && next === "{") {
      add("${");
      braces.push({ name: "", decided: false, arith: false });
      i += 2;
      continue;
    }
    if (c === "$" && next === "(") {
      // A command substitution is commands of its own, in a quote of its own.
      op("(");
      subs.push({ kind: "paren", quote, depth: parens });
      quote = null;
      i += 2;
      continue;
    }
    if (c === "$" && next === "'") {
      add("$'");
      quote = "'";
      i += 2;
      continue;
    }
    if (c === "`") {
      const top = subs[subs.length - 1];
      if (top?.kind === "tick") {
        op(")");
        quote = top.quote;
        subs.pop();
      } else {
        op("(");
        subs.push({ kind: "tick", quote, depth: parens });
        quote = null;
      }
      i++;
      continue;
    }
    if (c === "}" && braces.length > 0) {
      braces.pop();
      add(c);
      i++;
      continue;
    }
    if (c === "[") {
      // `name[` opens a subscript: in `${name[…]}`, and, unquoted, `name[…]=` and friends.
      const before = word?.text ?? "";
      const sub = quote === '"' ? /\$\{[#!]?[A-Za-z_]\w*$/ : /(?:^|\$\{[#!]?)[A-Za-z_]\w*$/;
      if (sub.test(before)) subscript++;
      add(c);
      i++;
      continue;
    }
    if (c === "]" && subscript > 0) {
      subscript--;
      add(c);
      i++;
      continue;
    }

    if (quote === '"') {
      if (c === '"' && !(heredoc && subs.length === 0)) quote = null;
      add(c);
      i++;
      continue;
    }

    // Unquoted.
    if (c === "'" || c === '"') {
      quote = c;
      add(c);
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "#" && !word) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      op("\n");
      i++;
      // Here-documents start on the next line.
      for (const doc of pending) {
        const body: Word = { kind: "word", text: "", holes: [] };
        while (i < src.length) {
          const end = src.indexOf("\n", i);
          const line = src.slice(i, end === -1 ? src.length : end);
          i = end === -1 ? src.length : end + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
          for (let j = 0; j < line.length; j++) {
            const h = PLACEHOLDER.exec(line.slice(j, j + 200));
            if (h) body.holes.push({ name: h[1], at: body.text.length + j, arith: false });
          }
          body.text += `${line}\n`;
        }
        if (!doc.quoted) doc.op.body = body;
      }
      pending = [];
      continue;
    }
    if (c === "(" && next === "(" && !word) {
      add("((");
      arith = 2;
      i += 2;
      continue;
    }
    if (c === "(") {
      op("(");
      parens++;
      i++;
      continue;
    }
    if (c === ")") {
      const top = subs[subs.length - 1];
      if (top?.kind === "paren" && parens === top.depth) {
        op(")");
        quote = top.quote;
        subs.pop();
      } else {
        op(")");
        parens = Math.max(0, parens - 1);
      }
      i++;
      continue;
    }
    if (c === ";" || c === "&" || c === "|") {
      const two = src.slice(i, i + 2);
      if (["&&", "||", ";;", "|&", "&>"].includes(two)) {
        if (two === "&>") {
          const three = src.slice(i, i + 3);
          op(three === "&>>" ? "&>>" : "&>");
          i += three === "&>>" ? 3 : 2;
        } else {
          op(two);
          i += 2;
        }
      } else {
        op(c);
        i++;
      }
      continue;
    }
    if (c === "<" || c === ">") {
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      if (three === "<<<" || three === "<<-") {
        op(three);
        i += 3;
      } else if ((c === "<" || c === ">") && next === "(") {
        // Process substitution: commands of its own.
        op("(");
        subs.push({ kind: "paren", quote, depth: parens });
        i += 2;
      } else if (["<<", ">>", "<>", ">|", ">&", "<&"].includes(two)) {
        op(two);
        i += 2;
      } else {
        op(c);
        i++;
      }
      continue;
    }
    add(c);
    i++;
  }
  endWord();
  return tokens;
}

/** A word as bash would hand it over, quotes removed (near enough to name a program or a flag). */
const plain = (w: Word) => w.text.replace(/['"\\]/g, "");
const plainAt = (words: Word[], k: number) => (words[k] ? plain(words[k]) : "");
const basename = (s: string) => s.slice(s.lastIndexOf("/") + 1);

interface Command {
  words: Word[];
  /** Here-strings (`<<< word`) and unquoted here-document bodies: what it reads on stdin. */
  stdin: Word[];
}

/** The simple commands, grouped into pipelines. */
function pipelines(tokens: Token[]): Command[][] {
  const out: Command[][] = [];
  let pipeline: Command[] = [];
  let cmd: Command = { words: [], stdin: [] };
  let after: string | null = null;
  const endCommand = () => {
    if (cmd.words.length > 0 || cmd.stdin.length > 0) pipeline.push(cmd);
    cmd = { words: [], stdin: [] };
  };
  const endPipeline = () => {
    endCommand();
    if (pipeline.length > 0) out.push(pipeline);
    pipeline = [];
  };
  for (const t of tokens) {
    if (t.kind === "word") {
      if (after === "<<<") cmd.stdin.push(t);
      else if (!after || !REDIRECTS.has(after)) cmd.words.push(t);
      after = null;
      continue;
    }
    after = t.op;
    if (t.op === "<<" || t.op === "<<-") {
      if (t.body) cmd.stdin.push(t.body);
    } else if (t.op === "|" || t.op === "|&") {
      endCommand();
    } else if (t.op !== "<<<" && !REDIRECTS.has(t.op)) {
      endPipeline();
    }
  }
  endPipeline();
  return out;
}

/** How a program reads its code: the flag that takes it, flags with an argument, and so on. */
interface ProgramSpec {
  /** The flag whose argument (`-c CODE`, `--eval=CODE`) is the program. */
  code: RegExp;
  /** Other flags that take the next word. */
  takesArg?: ReadonlySet<string>;
  /** The flag naming a program file (no program inline then). */
  file?: ReadonlySet<string>;
  /** The first operand is the program (awk, sed) unless a code or file flag gave it. */
  operandIsCode?: boolean;
  /** The code flag may come after operands (`su - deploy -c "…"`). */
  scanAll?: boolean;
  /** Reads its program from stdin when given none (`… | sh`, `python3 <<EOF`). */
  stdinProgram?: boolean;
  /** Several code flags may be given (`sed -e … -e …`); otherwise what follows the first is arguments. */
  manyCode?: boolean;
}

const SHELL_SPEC: ProgramSpec = {
  code: /^-[A-Za-z]*c[A-Za-z]*$/,
  takesArg: new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]),
  stdinProgram: true,
};

const PROGRAMS: Record<string, ProgramSpec> = {
  ...Object.fromEntries(
    ["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash", "fish", "csh", "tcsh"].map((s) => [
      s,
      SHELL_SPEC,
    ]),
  ),
  su: {
    code: /^(-[A-Za-z]*c|--command)$/,
    takesArg: new Set(["-s", "--shell", "-g", "-G"]),
    scanAll: true,
  },
  runuser: {
    code: /^(-[A-Za-z]*c|--command)$/,
    takesArg: new Set(["-s", "--shell", "-g", "-G", "-u", "--user"]),
    scanAll: true,
  },
  script: { code: /^(-[A-Za-z]*c|--command)$/, scanAll: true },
  python: { code: /^-[A-Za-z]*c$/, takesArg: new Set(["-W", "-X"]), stdinProgram: true },
  node: {
    code: /^(-e|--eval|-p|--print|-pe)$/,
    takesArg: new Set(["-r", "--require", "--import", "--loader", "-C"]),
    stdinProgram: true,
  },
  bun: { code: /^(-e|--eval|-p|--print)$/ },
  perl: { code: /^-[A-Za-z]*[eE]$/, takesArg: new Set(["-I"]), stdinProgram: true, manyCode: true },
  ruby: {
    code: /^-[A-Za-z]*e$/,
    takesArg: new Set(["-I", "-r"]),
    stdinProgram: true,
    manyCode: true,
  },
  php: { code: /^-r$/, takesArg: new Set(["-c", "-d"]), file: new Set(["-f"]), stdinProgram: true },
  osascript: { code: /^-e$/, stdinProgram: true, manyCode: true },
  lua: { code: /^-e$/, takesArg: new Set(["-l"]), stdinProgram: true, manyCode: true },
  Rscript: { code: /^-e$/, manyCode: true },
  awk: {
    code: /^(-e|--source)$/,
    takesArg: new Set(["-F", "-v", "--assign", "--field-separator", "-W"]),
    file: new Set(["-f", "--file"]),
    operandIsCode: true,
    manyCode: true,
  },
  sed: {
    code: /^(-e|--expression)$/,
    takesArg: new Set(["-l", "--line-length"]),
    file: new Set(["-f", "--file"]),
    operandIsCode: true,
    manyCode: true,
  },
};

function programSpec(name: string): ProgramSpec | null {
  if (/^python[0-9.]*$/.test(name) || /^pypy[0-9.]*$/.test(name)) return PROGRAMS.python;
  if (name === "nodejs") return PROGRAMS.node;
  if (name === "luajit") return PROGRAMS.lua;
  if (["gawk", "mawk", "nawk"].includes(name)) return PROGRAMS.awk;
  if (name === "gsed") return PROGRAMS.sed;
  return Object.prototype.hasOwnProperty.call(PROGRAMS, name) ? PROGRAMS[name] : null;
}

/** Commands that parse their arguments again as shell code. */
const REPARSE: Record<string, string> = {
  eval: "`eval` parses its arguments again as shell code",
  ssh: "`ssh` hands its arguments to the remote shell, which parses them as code",
  trap: "`trap` runs its action as shell code",
  watch: "`watch` runs its command through `sh -c`",
  parallel: "`parallel` runs its command through a shell",
};

interface ProgramUse {
  label: string;
  /** Words it runs as a program. */
  code: Word[];
  /** It parses every later word as code (eval, ssh). */
  reparse?: { from: number; why: string };
  /** It reads its program from stdin. */
  stdinProgram: boolean;
}

/** The programs a command runs and which of its words they run as code. */
function programsIn(words: Word[]): ProgramUse[] {
  const uses: ProgramUse[] = [];
  for (let j = 0; j < words.length; j++) {
    const name = basename(plain(words[j]));
    if (REPARSE[name]) {
      // ssh with nothing but a host reads the remote commands from stdin.
      let operands = 0;
      for (let k = j + 1; k < words.length; k++) if (!plain(words[k]).startsWith("-")) operands++;
      uses.push({
        label: name,
        code: [],
        reparse: { from: j + 1, why: REPARSE[name] },
        stdinProgram: name === "ssh" && operands <= 1,
      });
      continue;
    }
    if (name === "deno" && plainAt(words, j + 1) === "eval") {
      const code = words[j + 2];
      uses.push({ label: "deno eval", code: code ? [code] : [], stdinProgram: false });
      continue;
    }
    const spec = programSpec(name);
    if (!spec) continue;
    const code: Word[] = [];
    let label = name;
    let operands = 0;
    let fromFile = false;
    let stdin = false;
    for (let k = j + 1; k < words.length; k++) {
      const w = plain(words[k]);
      if (w === "-" && spec.stdinProgram) {
        stdin = true;
        break;
      }
      if (w === "--") {
        if (!spec.scanAll) {
          operands += words.length - k - 1;
          break;
        }
        continue;
      }
      const isFlag =
        (w.startsWith("-") || (spec === SHELL_SPEC && w.startsWith("+"))) && w.length > 1;
      if (isFlag) {
        const eq = w.indexOf("=");
        const flag = eq > 0 ? w.slice(0, eq) : w;
        if (spec.code.test(flag)) {
          label = `${name} ${flag}`;
          if (eq > 0) code.push(words[k]);
          else if (words[k + 1]) code.push(words[++k]);
          if (!spec.manyCode && !spec.scanAll) break;
          continue;
        }
        if (spec === SHELL_SPEC && flag === "-s") stdin = true;
        if (flag === "-m" && spec === PROGRAMS.python) {
          fromFile = true;
          break;
        }
        if (spec.file?.has(flag)) {
          fromFile = true;
          if (eq < 0) k++;
          continue;
        }
        if (spec.takesArg?.has(flag) && eq < 0) k++;
        // BSD sed's `-i ''`: the empty word is the backup suffix, not the script.
        if (spec === PROGRAMS.sed && flag === "-i" && plainAt(words, k + 1) === "") k++;
        continue;
      }
      // An operand.
      if (spec.operandIsCode && code.length === 0 && !fromFile && operands === 0) {
        label = `${name} '…'`;
        code.push(words[k]);
        operands++;
        if (!spec.manyCode) break;
        continue;
      }
      operands++;
      if (!spec.scanAll) break;
    }
    const stdinProgram =
      !!spec.stdinProgram && (stdin || (code.length === 0 && operands === 0 && !fromFile));
    uses.push({ label, code, stdinProgram });
  }
  return uses;
}

const RESERVED = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"]);
const ASSIGNMENT = /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/;

/** The command's name and arguments, past assignments, reserved words and `command` / `builtin`. */
function nameAndArgs(words: Word[]): { name: string; args: Word[] } | null {
  let j = 0;
  while (j < words.length) {
    const w = plain(words[j]);
    if (RESERVED.has(w) || w === "command" || w === "builtin" || ASSIGNMENT.test(w)) j++;
    else break;
  }
  if (j >= words.length) return null;
  return { name: plain(words[j]), args: words.slice(j + 1) };
}

const ARITH_MESSAGE =
  "bash evaluates it as arithmetic there, so a value like a[$(cmd)] runs cmd. " +
  "Check the value is a number first and use your own variable " +
  "(n={{X}}; [[ $n =~ ^[0-9]+$ ]] || exit 1), or compare it as text";

/** A placeholder bash takes as a variable name or evaluates as a number, in one command. */
function arithmeticUse(words: Word[]): CommandTemplateHazard | null {
  const first = nameAndArgs(words);
  if (!first) return null;
  const { name, args } = first;
  const hole = (w: Word | undefined) => w?.holes[0];
  const found = (h: Hole, where: string): CommandTemplateHazard => ({
    param: h.name,
    message: `{{${h.name}}} is ${where}: ${ARITH_MESSAGE.replace("{{X}}", `{{${h.name}}}`)}`,
  });

  if (name === "let") {
    const h = args.map(hole).find(Boolean);
    if (h) return found(h, "an argument of `let`");
  }
  if (["declare", "typeset", "local", "export", "readonly"].includes(name)) {
    let numeric = false;
    for (const w of args) {
      const p = plain(w);
      if (/^[-+][A-Za-z]+$/.test(p)) {
        if (/[in]/.test(p) && name !== "export") numeric = true;
        continue;
      }
      for (const h of w.holes) {
        // Only a value after `name=` is plain data, and only without -i / -n.
        if (numeric || !w.text.slice(0, h.at).includes("=")) {
          return found(h, `a variable name or a number in \`${name}\``);
        }
      }
    }
  }
  if (name === "read") {
    for (let k = 0; k < args.length; k++) {
      const p = plain(args[k]);
      if (["-p", "-d", "-t", "-n", "-N", "-u", "-i"].includes(p)) {
        k++;
        continue;
      }
      if (p.startsWith("-") && p !== "-a") continue;
      const h = hole(p === "-a" ? args[++k] : args[k]);
      if (h) return found(h, "a variable name in `read`");
    }
  }
  if (name === "printf" && plainAt(args, 0) === "-v") {
    const h = hole(args[1]);
    if (h) return found(h, "the variable name `printf -v` sets");
  }
  if (name === "test" || name === "[") {
    for (let k = 0; k < args.length - 1; k++) {
      const h = plain(args[k]) === "-v" ? hole(args[k + 1]) : undefined;
      if (h) return found(h, `the variable name \`${name} -v\` tests`);
    }
  }
  return null;
}

const TEST_NUMBER_OPS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);

/** `[[ … ]]`: number comparisons and `-v` evaluate their operands. */
function conditionalUse(tokens: Token[]): CommandTemplateHazard | null {
  let inside: Word[] | null = null;
  for (const t of tokens) {
    if (t.kind !== "word") continue;
    const p = t.holes.length === 0 ? t.text : "";
    if (p === "[[" && !inside) {
      inside = [];
      continue;
    }
    if (p === "]]" && inside) {
      for (let k = 0; k < inside.length; k++) {
        const w = plain(inside[k]);
        const operands = TEST_NUMBER_OPS.has(w)
          ? [inside[k - 1], inside[k + 1]]
          : w === "-v"
            ? [inside[k + 1]]
            : [];
        for (const operand of operands) {
          const h = operand?.holes[0];
          if (h) {
            return {
              param: h.name,
              message: `{{${h.name}}} is an operand of \`${w}\` in [[ ]]: ${ARITH_MESSAGE.replace("{{X}}", `{{${h.name}}}`)}`,
            };
          }
        }
      }
      inside = null;
      continue;
    }
    inside?.push(t);
  }
  return null;
}

function checkTokens(tokens: Token[]): CommandTemplateHazard | null {
  for (const t of tokens) {
    const h = t.kind === "word" ? t.holes.find((x) => x.arith) : undefined;
    if (h) {
      return {
        param: h.name,
        message:
          `{{${h.name}}} is inside $(( )), (( )), an array subscript or \${var:offset}: ` +
          ARITH_MESSAGE.replace("{{X}}", `{{${h.name}}}`),
      };
    }
    // A here-document's body is expanded like a double-quoted string: its
    // `$(( ))` and `$( … )` are what the template's own would be.
    if (t.kind === "op" && t.body) {
      const inBody = checkTokens(lex(t.body.text, true));
      if (inBody) return inBody;
    }
  }

  const conditional = conditionalUse(tokens);
  if (conditional) return conditional;

  for (const pipeline of pipelines(tokens)) {
    let fed: Hole | undefined; // a placeholder an earlier command of the pipeline may print
    for (const cmd of pipeline) {
      const numeric = arithmeticUse(cmd.words);
      if (numeric) return numeric;
      for (const use of programsIn(cmd.words)) {
        const inCode = use.code.flatMap((w) => w.holes)[0];
        if (inCode) {
          const p = `{{${inCode.name}}}`;
          return {
            param: inCode.name,
            message:
              `${p} is inside the program \`${use.label}\` runs, which parses the value again, as code. ` +
              `Hand it over as a separate argument instead (sh -c '… "$1" …' sh ${p}), ` +
              "or run the command without the second interpreter",
          };
        }
        const reparsed = use.reparse
          ? cmd.words.slice(use.reparse.from).flatMap((w) => w.holes)[0]
          : undefined;
        if (use.reparse && reparsed) {
          const p = `{{${reparsed.name}}}`;
          return {
            param: reparsed.name,
            message: `${p} is passed to ${use.reparse.why}, so the value would run as code. Run the command directly, with ${p} as its own argument`,
          };
        }
        const piped = use.stdinProgram ? (fed ?? cmd.stdin.flatMap((w) => w.holes)[0]) : undefined;
        if (piped) {
          return {
            param: piped.name,
            message: `{{${piped.name}}} reaches \`${use.label}\` on its standard input, which it runs as code. Pass the value as an argument instead`,
          };
        }
      }
      fed ??= [...cmd.words, ...cmd.stdin].flatMap((w) => w.holes)[0];
    }
  }
  return null;
}

/**
 * The first `{{param}}` the template puts where a second parser would read
 * its value as code (see the top of this file), or null for a template that
 * only hands values to the shell running it.
 */
export function commandTemplateHazard(template: string): CommandTemplateHazard | null {
  if (!template.includes("{{")) return null;
  for (const variant of variants(template)) {
    const found = checkTokens(lex(variant));
    if (found) return found;
  }
  return null;
}

/** The 400 a save answers with for an unsafe command template, or null. */
export function commandTemplateRefusal(template: string | null | undefined): string | null {
  const found = template ? commandTemplateHazard(template) : null;
  return found ? `Unsafe command template: ${found.message}` : null;
}
