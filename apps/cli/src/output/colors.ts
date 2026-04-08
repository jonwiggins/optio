let _enabled: boolean | null = null;

export function setColorEnabled(enabled: boolean): void {
  _enabled = enabled;
}

function isColorEnabled(): boolean {
  if (_enabled !== null) return _enabled;
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

function wrap(code: string, resetCode: string) {
  return (text: string) => (isColorEnabled() ? `\x1b[${code}m${text}\x1b[${resetCode}m` : text);
}

export const bold = wrap("1", "22");
export const dim = wrap("2", "22");
export const red = wrap("31", "39");
export const green = wrap("32", "39");
export const yellow = wrap("33", "39");
export const blue = wrap("34", "39");
export const cyan = wrap("36", "39");
export const gray = wrap("90", "39");
