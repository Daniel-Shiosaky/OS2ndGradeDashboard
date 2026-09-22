import { pathToFileURL } from "node:url";

/** True when this module was invoked directly (`tsx thisFile.ts`) rather than imported. */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}
