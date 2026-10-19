import type { NextConfig } from "next";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  turbopack: { root: repositoryRoot },
  outputFileTracingRoot: repositoryRoot,
};

export default nextConfig;
