#!/usr/bin/env node

import { program, Option } from 'commander';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer, DEFAULT_PORT } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));

program
  .name(pack.name)
  .description(pack.description)
  .version(pack.version)
  .addOption(
    new Option('-p, --port <number>', 'HTTP/WebSocket port')
      .default(DEFAULT_PORT)
      .env('PAGENODES_MCP_PORT')
  )
  .addOption(
    new Option('--stdio', 'Enable stdio MCP transport (for spawned mode)')
      .default(false)
  );

program.parse();

const options = program.opts();
const port = parseInt(options.port, 10);

if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${options.port}`);
  process.exit(1);
}

startServer(port, { stdio: options.stdio });
