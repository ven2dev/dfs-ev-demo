// One pg session executes one statement at a time, even when independent
// verification branches run concurrently. A failure remains visible to its
// caller while later cleanup (notably ROLLBACK) can still drain the queue.
export const createQueryQueue = () => {
  let tail: Promise<void> = Promise.resolve();
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(() => {}, () => {});
    return result;
  };
  return { run };
};
