# 三层治理体系：DAG 静态审查 + 命令防抖 + 验证锁路径归一化

## 背景

从运行截图和日志中诊断出三个系统性风险：

1. **DAG 生成质量不可控**：Planner 模型可能生成非标准节点（如 `example.txt`）或越序命令（如 `npm install vue@2.7.16`），系统不做任何静态审查直接进入执行。
2. **工具执行缺乏同命令防抖**：`start_background_task npm run dev` 被反复执行 7+ 次，每次秒退。虽然终端层有 FAST_FAIL_BREAKER，但 DAG 执行循环中没有对应的秒退熔断处理。
3. **验证锁路径归一化缺失**：`ctx.createdFiles` 存的是相对路径（如 `package.json`），而文件实际在 `vue2-project/package.json`。验证层的 `fileExistsInCreated` 用 `endsWith` 匹配，当路径不含 `targetDir` 前缀时无法命中。

## 第一层：DAG 静态审查（新增 dagValidator.ts）

### 新建文件

`src/main/ai/dagValidator.ts`：纯函数，接收 `TaskDag` + `ProjectProfile` + `targetDir`，返回审查结果。

验证规则：
- 禁止的文件名模式：`/(^|\/)(example|test|temp|tmp|demo|sample)\.(txt|md|json|js|ts)$/i`
- 禁止的命令模式：
  - `npm install <pkg>@<ver>` → 应通过 `package.json` 声明依赖
  - `npm install -g` → 禁止全局安装
  - `npm init/create` → 禁止生成空壳清单，必须用 `write_file`
- 关键产物节点检查：从 `ProjectProfile` 的 `dependencyManifest` + `configFiles` + `sourceDir` 推断关键文件列表，检查 DAG 中是否包含对应 `write_file` 节点

### 挂接点

`scheduler.ts` 的 `generateDagPlan` 返回后（L600 附近）：

```typescript
const dagValidation = validateDagStatic(dagResult.dag, ctx.projectProfile, dagResult.targetDir)
if (!dagValidation.ok) {
  console.warn('[TraeCode] DAG 静态审查未通过:', dagValidation.error)
  events?.onFallback?.('dag', 'plan-text', `DAG 审查失败：${dagValidation.error}`)
  return { ok: false }
}
```

## 第二层：工具执行同命令防抖 + FAST_FAIL_BREAKER

### 同命令防抖（runWithDag 循环）

在 `runWithDag` 的工具执行循环（L3397 附近）新增 `commandHistory` Map（命令 → 60 秒内时间戳数组）。

在 `start_background_task` / `run_terminal_command` 执行前插入检查：

```typescript
if ((name === 'start_background_task' || name === 'run_terminal_command') && cmd) {
  if (isCommandThrottled(cmd)) {
    const block = `错误：【防抖拦截】${cmd} 在 60 秒内已被执行 2 次且均秒退...`
    markFailed(dagState, matchedNode.id, block)
    convo.push({ role: 'tool', content: block, name } as AiMessage)
    events?.onToolResult?.(name, block)
    batchInterrupted = true
    break
  }
  recordCommand(cmd)
}
```

### FAST_FAIL_BREAKER（runWithDag 循环）

当前 `runWithTools` 有 FAST_FAIL_BREAKER 处理（L2294），但 `runWithDag` 没有。在 `runWithDag` 的工具结果后增加：

```typescript
if ((name === 'bash' || name === 'run_terminal_command' || name === 'start_background_task') 
    && result.includes(FAST_FAIL_BREAKER_TAG)) {
  noteFailure(replanState, 'commandFailure', `${cmd || name}\n秒退熔断`)
  convo.push({ role: 'tool', content: result, name } as AiMessage)
  events?.onToolResult?.(name, result)
  convo.push({
    role: 'user',
    content: '⛔ 秒退熔断：命令在 1 秒内崩溃退出...'
  } as AiMessage)
  batchInterrupted = true
  break
}
```

### 工具成功后追踪状态（runWithDag 循环）

当前 L3527-3535 只追踪 `bash` / `run_terminal_command`，需要加入 `start_background_task`：

```typescript
if (name === 'start_background_task' || name === 'bash' || name === 'run_terminal_command') {
  if (/\bnpm\s+(install|i|ci)\b/.test(cmd)) ctx.ranNpmInstall = true
  if (/\bnpm\s+run\s+(serve|dev|start)\b/.test(cmd)) {
    ctx.ranServe = true
    lastServeCmd = cmd
    lastServeOutput = result
  }
}
```

## 第三层：验证锁路径归一化

### 根因

`createdFiles` 在 `runWithDag` 中存的是 `args.path`（如 `package.json`），但验证锁 `fileExistsInCreated` 比较的是 `targetDir` 前缀路径（如 `vue2-project/package.json`）。

### 修复方案

修改 `validateTaskCompletion`（scheduler.ts L3089-L3114）：

```typescript
export function validateTaskCompletion(ctx: PromptContext): string | null {
  // ... manifest 选择逻辑不变 ...
  
  // 路径归一化：如果 targetDir 存在，把相对路径拼接为 targetDir 前缀路径
  const targetDir = ctx.targetDir
  const createdFiles = targetDir
    ? new Set(
        Array.from(ctx.createdFiles).map((p) => {
          const norm = p.replace(/\\/g, '/')
          // 如果路径已包含 targetDir 前缀或是绝对路径，保持原样
          if (norm.includes('/') && !norm.startsWith(targetDir + '/')) {
            return norm
          }
          return `${targetDir}/${p}`
        })
      )
    : ctx.createdFiles

  const vctx: ValidationContext = {
    createdFiles,
    executedCommands,
    workspace: ctx.workspace ?? undefined
  }
  const summary = runValidation(manifest, vctx)
  return summary.message
}
```

同理修改 `getValidationState`（L3063-L3082）以保持一致。

## 关键文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/main/ai/dagValidator.ts` | 新建 | DAG 静态审查器 |
| `src/main/ai/scheduler.ts` | 修改 | 挂接审查器、防抖、FAST_FAIL_BREAKER、路径归一化 |
| `src/shared/projectProfiles.ts` | 可能修改 | 添加 `keyFiles` 字段（或从现有字段推断） |

## 验证

1. `npx tsc --noEmit` 零错误
2. `npx vitest run` 全量通过
3. 单元测试：新增 `dagValidator.test.ts` 验证禁止模式拦截
