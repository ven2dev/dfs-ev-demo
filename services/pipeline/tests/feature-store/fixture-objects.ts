// These fixture objects have distinct keys. Drain each batch before setup
// returns or throws so test teardown cannot race an in-flight write.
export const mapFixtureObjects = async <Input, Output>(
  items: readonly Input[],
  write: (item: Input) => Promise<Output>,
): Promise<Output[]> => {
  const batchSize = 8;
  const values: Output[] = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const settled = await Promise.allSettled(items.slice(offset, offset + batchSize).map(write));
    for (const entry of settled) {
      if (entry.status === "rejected") throw entry.reason;
      values.push(entry.value);
    }
  }
  return values;
};
