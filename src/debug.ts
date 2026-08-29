let debugEnabled = false;

export function enableDebug(): void {
  debugEnabled = true;
}

export function debugEnabledFlag(): boolean {
  return debugEnabled;
}

export function debugLog(...args: unknown[]): void {
  if (debugEnabled) {
    console.log("[debug]", ...args);
  }
}