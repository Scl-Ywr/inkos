const bookQueues = new Map<string, Promise<void>>();
const queuedOperationKeys = new Set<string>();

export function enqueueBookScopedBackgroundResync(
  bookId: string,
  operationKey: string,
  run: () => Promise<void>,
): boolean {
  if (queuedOperationKeys.has(operationKey)) {
    return false;
  }

  queuedOperationKeys.add(operationKey);
  const previous = bookQueues.get(bookId) ?? Promise.resolve();
  let next: Promise<void>;
  next = previous
    .catch(() => undefined)
    .then(run)
    .catch(() => undefined)
    .finally(() => {
      queuedOperationKeys.delete(operationKey);
      if (bookQueues.get(bookId) === next) {
        bookQueues.delete(bookId);
      }
    });
  bookQueues.set(bookId, next);
  return true;
}
