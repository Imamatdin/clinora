// Task 027: Railway start command (distroless image, exec form):
//   /nodejs/bin/node dist/server/server/railway-start.js
// Fails fast with every missing or wrong variable named. Then it replaces itself (execve, same PID) with main.js
// running on the DML-only clinora_app connection and an environment without the owner credential or the demo
// password, so neither app code nor /proc/<pid>/environ can read them. Railway gives every process of a service the
// same variables; this is the closest a single service gets to the separate identities used on Google Cloud.
import { fileURLToPath } from 'node:url';
import { checkStartEnv, STRIP_BEFORE_START } from './railway.js';

const problems = checkStartEnv(process.env);
if (problems.length) {
  process.stdout.write(JSON.stringify({ severity: 'ERROR', message: 'Railway start: fix these variables', problems }) + '\n');
  process.exit(1);
}
const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !(STRIP_BEFORE_START as readonly string[]).includes(name)) env[name] = value;
env.DATABASE_URL = process.env.APP_DATABASE_URL!;
// process.execve: Node >= 22.15 (the image pins 22.17.1). Without it, refuse rather than run with the owner credential.
const execve = (process as unknown as { execve?: (file: string, args: string[], env: Record<string, string>) => never }).execve;
if (typeof execve !== 'function') {
  process.stdout.write(JSON.stringify({ severity: 'ERROR', message: 'Railway start: Node.js without process.execve; use the pinned image' }) + '\n');
  process.exit(1);
}
execve(process.execPath, [process.execPath, fileURLToPath(new URL('./main.js', import.meta.url))], env);
