# 三方决议：Agent通过Router调配Skills（最终计划方案）

**日期**: 2026-08-19
**参与方**: Codex (gpt-5.6-sol/max) · Claude (风险审核) · OpenCode (glm-5.3/max, 执行视角)
**性质**: 仅决议与计划，未进入开发，未修改任何配置/目录/app.asar

---

## 一、决议结论（三方一致）

**采用 E 混合方案**，各路径角色如下：

| 路径 | 角色 | 理由 |
|------|------|------|
| A. 隐藏/vault + MCP | **目标架构骨架** | 唯一不改宿主代码就能结构性消除95KB注入的手段 |
| MCP Router | **唯一主路由** | discover/load/health；manifest留在Router进程内，不进初始context |
| B. Hook | **护栏+遥测，非主力** | 实证：hook只能追加`additionalContext`，**无法删除/替换**已注入的skill reminder |
| D. AGENTS.md | **软协议引导** | ≤2KB入口（触发域速查+用法+降级路径），无强制力 |
| C. 改app.asar | **否决**（仅作最后兼容兜底） | 升级即丢、minified补丁脆弱、回滚需重装 |
| Stub Skills | **桥接机制**（Claude提案，纳入） | 扫描根保留~200B stub，保住`/xxx`调用链与其他agent可见性 |

**关键实证**（Codex探查宿主bundle确认）：
- 宿主存在 `buildSkillsSection`，固定生成 skill 列表注入用户上下文
- SessionStart/PreToolUse hook 只能**追加**，不能替换 → "hook重写reminder"路线死亡
- 因此**必须让扫描结果本身变小**（vault化或stub化），这是方案成立的根基

**硬性判断**（三方共识）：
> 如果ZCode既不能替换system-reminder、也不能桥接内置Skill调用，则"完全不读原始SKILL.md"与"原生/xxx完全无感"**不可兼得**。取舍：以Router原生MCP UX为主，stub桥接保/xxx，legacy模式保回滚。

---

## 二、目标架构

```
ZCode session 启动
 ├─ 扫描 ~/.zcode/skills/ + ~/.agents/skills/
 │    → 目录内只留 stub（~200B/skill，57个共~10KB，vs 现95KB，降~90%）
 │    → 完整SKILL.md + references/ 全部迁入 ~/.zcode/skill-store/（只读vault）
 ├─ AGENTS.md → ≤2KB Router入口（域→触发词速查 + 用法 + 降级路径）
 └─ config.json → 拉起 skill-router MCP（stdio）

运行时按需
 任务 → AI调 skill_discover(query) → top-N {id, summary, score}
      → AI调 skill_load(id) → 激活封装{content全文, baseDir, 文件清单, 指令框架头}
      → AI按指令执行；伴生文件用Read读vault绝对路径

模式开关（feature flag）
 legacy（原生）/ shadow（对照遥测）/ router-availability（可显式回退）
 / router-strict（Router失败即报错，绝不读旧文件）

护栏（可选，Phase 3）
 PreToolUse(matcher:"^Skill$") → deny + "请用skill_discover"

降级链
 MCP挂 → AI按AGENTS.md读 skill-store/INDEX.md → Bash调用现有CLI
```

**Stub SKILL.md 结构**（Claude提案）：
```yaml
---
name: code-review
description: "Two-axis code review (stub)"
---
Full skill available via skill-router. Call skill_load('code-review'), then follow returned instructions.
```

**激活封装**（Codex提案，MCP load返回体）：
```json
{
  "id": "...", "namespace": "...", "sha256": "...",
  "frontMatter": {...}, "content": "SKILL.md全文",
  "baseDirToken": "vault绝对路径", "fileList": ["references/*.md"],
  "instructionScope": "task", "truncated": false
}
```

---

## 三、G1决策门（需用户拍板，OpenCode提出）

`~/.agents/skills/` 是**跨agent共享目录**——Claude Code、Codex、OpenCode的skill注入同源于它。迁移/stub化会同时影响它们。

| 选项 | 内容 | 后果 |
|------|------|------|
| G1-a（推荐） | 全agent统一走Router（CLI/MCP形态天然跨agent） | 三家agent共用一套路由；初始context全面瘦身 |
| G1-b | 仅处理 `~/.zcode/skills/`，共享目录不动 | 覆盖不全（~13/69 skill），收益打折 |
| G1-c | 共享目录放stub，各agent自行适配Router | 其他agent看到stub描述，体验需各自验证 |

---

## 四、实施阶段

### Phase 0：能力探针（半天~2天，零改动或沙箱内）
| # | 探针 | 验证什么 |
|---|------|---------|
| P1 | `.probe-skill/` dot目录是否被扫描跳过 | 隐藏目录策略 |
| P2 | 清空扫描根（隔离profile）→ reminder是否消失/变空 | **方案根基假设** |
| P3 | `strings`扫host chunks找 `skills.enabled`/scanPaths/ignore等键 | 是否有官方开关 |
| P4 | SessionStart/PreToolUse事件能力清单 | hook边界（Codex已初步证实：仅追加） |
| P5 | 单skill移走 → `/xxx`是否"not found"；stub替换 → `/xxx`加载stub | stub桥接可行性 |
| P6 | 盘点两个skill目录的其他消费方 | G1影响面 |
| P7 | 基线冻结：ZCode版本/bundle hash/57个content hash/reminder字节数/启动延迟/原生调用成功率 | 对照基线 |

**出口条件**：明确回答①能否消除reminder ②stub能否桥接/xxx ③MCP load行为是否达标。三者皆否→不得全量切换。

### Phase 1：Router MCP封装（旁路开发，不动系统）
- stdio MCP薄封装现有 `zcode-integration.js`：`skill_discover` / `skill_load`（含激活封装+baseDir+文件清单）/ `health`
- 修补Router生产缺口（Codex指出）：CRLF/LF统一、完整front matter解析、`disable-model-invocation`透传、load时验hash、不向模型暴露真实fullPath、fail-closed
- golden corpus离线测试

### Phase 2：单skill Canary（可逆小步）
- 迁5–10个低风险skill到vault（**必须含≥2个带references/的**，专测伴生文件边界）
- 扫描根留stub；`generate-manifest.js`重扫指向vault
- feature flag四模式；跑真实任务；回滚演练（计时）

### Phase 3：全量迁移 + 护栏
- 脚本化迁移57个（自带原始位置清单=回滚凭据）
- 可选挂PreToolUse护栏；AGENTS.md替换为≤2KB入口

### Phase 4：观察与升级闸门（1–2周）
- 每次ZCode升级：查bundle hash→自动跑兼容探针→失败自动切legacy
- 达标后才清理旧副本（至少保留一个升级周期）

---

## 五、验收标准（Go/No-Go，三方合并）

1. 初始skill相关context **≤10KB**（stub方案；若P3找到官方开关可≤5KB），较基线降≥85%
2. 57/57 skill：以triggers[0]查询，discover命中top-3；精确ID调用100%
3. 10个真实任务：discover→load成功率100%；直接Skill tool成功调用=0（strict模式）
4. 带references/的skill伴生文件读取正常
5. `/xxx`有明确合同：经stub桥接成功，或返回明确迁移提示（**不得静默绕过Router**）
6. 性能：L0冷启动P95<50ms，discover P95<100ms，load P95<250ms；MCP握手成功率≥99.9%
7. 安全：路径遍历/绝对路径/junction逃逸/篡改manifest/超大文件全部拒绝；日志不含用户prompt与skill全文
8. 降级演练：kill MCP进程→经INDEX.md找回（1次）
9. 回滚演练：切legacy+重启，**≤5分钟**完成（1次计时）

---

## 六、风险矩阵（合并）

| 风险 | 等级 | 缓解 |
|------|------|------|
| G1共享目录影响其他agent | 中 | **先拍板G1**；推荐全agent统一 |
| ZCode升级改变扫描行为 | 中 | bundle hash闸门+自动探针+自动legacy |
| manifest漂移（增改skill后失步） | 中高 | content_hash已有；建立变更后重扫习惯或定时校验 |
| 模型不遵循MCP返回指令 | 低 | 指令框架头+AGENTS.md背书+Canary量化 |
| skill正文提示注入 | 低 | 正文视为task-scoped数据，不提权，副作用仍走正常工具+用户授权 |
| MCP进程故障 | 低 | 健康检查+单飞加载+INDEX.md降级链（ZCode对单server失败不阻断，已有经验） |

---

## 七、回滚方案

1. config.json删除skill-router MCP条目+护栏hook
2. 迁移脚本按原始位置清单把vault文件移回扫描根（或stub换回原文件）
3. AGENTS.md撤除Router段落
4. 重启ZCode → 原生skill列表与`/xxx`恢复
**全程≤5分钟，脚本化，无不可逆删除（vault只读快照至少保留一个升级周期）**

---

## 附：三方意见分歧与调和记录

| 议题 | Claude | OpenCode | Codex | 调和结果 |
|------|--------|----------|-------|---------|
| 初始context | Stub(~10KB) | Vault(~0KB) | 二者皆列 | **Stub为准**（保/xxx桥接+其他agent可见性）；P3找到开关则升级到~5KB |
| hook角色 | 可选优化 | 只配护栏 | 只能追加（实证） | 采纳Codex实证：**护栏+遥测** |
| /xxx命运 | stub可保 | 必然失效需接受 | 需bridge探针 | P5探针定夺；stub桥接为主答案 |
| asar修改 | 不推荐 | 否决 | 最后兜底 | **否决为常规手段**，仅留作极端兼容备案 |
| G1共享目录 | 未识别 | **提出** | 提及 | 采纳OpenCode：列为用户决策门 |

---

*本决议由三方独立分析后汇总；Codex基于宿主bundle实证，Claude基于风险矩阵，OpenCode基于现场文件核查（config.json/manifest/router源码）。下一步：用户拍板G1 → 启动Phase 0探针。*
