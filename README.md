<p align="center">
  <img src="assets/logo.svg" width="120" height="120" alt="InkOS Logo">
  <img src="assets/inkos-text.svg" width="240" height="65" alt="InkOS">
</p>

<h1 align="center">Autonomous Novel Writing AI Agent<br><sub>自动化小说写作 AI Agent</sub></h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@actalk/inkos"><img src="https://img.shields.io/npm/v/@actalk/inkos.svg?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://github.com/Narcooo/inkos/stargazers"><img src="https://img.shields.io/github/stars/Narcooo/inkos?style=flat&logo=github&color=yellow" alt="GitHub stars"></a>
  <a href="https://www.npmjs.com/package/@actalk/inkos"><img src="https://img.shields.io/npm/dm/@actalk/inkos?color=cb3837&logo=npm&label=downloads" alt="npm downloads"></a>
  <a href="https://clawhub.ai/narcooo/inkos"><img src="https://img.shields.io/badge/ClawHub-Skill-FF6B35?labelColor=1a1a1a" alt="ClawHub Skill"></a>
</p>

<p align="center">
  <a href="README.en.md">English</a> | 中文 | <a href="README.ja.md">日本語</a>
</p>

---

InkOS 是面向小说创作的本地 AI 写作工作台和 CLI。它可以写长篇连载，也可以一次生成独立短篇；可以从 Studio Chat 里自然语言操作，也可以用命令行批量跑；可以生成正文、大纲、审稿记录、简介卖点和封面提示词，配置封面服务后还能生成封面图。

当前重点：

- **InkOS Short**：独立短篇生产，从一句方向生成完整短篇、简介卖点、封面提示词和封面图。
- **长篇连载管线**：按章节持续创作，先规划本章意图，再选择上下文，再写正文、审稿、最多自动修一次。
- **Studio Chat 协作**：普通聊天有持久化 session，可以讨论、改生成物、预览短篇和封面，不需要绕回复杂命令。
- **模型配置**：Studio 内置服务配置、聚合 API 入口和自定义 OpenAI-compatible 服务；CLI 可复用 Studio 配置，也支持 env/命令行覆盖。

## InkOS Short

<p align="center">
  <img src="assets/inkos-short-demo-cover.png" width="360" alt="InkOS Short 短篇封面示例">
</p>

短篇不只是“写一章试试”，而是一个完整交付包：

- `full.md`：完整短篇正文
- `outline.md` / `review.md`：故事方案和审稿记录
- `sales-package.md`：简介、卖点、推荐语
- `cover-prompt.md` / `cover.png`：封面提示词和封面图

开篇效果示例：

> 宋词三个多月没坐过这辆车了。蓝牙自动连上她的手机，屏幕弹出“子账号登录中”。她点进常用地址统计：新城花园 187 次，妇幼医院 38 次，月子中心 9 次。后备箱传来闷响，徐晋安放完东西坐进来，冲她笑笑：“今晚加班，你自己打车回去？”她抬头看他，也笑了。

在 Studio Chat 里可以直接说：

```text
写一篇 12 章短篇，方向是：都市婚姻反转，女主发现导航记录后反杀。
```

也可以走 CLI：

```bash
inkos short run \
  --direction "都市短篇 婚姻反转 女主发现证据后反杀" \
  --chapters 12 \
  --chars 1000
```

只做封面时，不需要重跑正文：

```text
给《她签下离婚协议那天，他悔疯了》生成一张短篇封面，偏现代都市、强反转。
```

## 快速开始

### 安装

```bash
npm i -g @actalk/inkos
```

### 启动 Studio

```bash
inkos init my-novel
cd my-novel
inkos
```

打开本地 Studio 后，先进入「模型配置」设置服务和 API Key，再回到「普通聊天」或书籍页面开始创作。Studio 配置保存在项目内，升级后会继续复用。

如果需要聚合 API，Studio 模型配置里内置 [kkaiapi](https://kkaiapi.com/) 和 [OpenRouter](https://openrouter.ai/)，也支持自定义 OpenAI-compatible 服务。

### 写第一本长篇

```bash
inkos book create --title "吞天魔帝" --genre xuanhuan
inkos write next 吞天魔帝
inkos status
inkos export 吞天魔帝 --format epub
```

### 通过 OpenClaw 使用

InkOS 已发布为 [OpenClaw](https://clawhub.ai/narcooo/inkos) Skill。通过 npm 安装或克隆本项目时，`skills/SKILL.md` 已包含在内；也可以在 ClawHub 搜索 `inkos`。

推荐外部 Agent 走共享交互入口：

```bash
inkos interact --json --message "继续当前书，但把节奏再收紧一点"
```

`plan chapter`、`compose chapter`、`draft`、`audit`、`revise`、`write next` 这些原子命令仍然保留，适合脚本和精细调试。

## Studio Chat

Studio Chat 是编辑协作入口：InkOS 负责写，Chat 负责讨论、查看、修改持久化生成物，然后再决定是否继续生成。

它可以做这些事：

- 直接创建长篇书籍或生成独立短篇。
- 读取、编辑、重写 `books/`、`shorts/`、`covers/`、`genres/` 下的文本生成物。
- 修改章节、简介、封面提示词、题材文件，并同步必要的索引或状态。
- 预览短篇产物和封面图。
- 保存普通聊天 session，刷新或升级后继续对话。

它更像你和系统之间的编辑台：不满意就讨论、改文件、再让 InkOS 继续生成。

## 长篇写作管线

长篇默认走“输入治理 -> 写作 -> 审稿 -> 最多一轮修订”：

1. **Architect**：建书、导入或番外初始化时生成基础设定、角色和规则。
2. **Planner**：读取作者意图、当前焦点和记忆检索结果，生成本章意图。
3. **Composer**：从长期记忆和控制文件中选择本章上下文，生成 `context.json`、`rule-stack.yaml`、`trace.json`。
4. **Writer**：基于本章意图和精简上下文写正文。
5. **Auditor / Reviser**：审稿并最多自动修一次；仍有问题会记录下来，交给人工或后续命令处理。
6. **Observer / Reflector**：从正文中提取事实变化，写入结构化状态，再投影成人类可读 Markdown。

`plan chapter` 会调用 LLM 生成章节意图；`compose chapter` 只编译本地文档和状态，可在 API Key 配好前检查上下文选择是否合理。

```bash
inkos plan chapter 吞天魔帝 --context "本章先把注意力拉回师徒矛盾"
inkos compose chapter 吞天魔帝
inkos write next 吞天魔帝
```

## 长期记忆与控制文件

每本书有结构化状态和人类可读投影两层：

- `story/state/*.json`：代码真正信任的结构化状态，写入前做 schema 校验。
- `story/*.md`：给人读、给人改的投影文件。
- `story/author_intent.md`：这本书长期想成为什么。
- `story/current_focus.md`：最近 1-3 章要把注意力拉回哪里。
- `story/runtime/chapter-XXXX.*`：本章计划、上下文、规则栈和 trace。
- `story/memory.db`：SQLite 时序记忆数据库，用于按相关性检索历史事实。

这套设计的目标是减少“真相文件越写越大、上下文越塞越慢”的问题：默认不是把所有材料一股脑塞给模型，而是先选上下文，再写。

## 配置模型

Studio 推荐使用「模型配置」页面；CLI 和 daemon 可以复用 Studio 配置，也可以通过 env 或命令参数覆盖。

全局配置：

```bash
inkos config set-global \
  --provider <openai|anthropic|custom> \
  --base-url <API 地址> \
  --api-key <你的 API Key> \
  --model <模型名>
```

项目内也可以通过 Studio 保存服务配置。CLI 合成顺序大致是：

```text
Studio/project service 配置
-> .inkos/secrets.json service key
-> global ~/.inkos/.env
-> project .env
-> 当前进程环境变量
-> CLI 参数
```

常用排查：

```bash
inkos doctor
inkos config show
inkos config show-models
```

给不同环节设置不同模型：

```bash
inkos config set-model writer <model> --provider <provider> --base-url <url> --api-key-env <ENV_VAR>
inkos config set-model auditor <model> --provider <provider>
```

## 能力概览

- **长篇连载**：持续写章、审稿、修订、状态同步、导出 TXT/MD/EPUB。
- **独立短篇**：一次生成完整短篇、销售包装和封面资产。
- **封面制作**：可单独生成封面提示词和封面图，也可随短篇一起生成。
- **续写导入**：`inkos import chapters` 导入已有章节并逆向建立状态。
- **同人创作**：`inkos fanfic init` 从原作素材创建正典延续、AU、OOC、CP 等模式。
- **文风仿写**：`inkos style analyze/import` 提取并注入参考文本风格。
- **题材管理**：内置题材可复制到项目内修改，也可创建自定义题材。
- **市场雷达**：可扫描外部趋势，作为创作方向输入。
- **守护进程**：`inkos up/down` 后台运行，日志写入 `inkos.log`。
- **本地/自定义服务**：支持 OpenAI-compatible、本地模型和聚合模型服务。

## 命令参考

| 命令 | 说明 |
|------|------|
| `inkos init [name]` | 初始化项目 |
| `inkos` / `inkos studio` | 启动 Studio Web 工作台 |
| `inkos book create` | 创建新书，支持 `--genre`、`--brief`、`--chapter-words` |
| `inkos book list/update/delete` | 管理书籍 |
| `inkos write next [id]` | 写下一章，支持 `--count`、`--words` |
| `inkos write rewrite [id] <n>` | 重写指定章节 |
| `inkos write sync [id]` | 手工编辑章节后同步状态 |
| `inkos plan chapter [id]` | 生成下一章意图 |
| `inkos compose chapter [id]` | 编译下一章上下文和规则栈 |
| `inkos draft/audit/revise` | 分别执行草稿、审稿、修订 |
| `inkos short run` | 生成完整短篇和销售包装，可选封面图 |
| `inkos agent <instruction>` | 自然语言 Agent 模式 |
| `inkos interact --json --message <text>` | 共享交互入口，适合 Studio/OpenClaw/外部 Agent |
| `inkos review list/approve/reject` | 审阅与批准章节 |
| `inkos export [id]` | 导出书籍，支持 TXT/MD/EPUB |
| `inkos import chapters` | 导入已有章节续写 |
| `inkos fanfic init` | 创建同人书 |
| `inkos style analyze/import` | 分析并导入文风 |
| `inkos genre list/show/copy/create` | 查看和管理题材 |
| `inkos radar scan` | 市场雷达扫描 |
| `inkos config set-global/show-global` | 管理全局 CLI 配置 |
| `inkos config set-model/show-models/remove-model` | 管理 agent 模型路由 |
| `inkos doctor` | 诊断配置和连通性 |
| `inkos up/down` | 启动或停止守护进程 |
| `inkos update` | 更新到最新版本 |

所有命令支持在单书项目中省略 `[id]`。常用写作命令支持 `--json`，方便外部工具组合。

## 开发

```bash
pnpm install
pnpm dev
pnpm test
pnpm typecheck
```

欢迎提 issue 或 PR。

## 许可证

[AGPL-3.0](LICENSE)

## 欢迎交流

> 当前更新相对频繁，后续会持续新增功能与优化写作效果。欢迎加群反馈问题、提出需求，也欢迎关注项目动态。

<p align="center">
  <img src="assets/15qun.jpg" width="300" alt="微信交流群">
</p>

## Star History

<a href="https://www.star-history.com/#Narcooo/inkos&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Narcooo/inkos&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Narcooo/inkos&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Narcooo/inkos&type=date&legend=top-left" />
 </picture>
</a>
