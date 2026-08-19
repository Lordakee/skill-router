#!/usr/bin/env node
/**
 * skill-router setup — wire ZCode / Codex CLI / Claude Code / OpenCode onto one skill router.
 *
 * What it does (mirrors the audited production runbook):
 *   1. Snapshot both skill scan roots into timestamped tar.gz (rollback anchor)
 *   2. Generate a manifest from current roots, migrate every skill into a read-only vault
 *   3. Generate the vault manifest (single source of truth for loads)
 *   4. Replace every SKILL.md in scan roots with a ~160B redirect stub
 *   5. Register the MCP server for each detected agent, all pointing at the vault manifest
 *
 * Usage:
 *   node setup.mjs [--roots pathA,pathB] [--vault path] [--agents zcode,codex,claude,opencode]
 *                  [--server-id skill-router] [--dry-run] [--skip-mcp]
 *
 * Defaults:
 *   roots  = ~/.zcode/skills,~/.agents/skills        (existing dirs only)
 *   vault  = ~/.zcode/skill-store
 *   agents = all detected among zcode/codex/claude/opencode
 *
 * Rollback: node rollback.mjs --snapshot <dir printed by this script>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { migrate } = require('./migrate/migrate-canary.js');
const { regenerate } = require('./migrate/regenerate-for-vault.js');
const { generateManifest } = require('./lib/generate-manifest.js');

const SERVER_REL = 'mcp/server.js';

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
const SERVER_ID = args['server-id'] || 'skill-router';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SERVER_ABS = path.join(HERE, SERVER_REL);
const exp = p => p.replace(/^~(?=$|\/|\\)/, HOME);
const VAULT = args.vault ? path.resolve(exp(args.vault)) : path.join(HOME, '.zcode', 'skill-store');

function log(step, msg) { console.log(`[${step}] ${msg}`); }

// MSYS/GNU tar on Windows cannot take C:\... args (drive letter parsed as host); convert to /c/... form.
const posix = p => process.platform === 'win32'
  ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):\/?/, (m, d) => `/${d.toLowerCase()}/`)
  : p;

function tarSnapshot(label, srcDir, outDir) {
  const out = path.join(outDir, `skills-${label}.tar.gz`);
  // bsdtar ships with Windows 10+, present on macOS/Linux
  execFileSync('tar', ['-czf', posix(out), '-C', posix(path.dirname(srcDir)), path.basename(srcDir)], { stdio: 'pipe' });
  return out;
}

// ---------- agent detection & MCP registration ----------

const AGENTS = {
  zcode: {
    config: path.join(HOME, '.zcode', 'cli', 'config.json'),
    detect() { return fs.existsSync(this.config); },
    register(cfgPath, manifestPath) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.mcp = cfg.mcp || {}; cfg.mcp.servers = cfg.mcp.servers || {};
      cfg.mcp.servers[SERVER_ID] = {
        type: 'stdio',
        command: 'node',
        args: [SERVER_ABS],
        enabled: true,
        timeoutMs: 120000,
        env: { SKILL_ROUTER_MANIFEST: manifestPath },
      };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    },
  },
  codex: {
    config: path.join(HOME, '.codex', 'config.toml'),
    detect() { return fs.existsSync(this.config); },
    register(cfgPath, manifestPath) {
      let text = fs.readFileSync(cfgPath, 'utf8');
      if (text.includes(`[mcp_servers.${SERVER_ID}]`)) return; // idempotent
      const fwd = p => p.replace(/\\/g, '/'); // TOML basic strings: no raw backslashes
      text += `\n[mcp_servers.${SERVER_ID}]\ncommand = "node"\nargs = ["${fwd(SERVER_ABS)}"]\nenv = { SKILL_ROUTER_MANIFEST = "${fwd(manifestPath)}" }\nstartup_timeout_sec = 30.0\n`;
      fs.writeFileSync(cfgPath, text);
    },
  },
  claude: {
    config: path.join(HOME, '.claude.json'),
    detect() { return fs.existsSync(this.config); },
    register(cfgPath, manifestPath) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers[SERVER_ID] = {
        type: 'stdio', command: 'node', args: [SERVER_ABS],
        env: { SKILL_ROUTER_MANIFEST: manifestPath },
      };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    },
  },
  opencode: {
    config: path.join(HOME, '.config', 'opencode', 'opencode.json'),
    detect() { return fs.existsSync(this.config); },
    register(cfgPath, manifestPath) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.mcp = cfg.mcp || {};
      cfg.mcp[SERVER_ID] = {
        enabled: true, type: 'local',
        command: ['node', SERVER_ABS],
        environment: { SKILL_ROUTER_MANIFEST: manifestPath },
      };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    },
  },
};

// ---------- main ----------

function main() {
  if (!fs.existsSync(SERVER_ABS)) { console.error(`ABORT: server not found at ${SERVER_ABS}`); process.exit(2); }

  const roots = (args.roots ? args.roots.split(',').map(s => path.resolve(exp(s.trim()))) : [path.join(HOME, '.zcode', 'skills'), path.join(HOME, '.agents', 'skills')])
    .filter(r => fs.existsSync(r));
  if (!roots.length) { console.error('ABORT: no existing skill roots found; pass --roots'); process.exit(2); }
  log('0/5', `roots: ${roots.join(', ')}`);
  log('0/5', `vault: ${VAULT}${DRY ? ' (dry-run)' : ''}`);

  // 1. snapshot (tar label = scan-root parent name, e.g. zcode/agents, so rollback can map it back)
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 15);
  const snapDir = path.join(HOME, 'skill-router-backups', `snapshot-${stamp}`);
  const labelOf = root => path.basename(path.dirname(root)).replace(/^\.+/, '').replace(/[^A-Za-z0-9_-]/g, '_');
  if (!DRY) {
    fs.mkdirSync(snapDir, { recursive: true });
    roots.forEach(r => log('1/5', `snapshot ${tarSnapshot(labelOf(r), r, snapDir)}`));
  } else log('1/5', `would snapshot roots into ${snapDir}`);

  // 2. manifest + migrate
  const live = generateManifest(roots);
  log('2/5', `discovered ${live.skills.length} unique skills`);
  const liveManifestPath = path.join(HERE, 'live-manifest.local.json');
  if (!DRY) fs.writeFileSync(liveManifestPath, JSON.stringify(live, null, 2));
  const stubOut = path.join(HOME, '.zcode', 'skills-router-stubs');
  const migManifest = path.join(HERE, 'migration-manifest.local.json');
  if (DRY) { log('2/5', `would migrate ${live.skills.length} skills -> vault, stubs -> ${stubOut}`); }
  else {
    const r = migrate({ ids: live.skills.map(s => s.id), vault: VAULT, stubOut, manifestOut: migManifest, manifestPath: liveManifestPath });
    log('2/5', `migrated ${r.entries.length} skills (rollback credentials: ${migManifest})`);
  }

  // 3. vault manifest
  const vaultManifest = path.join(VAULT, '.router', 'vault-manifest.json');
  if (DRY) log('3/5', `would generate ${vaultManifest}`);
  else {
    const g = regenerate(VAULT, vaultManifest);
    log('3/5', `vault manifest: ${g.skillCount} skills -> ${vaultManifest}`);
  }

  // 4. stub sweep (top-level of each root; dot dirs skipped)
  if (!DRY) {
    const stubs = new Map();
    for (const d of fs.readdirSync(stubOut)) {
      const p = path.join(stubOut, d, 'SKILL.md');
      if (fs.existsSync(p)) stubs.set(d, fs.readFileSync(p, 'utf8'));
    }
    let replaced = 0, kept = 0;
    for (const root of roots) {
      for (const d of fs.readdirSync(root)) {
        if (d.startsWith('.')) continue;
        const p = path.join(root, d, 'SKILL.md');
        if (!fs.existsSync(p)) continue;
        const c = fs.readFileSync(p, 'utf8');
        if (c.includes("skill_load('")) { kept += 1; continue; }
        const stub = stubs.get(d);
        if (!stub) continue; // not a managed skill (foreign dir) — leave untouched
        fs.writeFileSync(p, stub, 'utf8');
        replaced += 1;
      }
    }
    log('4/5', `stubbed ${replaced} SKILL.md (already-stubbed: ${kept}); full content now vault-only`);
  } else log('4/5', 'would replace managed SKILL.md files with redirect stubs');

  // 5. MCP registration
  const wanted = args.agents ? args.agents.split(',').map(s => s.trim()) : Object.keys(AGENTS);
  const registered = [];
  for (const name of wanted) {
    const agent = AGENTS[name];
    if (!agent) { log('5/5', `unknown agent "${name}" (expected zcode|codex|claude|opencode)`); continue; }
    if (!agent.detect()) { log('5/5', `${name}: config not found, skipped`); continue; }
    if (DRY) { registered.push(name); continue; }
    const bak = `${agent.config}.bak-skillrouter-${stamp}`;
    fs.copyFileSync(agent.config, bak);
    agent.register(agent.config, vaultManifest);
    registered.push(name);
    log('5/5', `${name}: registered (backup: ${path.basename(bak)})`);
  }
  if (args['skip-mcp']) log('5/5', '--skip-mcp set: MCP registration bypassed');

  console.log('\nDone. AI sessions now see stubs only; full skills load on demand via skill_discover/skill_load.');
  console.log(`Rollback: node rollback.mjs --snapshot ${DRY ? '<snapshot-dir>' : snapDir} --roots ${roots.join(',')}`);
}

main();
