/**
 * Produces a stable diagnostic for logs without relying on an error object's
 * often-empty JSON representation.
 */
export default function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    const serialized = JSON.stringify(error)
    return serialized === undefined ? String(error) : serialized
  } catch {
    return String(error)
  }
}
