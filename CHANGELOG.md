# 更新日志

本文件记录会话统计（Session Monitor）插件的主要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-11-14

首个公开版本。

### 新增

- 右侧辅助面板（Auxiliary Pane）原生统计界面，每 1.5 秒自动刷新
- 顶部概览：轮数 / 步数、累计 Token、缓存命中率、上下文占用
- 会话统计卡片：模型用时、工具调用用时、首 token 平均（TTFT）、输出速度（TPS）
- 上下文卡片：占用比例、窗口上限、系统提示词 / 工具定义 / 对话消息构成拆解
- 已压缩次数统计，支持展开查看每次压缩前后的 token 变化与时间点
- Token 卡片：总 Token、缓存命中率、未缓存输入、缓存读取、输出
- 最近会话下拉切换，默认绑定当前激活对话
- `GET /api/stats` 接口支持 ETag 协商，无变化时跳过渲染
- 会话数据库（`node:sqlite`）主数据源与转录日志回退数据源
- `skills/session-monitor/SKILL.md`：供 Agent 识别并打开面板的技能说明
- 宽窄侧栏自适应布局

### 说明

- 全部数据本地只读，不联网、不上传、不存储凭证
- 无外部 npm 依赖，无构建步骤
