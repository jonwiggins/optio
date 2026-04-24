/**
 * Builds a bash script that writes files from a setupFiles array.
 * Uses Python3 for safe JSON parsing and file operations.
 *
 * @param setupFiles Array of files to write
 * @param message Optional message to echo before writing files
 * @returns Bash script string, or empty string if no files
 */
export function buildSetupFilesScript(
  setupFiles: Array<{
    path: string;
    content: string;
    executable?: boolean;
    sensitive?: boolean;
  }>,
  message = "[optio] Writing setup files...",
): string {
  if (!setupFiles || setupFiles.length === 0) {
    return "";
  }

  const filesJson = Buffer.from(JSON.stringify(setupFiles)).toString("base64");

  return [
    `echo "${message}"`,
    `echo '${filesJson}' | base64 -d | python3 -c "`,
    `import json, sys, os`,
    `files = json.load(sys.stdin)`,
    `for f in files:`,
    `    p = f['path']`,
    `    os.makedirs(os.path.dirname(p), exist_ok=True)`,
    `    with open(p, 'w') as fh:`,
    `        fh.write(f['content'])`,
    `    if f.get('executable'):`,
    `        os.chmod(p, 0o755)`,
    `    elif f.get('sensitive'):`,
    `        os.chmod(p, 0o600)`,
    `    print(f'  wrote {p}')`,
    `"`,
  ].join("\n");
}
