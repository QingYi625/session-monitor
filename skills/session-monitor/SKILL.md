---
name: session-monitor
description: Open or inspect the Session Monitor (会话统计) auxiliary side pane for real-time turns, steps, model/tool durations, TTFT, TPS, token cache hit rate, context breakdown, and compaction count. Use when the user asks to view or open session stats, token usage, context usage, or compaction count.
---

# 会话统计 (Session Monitor)

当用户希望查看或打开当前会话的实时统计面板（轮数、步数、耗时、TTFT、输出速度、Token 缓存命中、上下文构成或已压缩次数）时，直接给出辅助面板快捷打开链接：

[会话统计](sidecar://session-monitor/stats_panel/)

- 面板会自动绑定当前激活的 `conversationId`，每 1.5 秒实时同步 `~/.gemini/antigravity/conversations/<conversationId>.db` 与本地对话记录，无需调用额外工具。
- 也可以提示用户点击对话右上角 **`+`** 菜单打开 **会话统计** 标签页。
