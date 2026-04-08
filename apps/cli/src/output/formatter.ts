import { red, yellow } from "./colors.js";

let _jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  _jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return _jsonMode;
}

export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function outputError(error: { error: string; tip?: string }): void {
  if (_jsonMode) {
    process.stderr.write(JSON.stringify(error) + "\n");
  } else {
    process.stderr.write(red(`Error: ${error.error}`) + "\n");
    if (error.tip) {
      process.stderr.write(yellow(`Tip: ${error.tip}`) + "\n");
    }
  }
}
