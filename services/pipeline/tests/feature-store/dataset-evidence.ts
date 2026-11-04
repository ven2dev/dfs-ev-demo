import { writeFile } from "node:fs/promises";

export const withDatasetEvidence = async (
  path: string | undefined,
  run: () => Promise<void>,
  successfulReceipt: () => string | undefined,
): Promise<void> => {
  await run();
  const receipt = successfulReceipt();
  if (path && receipt !== undefined) await writeFile(path, receipt, { flag: "wx" });
};
