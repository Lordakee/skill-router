# P5 Stub Bridge 人工验证

`make-stub.js` 只在指定 `--out` 目录生成桥接 stub，不改动源 skill。每个 stub 保留 `name`、压缩后的 `description`，并把完整 skill 的获取合同指向 `skill_load('<id>')`。

## 自动步骤

```powershell
node .\probes\make-stub.js --source "$env:USERPROFILE\.zcode\skills" --out .\p5-stubs
```

检查输出 JSON 中每个文件的 `bytes`、`id` 和输出路径；确认源目录的 `SKILL.md` 哈希未改变。

## 需要真实 ZCode session 的步骤

1. 在隔离 profile 中只把一个低风险 skill 的 stub 放入扫描根，启动新 session。
2. 直接输入对应 `/<id>`，确认宿主能发现 stub，并且不会静默执行旧的完整正文。
3. 确认 stub 的重定向文本能引导模型调用 MCP `skill_discover`/`skill_load`。
4. 删除 stub、恢复完整 skill，重启 session，确认原生调用恢复。
5. 记录宿主版本、扫描根、`/id` 成功/失败、是否出现 `not found`；仅凭离线脚本不能证明宿主的 Skill bridge 行为。
