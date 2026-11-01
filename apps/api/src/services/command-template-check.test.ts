import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commandTemplateHazard, commandTemplateRefusal } from "./command-template-check.js";
import { renderCommandTemplate } from "./prompt-template-service.js";

const SAFE = [
  // Bare, double-quoted, single-quoted: renderCommandTemplate's own guarantee.
  "./triage.sh {{title}}",
  'echo "New issue: {{title}}"',
  "echo 'Issue: {{title}}'",
  "gh issue comment {{number}} --body {{body}} && echo done",
  // A shell's code word without the placeholder; the value as a positional argument.
  `sh -c 'echo "$1"' sh {{title}}`,
  `bash -lc 'notify "$@"' _ {{title}} {{url}}`,
  `kubectl exec deploy/api -- sh -c 'echo "$1"' sh {{title}}`,
  // A script file is not inline code; nor is a module.
  "bash ./scripts/handle.sh {{title}}",
  "python3 scripts/triage.py --title {{title}}",
  "python3 -m triage {{title}}",
  "node scripts/x.js {{title}}",
  "awk -v t={{title}} '{ print t }' file",
  "sed -f fix.sed {{file}}",
  // Plain data in a pipeline, a here-doc or a here-string that no interpreter reads.
  "echo {{title}} | tee -a log.txt",
  "cat <<EOF > note.md\n# {{title}}\nEOF",
  "grep -c x <<< {{title}}",
  // A quoted here-doc to a shell is literal: the value never gets in.
  "sh <<'EOF'\necho {{title}}\nEOF",
  // Text comparisons, and the test builtin's -eq (no arithmetic).
  "[[ {{label}} == bug ]] && echo yes",
  '[[ "{{label}}" =~ ^v[0-9]+$ ]] && echo ok',
  '[ "{{n}}" -eq 1 ] && echo one',
  // Assigning the value to a variable is data; the variable is the template's own.
  "n={{n}}; [[ $n =~ ^[0-9]+$ ]] || exit 1; echo $(( n + 1 ))",
  "export TITLE={{title}}; local x={{y}}",
  'echo "${TITLE:-{{title}}}"',
  // An identifier followed by brackets in a double-quoted string is just text.
  'echo "list[{{n}}]"',
  // A placeholder in a comment never runs.
  "echo hi # sh -c '{{title}}'",
  "echo no placeholders at all | sh",
];

const UNSAFE: Array<[string, string]> = [
  // Nested shells.
  ['sh -c "echo {{title}}"', "sh -c"],
  ["bash -c 'echo {{title}}'", "bash -c"],
  ['bash -lc "deploy {{ref}}"', "bash -lc"],
  ['zsh -o pipefail -c "x {{a}}"', "zsh -c"],
  ['sudo -u deploy sh -c "run {{title}}"', "sh -c"],
  ['kubectl exec deploy/api -- sh -c "echo {{title}}"', "sh -c"],
  ['docker exec web bash -c "echo {{title}}"', "bash -c"],
  ['su - deploy -c "echo {{title}}"', "su -c"],
  ["find . -name x -exec sh -c 'rm {{file}}' \\;", "sh -c"],
  ['out=$(sh -c "echo {{title}}")', "sh -c"],
  ['echo "$(bash -c "echo {{title}}")"', "bash -c"],
  // Commands that parse their arguments again.
  ["eval {{cmd}}", "eval"],
  ['eval "echo {{title}}"', "eval"],
  ['ssh host "echo {{title}}"', "ssh"],
  ["ssh {{host}} uptime", "ssh"],
  ["trap 'echo {{title}}' EXIT", "trap"],
  ["watch echo {{title}}", "watch"],
  // Inline programs of other interpreters.
  ["python3 -c \"print('{{title}}')\"", "python3 -c"],
  ["node -e 'console.log(\"{{title}}\")'", "node -e"],
  ["perl -ne 'print if /{{pat}}/' file", "perl -ne"],
  ["ruby -e 'puts \"{{title}}\"'", "ruby -e"],
  ["awk '{ print \"{{title}}\" }' file", "awk"],
  ['sed "s/x/{{title}}/" file', "sed"],
  ['sed -e "s/a/b/" -e "s/x/{{title}}/" file', "sed -e"],
  ["sed -i '' 's/x/{{title}}/' file", "sed"],
  // Interpreters reading their program from stdin.
  ["echo {{title}} | sh", "sh"],
  ['printf "%s" "{{title}}" | bash -s', "bash"],
  ["bash <<< {{title}}", "bash"],
  ["sh <<EOF\necho {{title}}\nEOF", "sh"],
  ["python3 - <<EOF\nprint('{{title}}')\nEOF", "python3"],
  ["cat <<EOF | sh\necho {{title}}\nEOF", "sh"],
  // Bash arithmetic.
  ["echo $(( {{n}} + 1 ))", "$(( ))"],
  ['echo "total: $(( {{n}} * 2 ))"', "$(( ))"],
  ["(( {{n}} > 3 )) && echo big", "(( ))"],
  ["for (( i = 0; i < {{n}}; i++ )); do echo $i; done", "(( ))"],
  ["echo $[ {{n}} + 1 ]", "$[ ]"],
  ["[[ {{n}} -eq 1 ]] && echo one", "-eq"],
  ['[[ "{{n}}" -lt 10 ]] && echo small', "-lt"],
  ["[[ $x == a && {{n}} -gt 2 ]]", "-gt"],
  ["[[ -v {{name}} ]]", "-v"],
  ["test -v {{name}}", "test -v"],
  ["let x={{n}}+1", "let"],
  ["declare -i n={{n}}", "declare"],
  ["local -n ref={{name}}", "local"],
  ["declare {{name}}=1", "declare"],
  ["read -r {{name}} <<< 1", "read"],
  ["printf -v {{name}} %s 1", "printf -v"],
  ['arr=(a b c); echo "${arr[{{i}}]}"', "subscript"],
  ["arr[{{i}}]=x", "subscript"],
  ['echo "${title:{{n}}}"', "offset"],
  ['echo "${title:0:{{n}}}"', "offset"],
  // Every arm of an {{#if}} is checked.
  ['{{#if a}}echo ok{{else}}sh -c "echo {{a}}"{{/if}}', "sh -c"],
  ["{{#if n}}(( {{n}} )){{/if}}", "(( ))"],
  // A here-doc's body expands $(( )) and $( ) like a double-quoted string.
  ["cat <<EOF\ntotal $(( {{n}} + 1 ))\nEOF", "$(( ))"],
  ['cat <<EOF\n$(sh -c "echo {{title}}")\nEOF', "sh -c"],
];

describe("commandTemplateHazard", () => {
  it.each(SAFE)("passes %j", (template) => {
    expect(commandTemplateHazard(template)).toBeNull();
  });

  it.each(UNSAFE)("refuses %j (%s)", (template) => {
    const found = commandTemplateHazard(template);
    expect(found).not.toBeNull();
    expect(found!.message).toContain(`{{${found!.param}}}`);
  });

  it("names the param and the construct", () => {
    expect(commandTemplateHazard('sh -c "echo {{title}}"')).toMatchObject({
      param: "title",
      message: expect.stringContaining("`sh -c`"),
    });
    expect(commandTemplateHazard("[[ {{count}} -eq 1 ]]")).toMatchObject({
      param: "count",
      message: expect.stringContaining("`-eq`"),
    });
    expect(commandTemplateRefusal("eval {{x}}")).toMatch(/^Unsafe command template: \{\{x\}\}/);
    expect(commandTemplateRefusal("echo {{x}}")).toBeNull();
    expect(commandTemplateRefusal("")).toBeNull();
    expect(commandTemplateRefusal(null)).toBeNull();
  });
});

/**
 * The premise, in bash: what the check refuses really runs a payload once
 * rendered, and what it passes doesn't. Constructs every bash has (macOS's
 * 3.2 included).
 */
describe("renderCommandTemplate in bash", () => {
  const dir = mkdtempSync(join(tmpdir(), "optio-cmd-check-"));
  const marker = join(dir, "ran");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Whether running the rendered template ran the payload's `touch`. */
  const runs = (template: string, value: string) => {
    rmSync(marker, { force: true });
    try {
      execFileSync("bash", ["-c", renderCommandTemplate(template, { x: value })], {
        cwd: dir,
        stdio: "ignore",
      });
    } catch {
      // A failing command is fine: the question is whether the payload ran.
    }
    return existsSync(marker);
  };
  const shellPayload = `$(touch ${marker})`;
  const arithPayload = `a[$(touch ${marker})]`;

  it.each([
    ['sh -c "echo {{x}}"', shellPayload],
    ["bash -c 'echo {{x}}'", shellPayload],
    ["eval echo {{x}}", shellPayload],
    ["echo {{x}} | sh", shellPayload],
    // (bash 5 also runs it bare, `$(( {{x}} + 1 ))`; 3.2 rejects the quotes first.)
    ['echo "$(( {{x}} + 1 ))"', arithPayload],
    ["(( {{x}} > 1 ))", arithPayload],
    ["[[ {{x}} -eq 1 ]]", arithPayload],
    ["let y={{x}}", arithPayload],
  ])("%j runs the payload, and the check refuses it", (template, payload) => {
    expect(runs(template, payload)).toBe(true);
    expect(commandTemplateHazard(template)).not.toBeNull();
  });

  it.each([
    ["echo {{x}}", shellPayload],
    ['echo "New: {{x}}"', shellPayload],
    ["echo 'New: {{x}}'", shellPayload],
    [`sh -c 'echo "$1"' sh {{x}}`, shellPayload],
    ["[[ {{x}} == 1 ]]", arithPayload],
    ['[ "{{x}}" -eq 1 ]', arithPayload],
  ])("%j doesn't, and the check passes it", (template, payload) => {
    expect(runs(template, payload)).toBe(false);
    expect(commandTemplateHazard(template)).toBeNull();
  });
});
