#!/usr/bin/env node
/**
 * skill-router uninstall — remove the router from all agents.
 *
 * What it does:
 *   1. (optional, --snapshot <dir>) restore scan roots byte-exactly via rollback logic
 *      — otherwise stubs stay in place and you keep loading via MCP (not recommended)
 *   2. remove the skill-router MCP registration from every agent config (backup kept)
 *   3. (optional, --purge-vault) delete the vault directory
 *
 * Usage:
 *   node uninstall.mjs --snapshot <dir-from-setup> [--purge-vault] [--dry-run]
 *   node uninstall.mjs --mcp-only                # just strip MCP registrations
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const DRY = Boolean(args['dry-run']);
const HOME = args.home ? path.resolve(args.home) : os.homedir();
const SERVER_ID = 'skill-router'; // setup's default; override with --server-id
const posix = p => process.platform === 'win32'
  ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):\/?/, (m, d) => `/${d.toLowerCase()}/`)
  : p;

// ---------- rollback of roots (same semantics as rollback.mjs) ----------

function restoreRoots(snap) {
  if (!fs.existsSync(snap)) { console.error(`ABORT: snapshot dir not found: ${snap}`); process.exit(2); }
  const tars = fs.readdirSync(snap).filter(f => f.startsWith('skills-') && f.endsWith('.tar.gz'));
  if (!tars.length) { console.error(`ABORT: no skills-*.tar.gz in ${snap}`); process.exit(2); }
  const parents = { zcode: path.join(HOME, '.zcode'), agents: path.join(HOME, '.agents') };
  for (const t of tars) {
    const label = t.slice('skills-'.length, -'.tar.gz'.length);
    const parent = parents[label] || path.join(HOME, '.' + label);
    console.log(`[restore] ${t} -> ${parent}${DRY ? ' (dry-run)' : ''}`);
    if (DRY) continue;
    let listing = '';
    try { listing = execFileSync('tar', ['-tvzf', posix(path.join(snap, t))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* best-effort */ }
    for (const line of listing.split(/\r?\n/)) {
      if (!line.startsWith('l')) continue;
      const m = line.match(/-> (.+)$/);
      if (!m) continue;
      const target = m[1].trim();
      if (target.startsWith('/') || target.startsWith(HOME) || /^[A-Za-z]:[\\/]/.test(target)) {
        try { fs.mkdirSync(target, { recursive: true }); } catch { /* best-effort */ }
      }
    }
    fs.rmSync(path.join(parent, 'skills'), { recursive: true, force: true });
    execFileSync('tar', ['-xzf', posix(path.join(snap, t)), '-C', posix(parent)], { stdio: 'pipe' });
  }
}

// ---------- MCP deregistration per agent ----------

const REMOVALS = {
  zcode: {
    config: path.join(HOME, '.zcode', 'cli', 'config.json'),
    apply(cfg) { if (cfg.mcp?.servers) delete cfg.mcp.servers[SERVER_ID]; return cfg; },
    json: true,
  },
  claude: {
    config: path.join(HOME, '.claude.json'),
    apply(cfg) { if (cfg.mcpServers) delete cfg.mcpServers[SERVER_ID]; return cfg; },
    json: true,
  },
  opencode: {
    config: path.join(HOME, '.config', 'opencode', 'opencode.json'),
    apply(cfg) { if (cfg.mcp) delete cfg.mcp[SERVER_ID]; return cfg; },
    json: true,
  },
  codex: {
    config: path.join(HOME, '.codex', 'config.toml'),
    apply(text) {
      // remove our appended block: from the marker line to the next section or EOF
      const marker = `[mcp_servers.${SERVER_ID}]`;
      const i = text.indexOf(marker);
      if (i === -1) return text;
      let j = text.indexOf('\n[mcp_servers.', i + marker.length);
      j = text.indexOf('\n[', i + marker.length);
      const end = j === -1 ? text.length : j + 1;
      return text.slice(0, i).replace(/\n+$/, '\n\n') + text.slice(end);
    },
    json: false,
  },
};

function deregisterMcp() {
  for (const [name, r] of Object.entries(REMOVALS)) {
    if (!fs.existsSync(r.config)) { console.log(`[mcp] ${name}: config not found, skipped`); continue; }
    const raw = fs.readFileSync(r.config, 'utf8');
    const marker = r.json ? `"${SERVER_ID}"` : `[mcp_servers.${SERVER_ID}]`;
    if (!raw.includes(marker)) { console.log(`[mcp] ${name}: not registered, skipped`); continue; }
    if (DRY) { console.log(`[mcp] ${name}: would deregister (backup kept)`); continue; }
    const bak = `${r.config}.bak-sr-uninstall-${Date.now()}`;
    fs.copyFileSync(r.config, bak);
    const next = r.json ? r.apply(JSON.parse(raw)) : r.apply(raw);
    fs.writeFileSync(r.config, r.json ? JSON.stringify(next, null, 2) : next);
    console.log(`[mcp] ${name}: deregistered (backup: ${path.basename(bak)})`);
  }
}

// ---------- main ----------

if (!args.snapshot && !args['mcp-only']) {
  console.error('Provide --snapshot <dir> to restore roots, or --mcp-only to strip registrations only.');
  process.exit(2);
}

if (args.snapshot) {
  const snap = path.resolve(String(args.snapshot).replace(/^~(?=$|\/|\\)/, HOME));
  console.log(`[1/3] restoring scan roots from ${snap}`);
  restoreRoots(snap);
} else {
  console.log('[1/3] --mcp-only: roots untouched (stubs remain)');
}

console.log(`[2/3] deregistering MCP from agents${DRY ? ' (dry-run)' : ''}`);
deregisterMcp();

const VAULT = args.vault ? path.resolve(String(args.vault).replace(/^~(?=$|\/|\\)/, HOME)) : path.join(HOME, '.zcode', 'skill-store');
if (args['purge-vault']) {
  console.log(`[3/3] purging vault ${VAULT}${DRY ? ' (dry-run)' : ''}`);
  if (!DRY) fs.rmSync(VAULT, { recursive: true, force: true });
  console.log('      WARNING: vault deleted — skills now exist only in the restored roots (or nowhere if restore was skipped).');
} else {
  console.log(`[3/3] vault kept at ${VAULT} (use --purge-vault to delete)`);
}

console.log('\nUninstall complete. Restart your agents to return to native skill loading.');
