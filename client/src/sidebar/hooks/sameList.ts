/** Two path lists, element by element: the idempotence check before every write-back (⚡ YAZ-874). */
export const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])
