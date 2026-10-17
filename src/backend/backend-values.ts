/** Narrow untrusted JSON and thrown values before inspecting their fields. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function errorMessage(error: unknown): string {
  return isObject(error) && typeof error.message === 'string' ? error.message : String(error)
}
export function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === 'string' ? error.code : undefined
}
export function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!isObject(value)) throw new Error('Expected JSON object')
  return value
}
