import { tmpdir } from 'node:os';

// Tests may run inside a Dalang chat turn, whose environment blocks the agent's own git commits and pushes (GIT_CONFIG_*,
// see src/agent-git.ts). The tests' git is not the agent's: start every test file without that config.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_CONFIG_')) delete process.env[k];
// Nor is its author: one left empty on purpose there makes the tests' own commits fail with "empty ident name".
for (const k of Object.keys(process.env)) if (/^GIT_(AUTHOR|COMMITTER)_/.test(k) && !process.env[k]) delete process.env[k];

// There the temp folder sits inside Dalang's own repo (STATE_DIR/tmp), and a test folder that is "not a git repo" would
// be found to be part of it: git stops looking for a repo at the temp folder.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

// And gh / glab are pointed at that chat's own config folders: the fake ones would keep their logins there, across runs.
delete process.env.GH_CONFIG_DIR;
delete process.env.GLAB_CONFIG_DIR;
