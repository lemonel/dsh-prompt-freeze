export const SOURCE_KIND = 'prompt-freeze'
export const LEGACY_SOURCE_KIND = 'tool-declaration-snapshot'
const LEGACY_CACHE_SOURCE_KIND = 'cache-guard'
// Keep the existing on-disk directory so renaming never disconnects saved snapshots.
export const STORAGE_DIRECTORY = 'cache-guard'
export const isSourceKind = (kind: unknown): boolean => kind === SOURCE_KIND || kind === LEGACY_SOURCE_KIND || kind === LEGACY_CACHE_SOURCE_KIND
