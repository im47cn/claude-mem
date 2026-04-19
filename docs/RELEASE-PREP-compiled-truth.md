# Release Prep: Compiled Truth Synthesis Layer

**Branch**: `feat/compiled-truth-001`
**Version target**: `12.2.0` (minor — new feature, no breaking changes)
**Status**: Draft / In Review

---

## ✅ 已完成

### 核心功能
- `compiled_summaries` 表创建（migration 26）
- v28 migration：`is_stale` + `observation_count` 列（SessionStore + runner.ts 双路径）
- `src/services/sqlite/compiled-summaries/` 模块：store / get / compiler / index
- `CompiledRoutes.ts` 10 个 REST 端点，全部验证通过
- Worker 接入：`worker-service.ts` 注册 `CompiledRoutes`
- 增量编译逻辑：skip when no new observations + not stale
- 本地合成（`localSynthesize`）无 AI 可用时 fallback
- CLAUDE.md 记录双 migration 路径架构

### Bug 修复（TDD 驱动）
- `cleanup.ts`：LIKE `%id%` 误匹配 → JSON 边界模式
- `clustering.ts`：`inferEntityType` 缺少 `'preference'` 分支
- `SynthesizeRoutes.ts`：`JSON.parse` 无 try/catch
- `refresh.ts`：`ChromaSync.syncSingleRecord` 不存在 → stub
- `DreamCycleRunner.ts`：`running=true` 泄漏 + finally 异常处理
- `synthesizer-providers.ts`：30s timeout + 401/403 error 级别日志

### 测试
- 66 个 dream cycle 测试全部通过
- 1433 pass / 17 fail（比基线少 1 个失败）

---

## 🔴 阻断性问题（发布前必须修复）

### 1. 两套 CompiledSummary 实现未打通

**问题**：存在两个平行实现，写入路径不同，`observation_count` 和 `is_stale` 只有新路径才设置：

```
Dream Cycle 写入路径（现有）：
  DreamCycleRunner → CompiledSummaryStore.upsert()
  文件：src/services/worker/search/compiled-summaries.ts
  ⚠️  不设置 observation_count（从 JSON 解析计算）
  ⚠️  不设置 is_stale = 1（旧记录永远不会变 stale）

HTTP API 读取路径（新增）：
  CompiledRoutes → sqlite/compiled-summaries/{store,get,compiler}.ts
  ✅ 设置 observation_count
  ✅ 支持 is_stale 查询和标记
```

**影响**：`GET /api/compiled-summaries/stats` 的 `stale` 计数永远是 0（除非手动 POST mark-stale），因为梦境周期写入的记录不走新路径。

**修复方案**：让 `CompiledSummaryStore.upsert()` 也设置 `observation_count`，并在新 observations 进来时调用 `markStaleById()`（可在 `ThresholdTrigger` 或 `DreamCycleRunner` 里加）。

---

### 2. `compiled_summaries_fts` FTS5 表未创建

**问题**：`searchCompiledSummaries()` 优先使用 FTS5，但该虚拟表从未在任何 migration 中创建。搜索静默降级到 LIKE，无错误提示。

**影响**：搜索精度和性能不如预期；用户无感知。

**修复方案**：在 v28 migration 中（`addCompiledSummariesColumns`）同时创建：
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS compiled_summaries_fts
USING fts5(topic, compiled_text, content=compiled_summaries, content_rowid=id);
```
同时在 `refresh.ts` 的 `rebuildFts5Index()` 里加上 compiled_summaries_fts 的重建。

---

### 3. `get.ts` 导入 `logger` 但从未使用

**问题**：为通过 logger 覆盖率测试而添加，但函数内无任何 `logger.xxx()` 调用。

**影响**：TypeScript strict 模式下会报 `TS6133: 'logger' is declared but its value is never read`；若未来开启 `noUnusedLocals` 则构建失败。

**修复方案**：在 `searchCompiledSummaries` 的 FTS5 fallback 处加一条 debug 日志：
```typescript
logger.debug('COMPILED', 'FTS5 not available, falling back to LIKE search');
```

---

## 🟡 高优先级（建议发布前完成）

### 4. 缺少新模块的单元测试

| 模块 | 测试文件 | 状态 |
|------|---------|------|
| `sqlite/compiled-summaries/store.ts` | 无 | ❌ |
| `sqlite/compiled-summaries/get.ts` | 无 | ❌ |
| `sqlite/compiled-summaries/compiler.ts` | 无 | ❌ |
| `CompiledRoutes.ts` | 无 | ❌ |

注：`tests/worker/search/compiled-summaries.test.ts`（17 tests）测试的是旧的 `CompiledSummaryStore` 类，不是新模块。

### 5. is_stale 自动化触发机制缺失

`is_stale` 只能通过 `POST /api/compiled-summary/:id/mark-stale` 手动设置。  
新 observations 进来时，相关 compiled summaries 应自动标为 stale。  
触发点建议：`SessionStore.storeObservation()` → 查询涉及的 topics → `markStaleById()`

---

## 🟢 低优先级（可在后续迭代）

### 6. 预存 DB 记录含控制字符

`/api/health` 和 `/api/synthesize/status` 响应在 byte 200 处有 `\n`（0x0a），导致客户端 JSON.parse 失败。这是旧 DB 记录的历史遗留，不影响新写入。

### 7. 公开文档未更新

`docs/public/` 中无 compiled summaries API 说明。需要添加：
- 新端点列表和参数
- 工作原理（observation → cluster → compile 流程图）
- 触发方式（dream cycle / 手动 POST）

### 8. 两套实现的长期归宿

`src/services/worker/search/compiled-summaries.ts`（`CompiledSummaryStore` 类）和  
`src/services/sqlite/compiled-summaries/`（函数式 API）长期应合并为一套。  
当前可共存，但需决策：是否迁移 dream cycle 使用新路径？

---

## 发布 checklist

- [ ] 修复阻断性问题 #1（observation_count + is_stale 写入路径打通）
- [ ] 修复阻断性问题 #2（创建 compiled_summaries_fts）
- [ ] 修复阻断性问题 #3（logger 实际使用）
- [ ] 单元测试覆盖新模块（至少 store.ts + CompiledRoutes.ts）
- [ ] `npm version minor` → 12.2.0
- [ ] `npm run changelog:generate`
- [ ] `npm run build-and-sync` 最终 build
- [ ] 全量测试通过（1430+ pass）
- [ ] PR 从 draft 转 ready for review
