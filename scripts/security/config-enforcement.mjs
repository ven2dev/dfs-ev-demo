import assert from "node:assert/strict";
import { Linter } from "eslint";
import { environmentReaders, environmentRuleIds } from "../../eslint.environment.mjs";

export const guardedEnvironmentSource = file => file.startsWith("apps/web/src/") &&
  /\.[cm]?[jt]sx?$/.test(file) && !/\.(?:test|spec)\./.test(file) && !environmentReaders.includes(file);

// Use ESLint's configured parser to distinguish actual comments from strings,
// JSX text and regular expressions. This checks directives, not input discovery.
export async function checkEnvironmentDisables(files, eslint) {
  let checkedFiles = 0;
  for (const [file, source] of files) {
    if (!guardedEnvironmentSource(file)) continue;
    const config = await eslint.calculateConfigForFile(file);
    assert(config, `environment directive source is ignored: ${file}`);
    const linter = new Linter();
    const messages = linter.verify(source, [{
      files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
      languageOptions: config.languageOptions, plugins: config.plugins,
    }], { filename: file });
    assert(!messages.some(message => message.fatal), `environment directive source cannot be parsed: ${file}`);
    for (const comment of linter.getSourceCode().getAllComments()) {
      const text = comment.value.replace(/^\s*\*\s?/gm, "").trim();
      const disable = /^eslint-disable(?:-next-line|-line)?\b([\s\S]*)$/.exec(text);
      const names = disable?.[1].split(/\s--(?:\s|$)/, 1)[0].trim().split(/[\s,]+/) ?? [];
      for (const rule of environmentRuleIds) {
        // A named rule set to off in an eslint configuration comment disables
        // the same protection as a named eslint-disable directive.
        const off = new RegExp(`(?:^|[,\\s])["']?${rule}["']?\\s*:\\s*(?:\\[\\s*)?(?:["']off["']|0)(?:\\s|,|\\]|$)`);
        const configurationOff = /^eslint\s+/.test(text) && off.test(text.slice("eslint".length));
        assert(!names.includes(rule) && !configurationOff,
          `environment rule disable refused: ${file}:${comment.loc.start.line} (${rule})`);
      }
    }
    checkedFiles++;
  }
  return { checkedFiles };
}
