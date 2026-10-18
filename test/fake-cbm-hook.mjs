// Fake `codebase-memory-mcp hook-augment`: answers with the folder the event names. FAKE_CBM_FAIL=1 fails instead.
if (process.argv[2] !== 'hook-augment') process.exit(2);
let input = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) input += c;
if (process.env.FAKE_CBM_FAIL) { process.stdout.write('half'); process.exit(1); }
const e = JSON.parse(input);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: e.hook_event_name, additionalContext: `cwd=${e.cwd} tool=${e.tool_name}` } }));
