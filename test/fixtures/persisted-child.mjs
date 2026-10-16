// Runs one inspection in a process that started with its own NODE_EXTRA_CA_CERTS, against the registry fixture.
// argv[2]: JSON { certificates, hosts, request }. Prints the checks, diagnostics and persisted values as JSON.
import { inspect } from '../../dist/core/index.js';
import { startRegistry, redirectRegistry } from './tls-registry.mjs';

const { certificates, hosts, request } = JSON.parse(process.argv[2]);
const server = await startRegistry(certificates);
const restore = redirectRegistry(server.port, hosts);
try {
  const result = await inspect(request);
  const { status, checks, diagnostics, persisted } = result;
  process.stdout.write(JSON.stringify({ status, checks, diagnostics, persisted, extra: process.env.NODE_EXTRA_CA_CERTS }));
} finally { restore(); await server.close(); }
