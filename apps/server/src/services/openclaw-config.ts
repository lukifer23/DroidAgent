import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export function stringifyConfigValue(value: unknown): string {
  return JSON.stringify(value);
}

export function hashConfigFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function getConfigPathValue(
  source: Record<string, unknown> | null,
  dottedPath: string,
): unknown {
  if (!source) {
    return undefined;
  }

  let current: unknown = source;
  for (const segment of dottedPath.split(".")) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !(segment in current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function setConfigPathValue(
  target: Record<string, unknown>,
  dottedPath: string,
  value: unknown,
): void {
  const segments = dottedPath.split(".");
  let current: Record<string, unknown> = target;

  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  current[segments.at(-1) ?? dottedPath] = value;
}

export function configValueEquals(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
