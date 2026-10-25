import {defineConfig} from "vitest/config";
import nodeConfig from "./vitest.node.config";
export default defineConfig({...nodeConfig,test:{...nodeConfig.test,fileParallelism:false,
  include:["tests/bench61-candidate.test.ts","tests/bench61-probe-postgres.test.ts"]}});
