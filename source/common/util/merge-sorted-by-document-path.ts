/**
 * Merge two path-sorted result sets. Incoming values replace existing values
 * with the same documentPath, which is what streamed search refreshes need.
 */
export function mergeSortedByDocumentPath<T extends { documentPath: string }> (
  existing: readonly T[],
  incoming: readonly T[]
): T[] {
  if (incoming.length === 0) {
    return [...existing]
  }

  const sortedIncoming = [...incoming].sort((a, b) => a.documentPath.localeCompare(b.documentPath))
  const merged: T[] = []
  let oldIndex = 0
  let newIndex = 0

  while (oldIndex < existing.length || newIndex < sortedIncoming.length) {
    const oldValue = existing[oldIndex]
    const newValue = sortedIncoming[newIndex]
    if (oldValue === undefined) {
      merged.push(...sortedIncoming.slice(newIndex))
      break
    }
    if (newValue === undefined) {
      merged.push(...existing.slice(oldIndex))
      break
    }

    const order = oldValue.documentPath.localeCompare(newValue.documentPath)
    if (order < 0) {
      merged.push(oldValue)
      oldIndex++
    } else if (order > 0) {
      merged.push(newValue)
      newIndex++
    } else {
      merged.push(newValue)
      oldIndex++
      newIndex++
    }
  }

  return merged
}
