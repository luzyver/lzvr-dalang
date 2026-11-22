import { readFileSync } from 'node:fs';

export const gitWriting = {
  commit: readFileSync(new URL('../prompts/commit.md', import.meta.url), 'utf8').trim(),
  mr: readFileSync(new URL('../prompts/mr.md', import.meta.url), 'utf8').trim(),
};
