// Tests may run inside a Dalang chat turn, whose environment blocks the agent's own git commits and pushes (GIT_CONFIG_*,
// see src/agent-git.ts). The tests' git is not the agent's: start every test file without that config.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_CONFIG_')) delete process.env[k];
