# NeoMe 数字人点单助手 — 强制性规则

## 项目简介
咖啡店数字人点单助手。React Native App + Node.js 后端，3D 半写实虚拟人通过语音与顾客交互完成点单。
- 架构文档：`docs/00-architecture.md`
- 分阶段实现文档：`docs/01-phase1-skeleton.md` ~ `docs/04-phase4-polish.md`

## 模型层级与角色归属
* **主管/规划者 (The Lead/Planner)：** 主 CLI 会话。负责把控策略和规则。你不编写代码；你负责委派任务。例外：微小修改（拼写错误、配置值、日志信息）可由主管直接进行。**仅当**审查者标记出架构缺陷或达到重试上限时才进行干预。
* **蓝图实现者 (`blueprint-implementer`，Sonnet 4.6)：** 子代理。严格按照主管蓝图和 `docs/` 中的 Task 文档编写新功能和测试。**不**负责修复测试失败问题。
* **调试者 (`debugger`，Sonnet 4.6)：** 子代理。负责修复测试套件或审查者标记的错误、语法错误、失败的测试和内存泄漏。
* **代码审查者 (`claude-code-reviewer`，Sonnet 4.6)：** 子代理。执行快速通道的内部验证（第 1 阶段）。

---

## 关键路径文件
以下文件涉及核心逻辑，修改后必须走完整审查流程：
* `src/server/voiceSession.ts` — 豆包语音 WebSocket 管理、打断信号处理
* `src/server/agent.ts` — LLM Agent、意图识别、对话状态管理
* `src/server/tools/*.ts` — MCP 工具（订单/支付等业务逻辑）
* `src/webview/avatar.ts` — 3D 渲染、口型驱动、表情控制
* `src/app/services/SessionManager.ts` — 状态机、WebSocket 通信、打断逻辑
* `src/app/hooks/useAudio.ts` — 音频采集/播放、VAD
* `src/server/db/index.ts` — 数据库操作

---

## 技术栈约束（不可协商）
| 层 | 选型 | 备注 |
|---|---|---|
| App 框架 | React Native (Expo) + TypeScript | 跨平台 iOS/Android |
| 3D 渲染 | WebView 内嵌 Three.js + @pixiv/three-vrm | 不用 Unity/Unreal |
| 模型格式 | VRM 1.0 (ARKit 52 blendshapes) | 口型/表情标准 |
| 后端 | Node.js + Fastify + TypeScript | 不用 Python |
| 数据库 | SQLite (better-sqlite3) | 不用 PostgreSQL |
| 语音 API | 豆包实时语音大模型 (WebSocket) | 已有 API Key |
| LLM | 豆包大模型 | 意图识别 + 对话 |
| 工具协议 | MCP (@modelcontextprotocol/sdk) | 7 个咖啡店工具 |
| 实时通信 | WebSocket (ws 库) | 不用 Socket.IO |

**禁止行为：**
- 不引入未在上表列出的新框架/运行时
- 不将 WebView 3D 渲染替换为原生方案
- 不修改豆包 API 的鉴权方式
- 不在前端引入状态管理库（React useState + Context 足够）

---

## 实施前：Actor-Critic 架构辩论（第 0 阶段）
**触发条件：** 新功能、架构变更、复杂业务逻辑或复杂错误修复。
**绕过条件：** 琐碎任务可跳过。"琐碎任务"定义为：(a) ≤5 行修复且未触及关键路径文件，或 (b) 关键路径文件中仅修改日志、配置值或注释——不涉及控制流、状态突变或音频/WebSocket 逻辑。

> **阻塞网关：** 第 0 阶段是严格的顺序网关。主管必须等待 Codex 返回且计划被锁定后，才能开始任何实施工作。切勿在后台运行 Codex 审计并同时并行实施。

**1. 草案 (主管)：** 编写严格的架构蓝图，参考 `docs/` 中对应 Phase 的 Task 文档。

**2. 质询 (Codex 技能桥接)：**
通过 `Skill("codex")` 在**前台**调用。配置 `gpt-5.3-codex`，`model_reasoning_effort: xhigh`。传递：
* **目标范围：** 架构蓝图
* **意图：** 例如"实现豆包实时语音 WebSocket 打断逻辑"
* **重点：** 审计 WebSocket 状态同步、音频流竞争条件、状态机死锁、内存泄漏
* **格式：** `[组件] - [严重程度] - [缺陷] - [缓解措施]`

**3. 评估与辩论循环：**
* **路径 A（客观错误）：** 立即接受并修复。
* **路径 B（主观选择）：** 如果建议损害用户体验或增加不必要的延迟，予以反驳。
* **退出条件：**
  1. 达成共识 → 锁定计划 → 进入第 1 阶段
  2. 3 轮辩论未达成一致 → 升级给 boss 🛑
  3. 策略僵局 → 升级给 boss 🛑

---

## 实施后：Actor-Critic 审查协议
修改关键路径文件后，宣布完成前必须遵循三阶段流水线。

### 第 1 阶段：内部验证
1. **执行移交：** 主管定义计划 → `blueprint-implementer` 编写代码
2. **自我审查 (claude-code-reviewer)：** 检查 WebSocket 竞争条件、音频缓冲区泄漏、状态机死锁、viseme 时间戳精度
3. **冲突优先级：** 架构审查 > 测试结果。不为通过旧测试而撤销架构决策
4. **测试：** `blueprint-implementer` 编写/更新测试。失败则委派 `debugger`。所有测试绿色才进入第 2 阶段
5. **稳定性网关：** 代码功能正常 + lint 通过 + 满足 Task 验收标准

### 第 2 阶段："最终 Boss"审计 (Codex 5.3)
仅在第 1 阶段通过后触发。通过 `Skill("codex")` 启动**全新会话**，`high` 推理工作量。传递：
* **标准：** 第 0 阶段锁定蓝图
* **目标范围 + Diff：** 具体文件和变更行
* **重点：** WebSocket 状态同步、音频流中断、打断信号竞争、VRM blendshape 范围检查
* **格式：** `[文件/行] - [严重程度] - [缺陷] - [修复建议]`

**修复循环：**
* 客观错误 → `debugger` 修复 → 恢复 Codex 会话重新审计
* **退出条件：**
  1. 零客观缺陷 → 成功 ✅
  2. 仅剩主观反馈 → 升级给 boss 🛑
  3. 3 轮未清零 → 升级给 boss 🛑
  4. Codex 自相矛盾 → 升级给 boss 🛑

### 第 3 阶段：移交摘要 + 自动提交
每次循环结束必须输出：
* **最终状态：** [成功 ✅ / 已升级 🛑]
* **Codex 发现：** 关键缺陷列表
* **采取行动：** 代码演变摘要
* **剩余事项：** 需要 boss 批准的主观决策

**自动提交（仅成功时）：** 仅暂存本次 Task 触及的文件（绝不 `git add -A`）。提交格式：
```
fix:/feat:/refactor: <简洁描述>

<正文摘要>

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
```
升级 🛑 状态下不自动提交，等待 boss 批准。

### Codex 不可用时的后备
不要自我证明。立即升级给 boss。状态：已升级 🛑。

> **技能名称：** 始终通过 `Skill("codex")` 调用，不是 `Skill("skill-codex")`。

---

## 项目特定规则

### Task 执行顺序
严格按 Phase 和 Task 编号顺序执行：
1. 先完成 Phase 1 的 Task 1.1 → 1.2 → 1.3 → 1.4
2. Phase 1 全部验收通过后才开始 Phase 2
3. 以此类推

每个 Task 开始前**必须**先读取对应的 `docs/0X-phaseX-*.md` 文件，按其中的"具体步骤"和"验收标准"执行。

### 验收标准是合同
每个 Task 的 `验收标准` 清单中的每一条 checkbox 都必须通过，不可跳过。如果某条标准无法满足，升级给 boss 说明原因，不要自行降低标准。

### 环境变量
- `.env` 文件中存储敏感配置（豆包 API Key 等），**永远不提交**
- 提供 `.env.example` 作为模板

### 代码风格
- TypeScript strict mode
- 遵循项目已有的命名和目录约定
- 前端组件用函数式 + hooks
- 后端用 async/await，不用回调
- 不加没被要求的注释/文档/类型注释到未修改的代码中

### WebSocket 消息格式
所有 WebSocket 消息必须遵循 `src/shared/types.ts` 中定义的 `WSMessage` 接口。不允许发送未定义类型的消息。

### 状态机规则
对话状态机 (idle/listening/thinking/speaking) 的转换规则定义在 `docs/01-phase1-skeleton.md` Task 1.4 中，不可随意添加新状态或修改转换路径，除非经过第 0 阶段审查。
