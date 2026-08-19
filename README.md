# skill-router

**One skill vault, every coding agent.** Stop injecting dozens of skill descriptions into every session — route them on demand.

Works with **ZCode · Codex CLI · Claude Code · OpenCode** (any subset, auto-detected).

[中文说明](#中文说明) below.

---

## The problem

Agent skill systems (Claude-style `SKILL.md` skills) scan your skill directories at session start and inject **every skill's description into the initial context**. With 50–70 skills that's ~100KB of context tax paid on *every single session* — when a typical session touches 1–3 skills.

## The fix (three moves)

```
1. VAULT    full SKILL.md trees move to a read-only vault (~/.zcode/skill-store)
2. STUB     every scanned SKILL.md becomes a ~160B redirect stub
3. MCP      one skill-router MCP server gives every agent two tools:
              skill_discover(query) -> ranked candidates
              skill_load(id)        -> full content + sha256 + baseDir + fileList
```

A session now sees skill *names* only; full content loads **through the router, on demand, hash-verified**. Companion files (`references/`, scripts) resolve via the returned `baseDir`.

```
/classpath-review          AI session
   └─ loads 160B stub: "call skill_load('code-review')"
        └─ skill_load -> vault full content (sha256-verified) -> AI executes it
```

Measured on a 57-skill setup: initial skill payload ~95KB → stubs only; every load is a 2–5ms local read with integrity check.

## Quick start

Requirements: Node.js ≥ 20, `tar` on PATH (ships with Windows 10+, macOS, Linux).

```bash
git clone https://github.com/Lordakee/skill-router.git
cd skill-router
node tests/run-tests.js        # verify the tool itself

# dry run (shows everything it would do, touches nothing):
node setup.mjs --dry-run

# real install (snapshots first, then migrates + registers all detected agents):
node setup.mjs

# rollback any time (byte-exact, per-location):
node rollback.mjs --snapshot ~/.skill-router-backups/<snapshot-dir printed by setup>
```

Defaults: roots `~/.zcode/skills,~/.agents/skills` · vault `~/.zcode/skill-store`. Override with `--roots a,b` / `--vault path`. Full flags in `node setup.mjs` header.

After setup, **restart your agents** — each gets the `skill_discover` / `skill_load` / `skill_health` MCP tools.

## What setup does, exactly

| Step | Action | Safety |
|---|---|---|
| 1 | tar.gz snapshot of both scan roots → `~/skill-router-backups/snapshot-<ts>/` | rollback anchor |
| 2 | manifest of live roots → every skill **copied** (never moved) into vault; migration manifest records id/hash/original path | rollback credentials |
| 3 | vault manifest generated (single source of truth for loads) | — |
| 4 | every managed `SKILL.md` in scan roots replaced by a redirect stub | originals live in vault + snapshot |
| 5 | MCP server registered for each detected agent (zcode `config.json` · codex `config.toml` · claude `.claude.json` · opencode `opencode.json`), each with a `.bak` backup | idempotent, per-file backups |

**Unmanaged directories in the roots are left untouched.** Rollback restores each physical file's original bytes per location (root-local variants that differed stay different), and even pre-creates dangling symlink targets so tar can rebuild them faithfully.

## Security posture

- `skill_load` verifies **SHA-256 against the manifest** before returning content (hash is computed on raw disk bytes; CRLF normalization happens after, so it cannot be bypassed by line-ending tricks)
- Path traversal, absolute paths, `..` segments, symlink/junction escapes, oversized files (>20MiB) → **fail closed**
- Tool errors are sanitized — no filesystem paths leak to the model
- `discover` never exposes `source_root`/`fullPath`

## Repo layout

```
setup.mjs                 one-command installer (4 agents, snapshot-first)
rollback.mjs              byte-exact restore from a snapshot
mcp/server.js             stdio MCP server (hand-rolled JSON-RPC, zero npm deps)
lib/router-core.js        router core: manifest, scoring, safe load, LRU, single-flight
lib/generate-manifest.js  manifest generator (front-matter aware, legacy-format tolerant)
migrate/                  canary migrate / rollback / vault-manifest tools
probes/                   host-capability probes + stub generator + baseline stats
tests/run-tests.js        full offline suite (protocol, security, migration, rollback)
docs/three-party-resolution.md   the architecture decision record (3-agent reviewed)
```

Zero npm dependencies — Node stdlib only.

## 中文说明

**skill-router：一个技能保险库，服务所有编码agent（ZCode / Codex CLI / Claude Code / OpenCode）。**

解决的问题：agent每次会话启动都把全部skill描述注入初始context（50~70个skill约100KB），而典型会话只用1~3个。

方案三步：全文入只读vault → 扫描根换成~160B重定向stub → 四agent共用一个MCP路由（`skill_discover`发现 / `skill_load`按需加载，带sha256校验、路径逃逸防护）。会话只见skill名字，全文经路由按需取。

```bash
git clone https://github.com/Lordakee/skill-router.git && cd skill-router
node tests/run-tests.js     # 自检
node setup.mjs --dry-run    # 演练
node setup.mjs              # 安装（先快照，可随时回滚）
node rollback.mjs --snapshot <setup打印的快照目录>   # 字节精确回滚
```

安装后重启各agent即可。回滚按原始位置逐文件还原字节（双根同名不同内容的副本各自还原）。

## License

MIT — see [LICENSE](LICENSE).
