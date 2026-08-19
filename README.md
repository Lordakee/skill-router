# skill-router

**One skill vault, every coding agent.** Route full `SKILL.md` instructions on demand instead of injecting every skill description into every session.

Supported agents: **ZCode, Codex CLI, Claude Code, and OpenCode**. Any subset can be installed.

[中文说明](#中文说明)

## Why

Claude-style skill systems scan skill directories when a session starts. With dozens of skills, descriptions that are irrelevant to the current task can consume a large part of the initial context.

skill-router changes the loading path:

```text
1. VAULT   Copy each selected full skill tree to ~/.zcode/skill-store
2. STUB    Replace only the manifest-selected SKILL.md files with small redirects
3. MCP     Expose skill_discover, skill_load, and skill_health from one local server
```

`skill_load` reads the full content on demand, verifies its SHA-256 hash, and returns its `baseDir` and companion-file list.

The vault is the workflow's full-content source of truth after installation, but it is **not made read-only by filesystem permissions**. A user or process can still edit it. Hash verification detects changes before content is returned.

## Requirements

- Node.js 20 or newer
- `tar` on `PATH`
- No npm install; the project has zero npm dependencies

Both GNU tar and bsdtar/libarchive are detected. On Windows, system bsdtar receives native `C:\...` paths; MSYS/Git GNU tar receives `/c/...` paths.

## Quick Start

```bash
git clone https://github.com/Lordakee/skill-router.git
cd skill-router
node tests/run-tests.js

# Read-only planning. Empty or invalid roots fail here too.
node setup.mjs --dry-run

# Snapshot, install, stub, and register detected agents.
node setup.mjs

# Restore the exact pre-install bytes at each recorded root.
node rollback.mjs --snapshot ~/skill-router-backups/<snapshot-dir>

# Restore roots, remove MCP registrations, and safely delete the recorded vault.
node uninstall.mjs --snapshot ~/skill-router-backups/<snapshot-dir> --purge-vault
```

Default roots are the existing directories among `~/.zcode/skills` and `~/.agents/skills`. The default vault is `~/.zcode/skill-store`. Override them with `--roots a,b` and `--vault path`.

All three lifecycle tools accept `--home path`; this is used by the test suite and CI to keep every dynamic test inside a temporary sandbox HOME.

## Lifecycle Tools

### setup.mjs

`setup.mjs` performs these operations:

1. Canonicalize and deduplicate roots. Missing directories and any root or ancestor symlink/junction are rejected.
2. Create an exclusive `~/skill-router-backups/snapshot-<timestamp>-<random>/` directory. `snapshot.json` maps every archive to its canonical original root.
3. Build a vault in a same-parent staging directory, generate and hash-check its manifest, write `install-receipt.json`, then atomically rename the staged vault into place.
4. Replace only the exact `source_root + path` targets selected by the live manifest. A directory basename does not need to equal its skill ID; overridden duplicates in other roots are not accidentally stubbed.
5. Register the MCP server for detected agents. Codex TOML is appended inside an ownership-fingerprinted begin/end block. `--skip-mcp` bypasses registration before any agent config is inspected.

The install receipt records the canonical vault, server ID, canonical roots, creation time, tool version, tar implementation, MCP ownership fingerprint, and exact managed stub targets.

Running setup again while every recorded target is already a stub exits successfully without a new snapshot or migration. It prints the current state and reinstall guidance. After a rollback, running setup again verifies every restored source hash against the existing vault before reusing that vault and recreating stubs; a further repeated run is the normal idempotent exit.

Useful flags:

```text
--home path
--roots pathA,pathB
--vault path
--agents zcode,codex,claude,opencode
--server-id skill-router
--skip-mcp
--dry-run
```

### rollback.mjs

```bash
node rollback.mjs --snapshot <snapshot-dir> [--roots expectedA,expectedB] [--dry-run]
```

Rollback requires `snapshot.json`; it never infers a destination from an archive filename. `--roots` is only an explicit equality check against the canonical roots recorded in snapshot metadata and never changes restore destinations.

Before an existing root is removed, rollback fully lists and validates every archive, rejects absolute or `..` members and any member outside `skills/`, and pre-extracts every archive into a separate staging directory. Only after all archives pass does it replace the recorded roots. Declared absolute link targets are pre-created only when they remain inside HOME.

Rollback leaves the vault and MCP registrations in place.

### uninstall.mjs

```bash
# Restore roots, deregister MCP, keep the vault.
node uninstall.mjs --snapshot <snapshot-dir>

# Restore roots, deregister MCP, and purge the receipt-matched vault.
node uninstall.mjs --snapshot <snapshot-dir> --purge-vault

# Deregister only. Roots and vault remain unchanged.
node uninstall.mjs --mcp-only [--server-id id]
```

If `--server-id` is omitted, uninstall reads it from the install receipt and then falls back to `skill-router`. Codex removal deletes only a matching managed begin/end block. An unmarked legacy section without an ownership fingerprint is left in place with a manual-confirmation message.

`--purge-vault` requires a valid receipt whose canonical path still matches the vault realpath. HOME, filesystem roots, the repository workspace, overlapping paths, and symlink/junction aliases are rejected. `--mcp-only --purge-vault` is also rejected while a recorded scan-root target is still a stub, preventing deletion of the only full copy.

Both setup and uninstall dry runs build the same validation plans as real runs but perform no writes.

## Security Model

- Raw file bytes are SHA-256 checked before CRLF normalization or return.
- Absolute paths, `..`, unsafe relative paths, symlink/junction escapes, and files larger than 20 MiB fail closed.
- `tools/call` failures expose only `Skill operation failed` plus a fixed short code such as `SR_HASH_MISMATCH`, `SR_NOT_FOUND`, or `SR_PATH_REJECTED`.
- Dynamic error details are written only to stderr with a fixed `[skill-router-v2] tool error` prefix.
- `skill_discover` does not expose source paths.

## Repository Layout

```text
setup.mjs                     staged installer and MCP registration
rollback.mjs                  metadata-driven, validate-before-replace restore
uninstall.mjs                 restore, MCP deregistration, guarded vault purge
mcp/server.js                 stdio MCP JSON-RPC server
lib/router-core.js            manifest, scoring, path-safe load, cache
lib/generate-manifest.js      front-matter-aware manifest generator
migrate/                      canary migration and vault-manifest utilities
probes/                       capability probes and stub generator
tests/run-tests.js            offline unit/protocol suite
tests/lifecycle-test.mjs      sandboxed end-to-end lifecycle suite
```

## Known Limitations

- Skill IDs remain case-sensitive across the full pipeline; a single case-folded ID contract is deferred.
- The standalone canary migration tools are not a general transaction engine. `setup.mjs` contains their writes inside vault staging, but a broader canary-tool transaction redesign is deferred.
- `regenerate-for-vault.js` still captures generator output through the existing console interface; a structured logger is deferred.
- Lifecycle logic has not been extracted into a shared lifecycle library. The CLI boundaries remain explicit, and uninstall invokes rollback for restore validation and execution.

## 中文说明

**一个 skill vault，服务所有编码 agent。** skill-router 不再让每次会话都注入全部 skill 描述，而是按需路由完整 `SKILL.md` 指令。

支持 **ZCode、Codex CLI、Claude Code、OpenCode**，可以只安装其中任意一部分。

## 解决的问题

Claude 风格的 skill 系统会在会话启动时扫描 skill 目录。skill 数量较多时，与当前任务无关的描述也会占用大量初始 context。

skill-router 改为三步加载：

```text
1. VAULT   把每个选中的完整 skill 树复制到 ~/.zcode/skill-store
2. STUB    仅把 manifest 选中的 SKILL.md 替换为小型重定向 stub
3. MCP     由一个本地 server 提供 skill_discover、skill_load、skill_health
```

`skill_load` 按需读取全文，校验 SHA-256，并返回 `baseDir` 和伴生文件列表。

安装后，vault 是工作流中的全文权威副本，但**没有通过文件系统权限强制设为只读**。用户或其他进程仍可修改它；返回内容前的 hash 校验会发现变更。

## 环境要求

- Node.js 20 或更高版本
- `PATH` 中可调用 `tar`
- 零 npm 依赖，不需要执行 npm install

程序会识别 GNU tar 与 bsdtar/libarchive。Windows 系统 bsdtar 使用原生 `C:\...` 路径；MSYS/Git GNU tar 使用 `/c/...` 路径。

## 快速开始

```bash
git clone https://github.com/Lordakee/skill-router.git
cd skill-router
node tests/run-tests.js

# 只规划、不写入；空 roots 或非法 roots 在 dry-run 中同样报错。
node setup.mjs --dry-run

# 快照、安装、stub 化并注册检测到的 agent。
node setup.mjs

# 按每个记录根恢复安装前的精确字节。
node rollback.mjs --snapshot ~/skill-router-backups/<快照目录>

# 恢复 roots、删除 MCP 注册并安全删除回执记录的 vault。
node uninstall.mjs --snapshot ~/skill-router-backups/<快照目录> --purge-vault
```

默认 roots 是 `~/.zcode/skills`、`~/.agents/skills` 中实际存在的目录；默认 vault 是 `~/.zcode/skill-store`。可用 `--roots a,b` 和 `--vault path` 覆盖。

三个生命周期工具都接受 `--home path`。测试套件和 CI 使用它把所有动态测试限制在临时沙箱 HOME 内。

## 生命周期工具

### setup.mjs

`setup.mjs` 依次执行：

1. 规范化 roots 的 realpath 并去重；拒绝不存在的目录，以及 root 本身或任意祖先中的符号链接/junction。
2. 排他创建 `~/skill-router-backups/snapshot-<时间戳>-<随机值>/`；`snapshot.json` 把每个 archive 映射到规范化的原始 root。
3. 在 vault 同级 staging 中构建全文副本，生成并校验 manifest/hash，写入 `install-receipt.json`，最后原子 rename 到正式 vault。
4. 只替换 live manifest 中精确 `source_root + path` 指向的文件。目录 basename 可以不等于 skill ID；其他 root 中被覆盖的重复副本不会被误 stub 化。
5. 为检测到的 agent 注册 MCP。Codex TOML 使用带所有权指纹的 begin/end 受管块；`--skip-mcp` 会在检查任何 agent 配置前直接跳过注册。

安装回执记录规范化 vault、server ID、规范化 roots、创建时间、工具版本、tar 实现、MCP 所有权指纹和精确受管 stub 目标。

当所有回执目标已经是 stub 时，再次运行 setup 会成功幂等退出，不创建新快照，也不进入 migrate，并打印当前状态和重装指引。执行 rollback 后再次运行 setup 时，程序会逐项确认恢复后的源 hash 与既有 vault 一致，确认后复用 vault 并重新生成 stub；随后再重复运行就是普通幂等退出。

常用参数：

```text
--home path
--roots pathA,pathB
--vault path
--agents zcode,codex,claude,opencode
--server-id skill-router
--skip-mcp
--dry-run
```

### rollback.mjs

```bash
node rollback.mjs --snapshot <快照目录> [--roots expectedA,expectedB] [--dry-run]
```

rollback 强制读取 `snapshot.json`，绝不会根据 archive 文件名猜恢复目标。`--roots` 只用于显式校验它们是否与快照元数据中的规范化 roots 完全相同，不会覆盖恢复目标。

删除任何现有 root 之前，rollback 会完整读取并校验所有 archive 列表，拒绝绝对路径、`..`、以及不在 `skills/` 下的成员，并先把所有 archive 解压到独立 staging。全部通过后才替换记录的 roots。只有 archive 明确声明、且仍位于 HOME 内的绝对链接目标才会被预创建。

rollback 不删除 vault，也不移除 MCP 注册。

### uninstall.mjs

```bash
# 恢复 roots、移除 MCP 注册、保留 vault。
node uninstall.mjs --snapshot <快照目录>

# 恢复 roots、移除 MCP 注册并 purge 回执匹配的 vault。
node uninstall.mjs --snapshot <快照目录> --purge-vault

# 只移除注册，roots 与 vault 保持不变。
node uninstall.mjs --mcp-only [--server-id id]
```

未传 `--server-id` 时，uninstall 优先从安装回执读取，最后才回退到 `skill-router`。Codex 只删除匹配的 begin/end 受管块。没有受管标记、也没有所有权指纹的旧格式 section 会保留，并提示需要手动确认。

`--purge-vault` 必须找到有效回执，而且当前 vault realpath 必须仍与回执中的规范化路径一致。HOME、文件系统/盘符根、仓库工作区、相互重叠路径以及符号链接/junction 别名都会被拒绝。当回执记录的扫描根仍有 stub 时，`--mcp-only --purge-vault` 也会被拒绝，避免删除唯一全文副本。

setup 和 uninstall 的 dry-run 与真实执行共用同一套验证计划，但不会写入任何文件。

## 安全模型

- 在 CRLF 规范化或返回内容之前，先对原始文件字节做 SHA-256 校验。
- 绝对路径、`..`、非法相对路径、符号链接/junction 逃逸以及大于 20 MiB 的文件全部失败关闭。
- `tools/call` 错误只返回固定文案 `Skill operation failed` 和固定短错误码，例如 `SR_HASH_MISMATCH`、`SR_NOT_FOUND`、`SR_PATH_REJECTED`。
- 动态错误详情只写入 stderr，并统一使用 `[skill-router-v2] tool error` 前缀。
- `skill_discover` 不暴露源路径。

## 仓库结构

```text
setup.mjs                     staging 安装与 MCP 注册
rollback.mjs                  基于元数据、先验证后替换的恢复工具
uninstall.mjs                 恢复、MCP 注销和受保护 vault purge
mcp/server.js                 stdio MCP JSON-RPC server
lib/router-core.js            manifest、评分、安全加载和缓存
lib/generate-manifest.js      支持 front matter 的 manifest 生成器
migrate/                      canary 迁移与 vault manifest 工具
probes/                       能力探测与 stub 生成器
tests/run-tests.js            离线单元/协议测试
tests/lifecycle-test.mjs      沙箱端到端生命周期测试
```

## 已知限制

- skill ID 全链路仍区分大小写；统一的大小写折叠 ID 契约暂缓。
- 独立 canary 迁移工具还不是通用事务引擎。`setup.mjs` 已把它们的写入封装在 vault staging 内，但 canary 工具的整体事务化改造暂缓。
- `regenerate-for-vault.js` 仍通过现有 console 接口捕获生成器输出；结构化 logger 暂缓。
- lifecycle 逻辑尚未提取为共享 lifecycle library。CLI 边界保持显式，uninstall 通过 rollback 执行恢复预检与实际恢复。

## License

MIT, see [LICENSE](LICENSE).
