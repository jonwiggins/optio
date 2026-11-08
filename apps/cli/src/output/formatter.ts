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
