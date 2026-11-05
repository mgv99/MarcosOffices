#!/usr/bin/env node
/**
 * marcosoffices — open the office.
 */
import { spawn } from 'node:child_process';
import { createServer, shutdown } from './server/server.js';
import { DATA_DIR } from './server/store.js';

function parseArgs(argv) {
  const args = { port: 4321, host: '127.0.0.1', open: true };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') args.port = Number(argv[++i]);
    else if (arg === '--host') args.host = argv[++i];
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
  }
  return args;
}

function openBrowser(url) {
  const command =
    process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  const bin = process.platform === 'win32' ? 'cmd' : command;

  try {
    spawn(bin, argv, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

const HELP = `
  marcosoffices — a pixel-art office for your Claude agents

  Usage
    npx marcosoffices [options]

  Options
    -p, --port <n>   Port to listen on          (default 4321)
        --host <h>   Address to bind            (default 127.0.0.1)
        --no-open    Do not open a browser
    -h, --help       Show this
    -v, --version    Show the version

  State lives in ${DATA_DIR}
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return console.log(HELP);
  if (args.version) {
    const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
    return console.log(pkg.version);
  }

  const server = await createServer();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${args.port} is already in use. Try: marcosoffices --port ${args.port + 1}\n`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(args.port, args.host, () => {
    const url = `http://${args.host}:${args.port}`;
    console.log(`
   ===  MARCOS OFFICES  ===

   The office is open at  ${url}
   State lives in         ${DATA_DIR}

   Press Ctrl+C to close the office.
`);
    if (args.open) openBrowser(url);
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    console.log('\n  Closing the office — sending the staff home…');
    await shutdown();
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck socket.
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

main().catch((err) => {
  console.error('Failed to open the office:', err);
  process.exit(1);
});
