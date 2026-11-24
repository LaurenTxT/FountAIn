# FountAIn

**FountAIn** 是一款面向桌面端的本地多模型 AI 协作工作台（Windows / Electron + React + TypeScript），让你可以在同一个项目房间或聊天室里自由组织 **Claude、ChatGPT (Codex)、DeepSeek、Gemini、Qwen、Kimi、GLM、Grok、MiniMax** 等任意数量的大模型协同讨论、分工执行、互相 `@` 交棒复核，并内置原生 **QQ Bridge（OneBot v11 / NapCat）** 实现远程消息与群聊协同。

---

## 核心特性

- **多模型自由编排与独立立绘系统**
  - 支持接入 1 个、4 个乃至 9+ 个模型执行端（内置 Claude Code、Codex、DeepSeek Harness 及标准 ACP 协议执行端）。
  - 自带 9 套高精角色立绘与代表色，支持自定义头像/立绘裁剪、人物设定（Persona）、称呼与长期记忆。
- **项目会议室与成员 `@` 接力协作**
  - **茶歇室（自由闲聊 / 会议）** 与 **项目会议室（直接读写本地项目目录并自动执行验证）** 双空间设计，支持父子项目树分组管理与会议中途动态增减在场成员。
  - 支持成员间直接 `@成员名` 自动接棒发言，精确追踪回复指向；内置防空口承诺与增量验证工作流提示词。
  - 支持成员在回复中用 Markdown 引用本地生成的图表（`![说明](路径.png)`），自动渲染高清预览卡片与顶层全屏灯箱。
- **实时分步任务清单与心跳面板**
  - 成员执行工具或长任务时，实时展示可滚动的分步进度清单（`✓ / ● / ○`）与动态心跳计时；正式回复完成后自动折叠收起，保持对话流干净。
- **后台上下文管理员（Auto-Compaction）**
  - 默认开启上下文管理员，空闲时自动将超长对话浓缩为 6 段式高保真工程交接摘要（保留目标、已完成改动、技术口径、权限约束与下一步），亦可随时手动一键压缩。
- **原生内置 QQ Bridge（NapCat / OneBot v11）**
  - 零第三方依赖的 RFC 6455 反向 WebSocket 服务，支持私聊与 QQ 群 `@` 触发、收发图片、切换房间（`/rooms`、`/use`、`/status`、`/stop`）以及指定单成员“当家”对外代理模式。
  - 左上角团队栏实时显示 QQ 在线状态与真实 QQ 头像，支持随应用启动后台静默免扫码自动登录。

---

## 环境要求与快速启动

- **操作系统**：Windows 10 / 11 x64
- **Node.js**：`>= 22`（开发构建）

```bash
# 1. 安装依赖
npm install

# 2. 开发模式启动
npm run dev

# 3. 生产构建并启动桌面端
npm run build
npm start
```

---

## 打包分发

```bash
# 构建 Windows 安装包与便携版（输出至 release/）
npm run package

# 构建免安装绿色目录版
npm run package:green
```

---

## 目录结构

```text
FountAIn/
├── build/                 # 应用图标（fountain.ico / fountain.png）与打包资源
├── public/                # 静态公共资源
├── scripts/               # 构建、打包、图标嵌入与冒烟检查脚本
├── src/
│   ├── main/              # Electron 主进程、窗口/托盘、安全凭据加密与桌面浮层
│   ├── preload/           # ContextBridge 安全桥接（window.fountain）
│   ├── backend/           # 独立 Worker 进程：多模型适配器、会议调度、上下文压缩、QQ Bridge、SQLite 存储
│   ├── renderer/          # React 19 前端界面：开场动画、聊天室、项目看板、立绘舞台、设置中心
│   └── shared/            # 前后端共享类型、RPC 协议定义与状态同步补丁
├── electron-builder.json  # Electron Builder 打包配置
├── package.json
└── tsconfig.json
```

---

## 许可证

本项目基于 [MIT License](./LICENSE) 开源，Copyright (c) 2026 Louisxx。
