import nodePath, { type PlatformPath } from "node:path";

/**
 * True when `candidate` is `root` itself or sits under it, comparing on the
 * platform's separator boundary so `/a/bc` never matches root `/a/b`.
 *
 * This lives in its own leaf module on purpose: `node --test` imports the
 * TypeScript source directly (type stripping), and project-instructions pulls
 * `./agent-dir.js`, which only exists after compilation. Keeping the helper
 * import-free lets the containment tests run against the real source.
 */
export function isWithinRoot(
  root: string,
  candidate: string,
  paths: Pick<PlatformPath, "sep"> = nodePath,
): boolean {
  const boundary = root.endsWith(paths.sep) ? root : `${root}${paths.sep}`;
  return candidate === root || candidate.startsWith(boundary);
}
