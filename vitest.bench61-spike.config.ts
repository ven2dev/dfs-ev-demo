import {defineConfig} from "vitest/config";
import nodeConfig from "./vitest.node.config";
export default defineConfig({...nodeConfig,test:{...nodeConfig.test,fileParallelism:false,
  include:["tests/bench61-hold-spike.test.ts"]}});
