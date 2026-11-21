// Pure helpers of ui/ErrorBoundary.tsx (no React), so they can be unit tested.

/** A failed region clears its error when its reset key changes (another repo, another center view). */
export function shouldReset(hasError: boolean, prevKey: unknown, nextKey: unknown): boolean {
  return hasError && !Object.is(prevKey, nextKey)
}

/** The text "Copy details" puts on the clipboard: where it failed, the error and both stacks. */
export function errorDetails(region: string, error: Error, componentStack: string | null | undefined, meta: { platform?: string; userAgent?: string } = {}): string {
  const lines: (string | null)[] = [
    `Karen: ${region} failed to render`,
    meta.platform ? `Platform: ${meta.platform}` : null,
    meta.userAgent ? `User agent: ${meta.userAgent}` : null,
    '',
    `${error.name}: ${error.message}`,
    error.stack ? `\nStack:\n${error.stack}` : null,
    componentStack ? `\nComponent stack:${componentStack}` : null
  ]
  return lines.filter((line) => line !== null).join('\n')
}

/** Whatever was thrown, as an Error (React passes thrown non-errors through as they are). */
export function asError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown
  if (typeof thrown === 'string') return new Error(thrown)
  let text: string | undefined
  try {
    text = JSON.stringify(thrown)
  } catch {
    // cyclic objects
  }
  return new Error(text ?? String(thrown))
}
