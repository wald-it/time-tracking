// Renderer lifetime only: answering records the id; opening/hiding never does.
// A reload creates a fresh set. Do not clear it on stop, edit or entry change.
export const askedLongRunEntries = new Set<number>()
