#!/usr/bin/env node

/**
 * Process entry point. In stdio mode (Claude Desktop, local testing), we
 * redirect console.log to stderr BEFORE any library code loads so accidental
 * stdout writes don't corrupt the MCP JSON-RPC channel. In HTTP mode (the
 * container default), stdout is fine for structured logs.
 *
 * jsforce 3.x does not call console.log on import, but dotenv v17 does — and
 * we use winston elsewhere — so the guard is cheap insurance against any
 * future dependency picking it up.
 */

if (!process.env.MCP_TRANSPORT || process.env.MCP_TRANSPORT === 'stdio') {
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    process.stderr.write(
      args
        .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ') + '\n',
    );
  };
}

// Dynamic import so the guard above is applied before module resolution kicks in.
import('./index.js').catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start salesforce-mcp:', err);
  process.exit(1);
});
