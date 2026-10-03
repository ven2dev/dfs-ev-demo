import { timingSafeEqual } from "node:crypto";

export const isAuthorizedCronHeader = (
  authorization: string | null,
  secret: string | undefined
): boolean => {
  if (!secret || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
