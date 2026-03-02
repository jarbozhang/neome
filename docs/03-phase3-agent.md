# Phase 3：智能对话（约 1.5 周）

> 目标：接入 LLM Agent 做意图识别，实现 MCP 工具（菜单/订单/库存），让数字人具备咖啡店点单的专业能力。

> 前置依赖：Phase 2 全部完成（语音链路已通）。

---

## Task 3.1：LLM Agent + 系统 Prompt 设计

### 目标
实现 LLM Agent 核心模块，接入豆包大模型，设计咖啡店点单助手的系统 prompt，支持 function calling（MCP 工具调用）。

### 具体步骤
1. 在 `src/server/agent.ts` 中实现 Agent 类：
   - 初始化豆包大模型 API 客户端
   - 管理对话历史（conversation history）
   - 支持 function calling（工具调用 → 执行 → 结果回传 → 继续生成）
   - 流式输出回复文本
2. 设计系统 prompt，包含：
   - 角色设定（咖啡店点单助手）
   - 行为规范（友好、简洁、主动确认）
   - 内置菜单数据（精简版，减少 tool call 延迟）
   - 工具使用指引
3. 将 Agent 集成到 `voiceSession.ts` 的对话流程中：
   - ASR 文本 → Agent 处理 → 回复文本 → TTS

### 系统 Prompt 设计
```
你是「小Neo」，一位咖啡店的数字人点单助手。你在一家精品咖啡店工作，负责帮客人点单。

## 性格特点
- 热情友好，语气自然亲切，像一个开朗的咖啡师
- 回答简洁，每次回复不超过 2-3 句话（因为是语音交互，太长用户听着累）
- 主动引导点单流程，不让用户冷场

## 点单流程
1. 欢迎 → 询问想喝什么
2. 确认饮品 → 询问规格（大小/糖度/冰度）
3. 如有不确定 → 推荐热门或当季饮品
4. 确认订单 → 报价 → 引导支付
5. 支付完成 → 告知预计等待时间

## 规格选项
- 杯型：小杯/中杯/大杯
- 糖度：无糖/少糖/半糖/标准糖
- 温度：热/温/去冰/少冰/正常冰

## 菜单速查（常见饮品）
- 美式咖啡：小18/中22/大26
- 拿铁：小22/中26/大30
- 卡布奇诺：小24/中28/大32
- 摩卡：小26/中30/大34
- 抹茶拿铁：小26/中30/大34
- 冷萃咖啡：中28/大32
- 柠檬茶：小16/中20/大24
（完整菜单通过 query_menu 工具获取）

## 工具使用规则
- 用户问到具体菜单/价格时，优先用内置速查，复杂查询再调 query_menu
- 用户确定了要点什么，调 create_order 创建订单
- 用户要修改订单，调 modify_order
- 用户说"就这些"或"确认"，调 confirm_order
- 不要在一句话中调用多个工具

## 特殊场景
- 用户犹豫不决 → 推荐当季特饮或热门款
- 用户问非点单问题 → 简短回答后引导回点单
- 用户说"算了/不要了" → 确认是取消某一项还是整个订单
- 听不清用户说什么 → "抱歉没听清，能再说一次吗？"
```

### Agent 核心实现
```typescript
// src/server/agent.ts
interface Tool {
  name: string
  description: string
  parameters: Record<string, any>  // JSON Schema
  handler: (params: any) => Promise<any>
}

export class Agent {
  private history: Array<{ role: string; content: string }> = []
  private tools: Tool[] = []
  private systemPrompt: string

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt
  }

  registerTool(tool: Tool): void {
    this.tools.push(tool)
  }

  async processUserInput(text: string): AsyncGenerator<string> {
    this.history.push({ role: 'user', content: text })

    // 调用豆包大模型（流式 + function calling）
    const response = await callDoubaoLLM({
      model: 'doubao-pro-32k',
      messages: [
        { role: 'system', content: this.systemPrompt },
        ...this.history,
      ],
      tools: this.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      stream: true,
    })

    let fullReply = ''
    for await (const chunk of response) {
      if (chunk.choices[0].delta.tool_calls) {
        // 处理工具调用
        const toolCall = chunk.choices[0].delta.tool_calls[0]
        const tool = this.tools.find(t => t.name === toolCall.function.name)
        if (tool) {
          const result = await tool.handler(JSON.parse(toolCall.function.arguments))
          // 将工具结果加入历史，继续生成
          this.history.push({ role: 'assistant', content: '', tool_calls: [toolCall] })
          this.history.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: toolCall.id })
          // 递归继续生成（tool result → LLM → reply）
          yield* this.continueAfterTool()
          return
        }
      }
      if (chunk.choices[0].delta.content) {
        fullReply += chunk.choices[0].delta.content
        yield chunk.choices[0].delta.content
      }
    }

    this.history.push({ role: 'assistant', content: fullReply })
  }

  // 重置对话（新顾客）
  reset(): void {
    this.history = []
  }
}
```

### 验收标准
- [ ] Agent 能接收 ASR 文本并通过豆包大模型生成回复
- [ ] 回复内容符合咖啡店助手角色（友好、简洁、引导点单）
- [ ] 流式输出：用户说完后 < 1s 开始收到回复文本
- [ ] function calling 正常工作：Agent 能识别到需要调用工具的意图
- [ ] 对话历史维持：多轮对话上下文连贯
- [ ] `reset()` 后对话历史清空，开始新一轮服务

### 产出文件
```
src/server/agent.ts
src/server/voiceSession.ts         # 更新：集成 Agent
```

---

## Task 3.2：MCP 工具实现（菜单/订单/库存）

### 目标
实现 7 个 MCP 工具，覆盖咖啡店点单全流程：菜单查询、饮品推荐、订单创建/修改/确认、订单状态、库存检查。

### 具体步骤
1. 设计 SQLite 数据库 schema（`src/server/db/schema.sql`）
2. 实现数据库操作层（`src/server/db/index.ts`）
3. 实现各 MCP 工具（`src/server/tools/`）
4. 在 Agent 中注册所有工具
5. 准备种子数据（菜单初始化）

### 数据库 Schema
```sql
-- src/server/db/schema.sql

-- 菜单分类
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,           -- '咖啡', '茶饮', '果汁', '小食'
  sort_order INTEGER DEFAULT 0
);

-- 菜单项
CREATE TABLE menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL,            -- '美式咖啡'
  description TEXT,              -- '纯粹的咖啡风味...'
  price_small REAL,              -- 小杯价格
  price_medium REAL,             -- 中杯价格
  price_large REAL,              -- 大杯价格
  is_hot INTEGER DEFAULT 1,      -- 是否可做热饮
  is_cold INTEGER DEFAULT 1,     -- 是否可做冷饮
  is_available INTEGER DEFAULT 1,-- 是否在售
  tags TEXT                      -- JSON: ["热门", "当季"]
);

-- 订单
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT DEFAULT 'draft',   -- draft/confirmed/paid/making/ready/completed/cancelled
  total_price REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 订单项
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  menu_item_id INTEGER REFERENCES menu_items(id),
  name TEXT NOT NULL,
  size TEXT DEFAULT 'medium',    -- small/medium/large
  sugar TEXT DEFAULT 'standard', -- none/less/half/standard
  ice TEXT DEFAULT 'normal',     -- hot/warm/no_ice/less_ice/normal
  quantity INTEGER DEFAULT 1,
  unit_price REAL NOT NULL,
  note TEXT                      -- 特殊备注
);

-- 库存（简化版）
CREATE TABLE inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,       -- '咖啡豆', '牛奶', '抹茶粉'
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,            -- 'kg', 'L', 'g'
  low_threshold REAL NOT NULL    -- 低于此值报警
);
```

### MCP 工具定义

```typescript
// src/server/tools/menu.ts

// 工具 1: query_menu
export const queryMenuTool: Tool = {
  name: 'query_menu',
  description: '查询咖啡店菜单。可按分类筛选或按关键词搜索。',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', description: '分类名：咖啡/茶饮/果汁/小食' },
      keyword: { type: 'string', description: '搜索关键词' },
    },
  },
  handler: async ({ category, keyword }) => {
    // 查询数据库，返回匹配的菜单项列表
    // 返回格式：{ items: [{ name, description, prices: {small, medium, large}, tags }] }
  },
}

// 工具 2: recommend_drink
export const recommendDrinkTool: Tool = {
  name: 'recommend_drink',
  description: '根据条件推荐饮品。',
  parameters: {
    type: 'object',
    properties: {
      preference: { type: 'string', description: '用户偏好描述，如"不要太甜"、"提神"' },
      weather: { type: 'string', description: '天气：hot/cold/mild' },
    },
  },
  handler: async ({ preference, weather }) => {
    // 基于标签和条件过滤推荐
    // 返回格式：{ recommendations: [{ name, reason, price_medium }] }
  },
}
```

```typescript
// src/server/tools/order.ts

// 工具 3: create_order
export const createOrderTool: Tool = {
  name: 'create_order',
  description: '创建新订单。用户确定要点的饮品后调用。',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '饮品名称' },
            size: { type: 'string', enum: ['small', 'medium', 'large'], default: 'medium' },
            sugar: { type: 'string', enum: ['none', 'less', 'half', 'standard'], default: 'standard' },
            ice: { type: 'string', enum: ['hot', 'warm', 'no_ice', 'less_ice', 'normal'], default: 'normal' },
            quantity: { type: 'number', default: 1 },
          },
          required: ['name'],
        },
      },
    },
    required: ['items'],
  },
  handler: async ({ items }) => {
    // 1. 查找菜单项获取价格
    // 2. 检查库存
    // 3. 创建订单 + 订单项
    // 返回格式：{ order_id, items: [{name, size, price}], total_price }
  },
}

// 工具 4: modify_order
export const modifyOrderTool: Tool = {
  name: 'modify_order',
  description: '修改当前订单。可以添加、删除商品或修改规格。',
  parameters: {
    type: 'object',
    properties: {
      order_id: { type: 'number' },
      action: { type: 'string', enum: ['add', 'remove', 'update'] },
      item: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          size: { type: 'string' },
          sugar: { type: 'string' },
          ice: { type: 'string' },
          quantity: { type: 'number' },
        },
      },
    },
    required: ['order_id', 'action'],
  },
  handler: async ({ order_id, action, item }) => {
    // 根据 action 执行增删改
    // 返回更新后的完整订单
  },
}

// 工具 5: confirm_order
export const confirmOrderTool: Tool = {
  name: 'confirm_order',
  description: '确认订单，生成支付信息。用户说"就这些"、"确认"时调用。',
  parameters: {
    type: 'object',
    properties: {
      order_id: { type: 'number' },
    },
    required: ['order_id'],
  },
  handler: async ({ order_id }) => {
    // 1. 更新订单状态为 confirmed
    // 2. 生成支付二维码数据（模拟）
    // 返回格式：{ order_id, total_price, payment_qr: "mock://pay/...", estimated_wait: "3分钟" }
  },
}

// 工具 6: check_order_status
export const checkOrderStatusTool: Tool = {
  name: 'check_order_status',
  description: '查询订单制作进度。',
  parameters: {
    type: 'object',
    properties: {
      order_id: { type: 'number' },
    },
    required: ['order_id'],
  },
  handler: async ({ order_id }) => {
    // 返回格式：{ order_id, status, items: [...], estimated_remaining: "2分钟" }
  },
}
```

```typescript
// src/server/tools/payment.ts（未来对接真实支付时扩展）

// 目前 confirm_order 中模拟支付
// 后续可以独立为：
// - generate_payment_qr: 生成微信/支付宝支付二维码
// - check_payment_status: 轮询支付结果
```

```typescript
// 工具 7: check_inventory (内部工具，Agent 自动判断调用)
export const checkInventoryTool: Tool = {
  name: 'check_inventory',
  description: '检查原料库存是否充足。创建订单前自动检查。',
  parameters: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'string' }, description: '要检查的原料名列表' },
    },
  },
  handler: async ({ items }) => {
    // 查询库存表
    // 返回格式：{ available: true, low_stock: ["牛奶"] }
  },
}
```

### 种子数据
在 `src/server/db/seed.ts` 中准备初始菜单和库存数据，服务启动时自动插入。

### 验收标准
- [ ] 数据库初始化成功，`menus` 表包含至少 10 种饮品
- [ ] 对数字人说"有什么推荐的吗" → Agent 调用 `recommend_drink` → 返回推荐
- [ ] 说"我要一杯中杯拿铁，少糖" → Agent 调用 `create_order` → 返回订单信息和价格
- [ ] 说"再加一杯美式" → Agent 调用 `modify_order(action: add)` → 订单更新
- [ ] 说"把拿铁去掉" → Agent 调用 `modify_order(action: remove)` → 订单更新
- [ ] 说"就这些" → Agent 调用 `confirm_order` → 返回总价和支付引导
- [ ] 说"我的单好了吗" → Agent 调用 `check_order_status` → 返回进度
- [ ] 库存不足时（手动设为 0），Agent 提示"抱歉，XX 暂时缺货"

### 产出文件
```
src/server/db/schema.sql
src/server/db/index.ts              # 数据库初始化 + 查询函数
src/server/db/seed.ts               # 种子数据
src/server/tools/index.ts           # 工具注册
src/server/tools/menu.ts            # query_menu + recommend_drink
src/server/tools/order.ts           # create_order + modify_order + confirm_order + check_order_status
src/server/tools/inventory.ts       # check_inventory
src/server/agent.ts                 # 更新：注册所有工具
```

---

## Task 3.3：对话上下文管理 + 多轮对话

### 目标
确保多轮对话上下文连贯，支持跨轮次引用（"把刚才那个换成大杯"），以及顾客切换时的 session 重置。

### 具体步骤
1. 在 Agent 中实现对话上下文窗口管理：
   - 保留最近 20 轮对话历史
   - 超过窗口时，保留系统 prompt + 最近 N 轮 + 当前订单摘要
2. 维护当前 session 的订单状态：
   - `currentOrderId`: 当前正在操作的订单 ID
   - 每次工具调用后更新
   - Agent 可以引用当前订单而不需要用户重复
3. 实现 session 重置逻辑：
   - 订单完成（支付成功）后，3 秒等待 → 自动重置
   - 用户离开（MediaPipe 检测不到人脸超过 10 秒）→ 重置
   - 手动重置按钮（debug 用）

### 上下文摘要生成
```typescript
// 当对话历史超过窗口时，生成摘要替代早期对话
function generateOrderSummary(orderId: number): string {
  const order = db.getOrder(orderId)
  if (!order) return ''
  return `[当前订单 #${order.id}]：` +
    order.items.map(i => `${i.name}(${i.size}/${i.sugar}/${i.ice}) x${i.quantity}`).join('、') +
    `，总价 ¥${order.total_price}，状态：${order.status}`
}
```

### 验收标准
- [ ] 连续多轮对话上下文连贯：先点一杯拿铁 → 再说"换成大杯" → Agent 理解是修改拿铁
- [ ] 对话中间可以插入无关话题（"你叫什么名字"），然后回到点单，上下文不丢失
- [ ] 订单完成后，对话历史自动清空，下一位顾客从头开始
- [ ] 超长对话（20+ 轮）不会导致 token 超限或性能下降

### 产出文件
```
src/server/agent.ts                # 更新：上下文管理 + session 重置
src/server/voiceSession.ts         # 更新：session 生命周期
```

---

## Phase 3 里程碑验收

完成以上 3 个 Task 后，应该达到：

1. ✅ 数字人具备咖啡店专业知识，能引导点单
2. ✅ 完整点单流程可运行：推荐 → 选择 → 定制规格 → 确认 → 支付
3. ✅ 多轮对话上下文连贯
4. ✅ 订单数据持久化到 SQLite

**端到端测试场景（完整点单）：**
```
用户：有什么推荐的吗
助手：今天推荐我们的招牌拿铁，奶泡绵密，26块中杯。要来一杯吗？

用户：好的，要一杯中杯拿铁，少糖
助手：好的，一杯中杯拿铁少糖，26块。还要别的吗？

用户：再来一杯美式，大杯
助手：好的，加一杯大杯美式26块。现在一共两杯，52块。还需要什么？

用户：就这些
助手：好的，一杯中杯拿铁少糖26块，一杯大杯美式26块，总共52块。请扫码支付~

（屏幕显示支付二维码）

用户：好了
助手：收到付款啦！预计3分钟出杯，请稍等~

（10秒后无人脸 → 重置 → 等待下一位）
```
