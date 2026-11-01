import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const scripts = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
for (const [name, environment, expected] of [['start:http', 'stdio', 'running on http://'], ['start:stdio', 'streamable-http', 'running on stdio']]) {
  test(`${name} selects its transport over the opposite environment setting`, async t => {
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const [command, ...args] = scripts[name].split(' '); assert.equal(command, 'node');
    const child = spawn(process.execPath, args, { cwd: root, env: { PATH: process.env.PATH || '', MCP_TRANSPORT: environment,
      MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: String(port), BAMBU_MODEL: '', TEMP_DIR: '' }, stdio: ['pipe', 'ignore', 'pipe'] });
    const closed = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`wrong transport: ${output}`)), 10_000);
      child.stderr.on('data', chunk => { output += chunk; if (output.includes(expected)) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`server exited: ${output}`)); });
    });
  });
}
