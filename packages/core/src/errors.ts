/**
 * Error convention for `@kumi/core`.
 *
 * Every failure the command layer raises is a `KumiError` carrying a stable
 * machine-readable `code`. IPC/CLI layers can map the code to an exit code or a
 * UI message without parsing prose.
 */

export type KumiErrorCode =
  | "not_found"
  | "invalid"
  | "cycle"
  | "locked"
  | "conflict";

export class KumiError extends Error {
  readonly code: KumiErrorCode;

  constructor(code: KumiErrorCode, message: string) {
    super(message);
    this.name = "KumiError";
    this.code = code;
    // Restore the prototype chain when compiled to ES5-style output.
    Object.setPrototypeOf(this, KumiError.prototype);
  }
}

export function notFound(what: string, id: string): KumiError {
  return new KumiError("not_found", `${what} not found: ${id}`);
}

export function invalid(message: string): KumiError {
  return new KumiError("invalid", message);
}
