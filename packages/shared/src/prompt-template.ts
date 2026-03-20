export const DEFAULT_PROMPT_TEMPLATE = `You are an autonomous coding agent working on this repository.

## Your Task

Read your task file at: {{TASK_FILE}}

## Workflow

1. Read and understand the task file completely.
2. Implement the changes described in the task.
3. Write tests if the repository has a test suite.
4. Commit your work to the current branch ({{BRANCH_NAME}}).
5. Push and open a pull request using the \`gh\` CLI:
   \`\`\`
   gh pr create --title "{{TASK_TITLE}}" --body "Implements task {{TASK_ID}}"
   \`\`\`
6. Monitor the GitHub Actions CI checks on your PR:
   - Run \`gh pr checks\` to see the status.
   - If any checks fail, read the logs with \`gh run view\`, fix the issues, push, and wait again.
   - Repeat until all checks pass.
{{#if AUTO_MERGE}}
7. Once all checks pass and there are no merge conflicts, merge the PR:
   \`\`\`
   gh pr merge --squash --delete-branch
   \`\`\`
{{else}}
7. Once all checks pass, comment on the PR that it is ready for review.
{{/if}}

## Guidelines

- Work only on what the task file describes. Do not refactor unrelated code.
- Follow the existing code style and conventions in this repository.
- If you get stuck or need information you don't have, stop and explain what you need.
- Do not modify CI/CD configuration unless the task specifically requires it.
`;

export const TASK_FILE_PATH = ".optio/task.md";

export const DEFAULT_REVIEW_PROMPT_TEMPLATE = `You are a code reviewer reviewing a pull request on this repository.

## Your Task

1. Read the PR diff:
   \`\`\`
   gh pr diff {{PR_NUMBER}}
   \`\`\`

2. Read the original task description to understand what the PR is supposed to do:
   \`\`\`
   cat {{TASK_FILE}}
   \`\`\`

{{#if TEST_COMMAND}}
3. Run the test suite to verify the changes work:
   \`\`\`
   {{TEST_COMMAND}}
   \`\`\`
{{/if}}

4. Review the code for:
   - Correctness: Does it do what the task asked?
   - Tests: Are there tests for the new behavior?
   - Bugs: Any logic errors, edge cases, or regressions?
   - Security: Any vulnerabilities introduced?
   - Style: Does it follow the repo's conventions?

5. Submit your review using the GitHub CLI:
   - If the code is good: \`gh pr review {{PR_NUMBER}} --approve --body "Your review summary"\`
   - If changes are needed: \`gh pr review {{PR_NUMBER}} --request-changes --body "What needs fixing"\`

## Guidelines

- Only request changes for real issues, not style nitpicks.
- Be specific about what needs fixing and why.
- If the tests pass and the code correctly implements the task, approve it.
`;

export const REVIEW_TASK_FILE_PATH = ".optio/review-context.md";

/**
 * Render a prompt template by replacing {{VARIABLE}} placeholders.
 */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  let result = template;

  // Handle {{#if VAR}}...{{else}}...{{/if}} blocks
  result = result.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_match, varName: string, ifBlock: string, elseBlock: string | undefined) => {
      const value = vars[varName];
      const truthy = value && value !== "false" && value !== "0";
      return truthy ? ifBlock : (elseBlock ?? "");
    },
  );

  // Handle simple {{VAR}} replacements
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
    return vars[varName] ?? "";
  });

  return result.trim();
}

/**
 * Generate the task file content that gets written into the worktree.
 */
export function renderTaskFile(vars: {
  taskTitle: string;
  taskBody: string;
  taskId: string;
  ticketSource?: string;
  ticketUrl?: string;
}): string {
  const parts = [
    `# ${vars.taskTitle}`,
    "",
    vars.taskBody,
    "",
    "---",
    `*Optio Task ID: ${vars.taskId}*`,
  ];
  if (vars.ticketSource && vars.ticketUrl) {
    parts.push(`*Source: [${vars.ticketSource}](${vars.ticketUrl})*`);
  }
  return parts.join("\n");
}
