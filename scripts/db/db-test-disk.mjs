const MiB = 1024 ** 2;
const tiers = {
  standard: { capacityMiB: 512, requiredMiB: 272 },
  large: { capacityMiB: 2048, requiredMiB: 608 },
};

const parseMount = (row) => {
  const columns = row?.trim().split(/\s+/) ?? [];
  const capacityBytes = Number(columns[1]) * 1024;
  const freeBytes = Number(columns[3]) * 1024;
  if (columns.length !== 6 || columns[0] !== "tmpfs" || columns[5] !== "/var/lib/postgresql" ||
      !Number.isSafeInteger(capacityBytes) || capacityBytes <= 0 ||
      !Number.isSafeInteger(freeBytes) || freeBytes < 0 || freeBytes > capacityBytes) {
    throw new Error("Unable to verify the disposable PostgreSQL data and WAL tmpfs.");
  }
  return { capacityBytes, freeBytes };
};

export const requireDatabaseDiskBudget = (output, { project, tier }) => {
  const [dataRow, walRow, walUsage] = output.trim().split("\n");
  const data = parseMount(dataRow);
  const wal = parseMount(walRow);
  const walKiB = walUsage?.trim().split(/\s+/)[0];
  const retainedWalBytes = Number(walKiB) * 1024;
  const { capacityMiB, requiredMiB } = tiers[tier];
  if (data.capacityBytes !== capacityMiB * MiB || wal.capacityBytes !== data.capacityBytes ||
      !/^\d+$/.test(walKiB ?? "") || !Number.isSafeInteger(retainedWalBytes) || retainedWalBytes > data.capacityBytes) {
    throw new Error(`Unable to verify the ${capacityMiB} MiB PostgreSQL tmpfs and retained WAL for ${project}.`);
  }
  const requiredFreeBytes = requiredMiB * MiB;
  const availableMiB = (data.freeBytes / MiB).toFixed(1);
  const walMiB = (retainedWalBytes / MiB).toFixed(1);
  if (data.freeBytes < requiredFreeBytes) {
    const next = tier === "standard" ? "Free space on this fixture or use the 2 GiB tier on a non-default lane." : "Free space or recreate this disposable lane before retrying.";
    throw new Error(`Insufficient PostgreSQL fixture space on ${project} (${tier}): requires ${requiredMiB} MiB free, available ${availableMiB} MiB, retained WAL ${walMiB} MiB. ${next} Exclusive lane ownership is required because free space can change after preflight.`);
  }
  return { project, tier, capacityBytes: data.capacityBytes, requiredFreeBytes, availableBytes: data.freeBytes, retainedWalBytes };
};
