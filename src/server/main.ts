import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
const webDirectory = fileURLToPath(new URL('../../web/', import.meta.url));
const compiled = import.meta.url.endsWith('.js');
const server = await createApp(compiled ? webDirectory : undefined);
server.listen(port, '127.0.0.1', () => console.log(`Clinora foundation: http://127.0.0.1:${port}`));
// No request bodies, query strings, cookies, patient identifiers, or provider secrets are logged.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());
