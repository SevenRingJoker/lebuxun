# SPEC-CHANGELOG

> 规格偏差记录。SPEC.md 本身不修改，所有实现期偏差在此登记。

## 2026-10-16

1. **包管理器**：SPEC 任务 1.1 要求 `pnpm dev`，但实施环境无 pnpm。改用 **npm workspaces**（Node 24 自带），`npm run dev` 等价启动。
2. **better-sqlite3 版本**：SPEC 13.1 锁定 `^11`，但 better-sqlite3 v11 无 Node 24 prebuild（Windows 需 VS Build Tools 源码编译）。升级为 `^12`（官方支持 Node 24 prebuild），API 兼容。
3. **npm 11.19 allowScripts**：本环境 npm 默认拦截第三方 install scripts（better-sqlite3 / electron / esbuild 的原生安装）。需 `npm install-scripts approve <pkg>` 后 `npm rebuild <pkgs>` 一次；CI/新机器同理。Electron 33.4.11 二进制直连下载成功，未启用 ELECTRON_MIRROR。
4. **vram-monitor 总量**：SPEC 未规定显存总量获取方式；Windows 11 无可靠纯 JS 途径（wmic 已弃用），按任务约定用 `os.totalmem()`（系统内存）估算并在返回值 `source` 字段标注；`/api/ps` 的 used 部分为真实值。
5. **SPEC 未定义处的补全**（非偏差，仅登记）：IPC 各 Req/Res 精确字段、Channel B 各端点请求体、preload 流事件频道名 `nv:stream-event`、StyleBook/StyleReport 结构，均由实现在 `apps/shared/src/types/` 中补全，以 SPEC §4/§6 为约束。

## 2026-10-16（Phase 2）

6. **WorkflowEngine 构造函数扩展**：SPEC §7.1 为 `constructor(registry, db, eventBus)`，实现增加可选第 4 参 `options: { maxSteps?, logDir?, llm?, sidecar? }`（maxSteps 默认 1000 防死循环；llm/sidecar 留待 Phase 3 真实节点注入，故 NodeContext.llm/sidecar 为可选字段）。
7. **NodeDefinition 增加可选 `onResume`**：§7.2 未规定 pause 节点 resume 时 userAction → 节点输出的映射。实现默认 `{ ...payload, ...userAction }` 平铺合并，节点可用 `onResume(ctx, userAction, payload)` 自定义（如 review.candidate-picker 输出 `selected`）。另 NodeContext 补 `node: WorkflowNode` 字段（§9.3 示例代码使用 `ctx.node.params` 但 §7.2 未声明）；PortSpec/ParamSpec 字段细节 SPEC 未给，按 §7.3 端口/参数语义补全。
8. **停止状态落库为 `error`**：§6.6 RunState.status 无 `stopped`。`stop()` 协作式中断后落 `status='error'` + state JSON `error='stopped by user'`；若 §6.6 后续扩展 `stopped` 状态再迁移。
9. **start()/resume() 兑现时机**：SPEC §7.1 未规定 Promise 何时兑现。实现为 run 到达稳定态（done/error/paused）时兑现，保证调用方（IPC/测试）拿到确定状态；`workflow:run` IPC 响应因此携带的是已稳定 run 的 runId。
10. **出边选择规则**：§9.2 只定义条件边匹配语义。实现补全：有任一条件边命中 → 只走命中边；否则走全部无条件边（条件边全不命中且无无条件边 → 无出边，run done）。循环回边的 target port 用名义端口 `trigger`（回边不传递业务数据，仅控制流）。
11. **暂停挂起不持有悬挂 Promise**：§7.1 步骤 4c"等 resume()"实现为状态落库 + 驱动循环返回（挂起信息含 kind/payload 存入 runs.state JSON），resume 重新驱动。崩溃恢复（§7.1 验收）因此与正常 resume 走同一路径，无进程内悬挂 Promise 泄漏风险。并行分支与 pause 混合场景 Phase 2 不支持（排队分支不持久化）。
12. **默认 workflow 落库方式**：SPEC 未规定播种时机。实现为 `project:create` 时把 `resources/default-workflows/main-loop.json` 深拷贝插入 workflows 表并绑定新项目（workflows.project_id 外键约束，无法播项目无关种子）；加载失败仅 warn 不阻断项目创建。目录解析支持 `NOVEL_FORGE_DEFAULT_WORKFLOWS_DIR` 覆盖（打包后接 extraResources）。

## 2026-10-16（Phase 3）

13. **memory_chunks 表（002 migration）**：SPEC §5.1 无项目级记忆表（rag_chunks 属风格库侧）。Phase 3 memory.updater / context.memory 需要持久层，新增 `memory_chunks(id, project_id, chapter_id?, kind, content, metadata, created_at)`，repository 在 `db/repositories/memory-chunks.ts`。
14. **input.context 上下文结构与 prompt 模板**：SPEC §7.3 只给端口名。实现输出 `GenerationContext`（projectId/projectName/genre/chapterIndex/worldSetting/characters/userInput/previousSummaries/prompt），prompt 为「作品 / 世界观 / 人物卡 / 前情摘要 / 用户指令」五段式模板（节点文件内常量）；worldSetting/characters/userInput 来自 node.params，chapterIndex 默认取 chapters 表 max(idx)+1，可被 params.chapterIndex 覆盖。
15. **结构化输出容错**：§7.7 未规定解析失败策略。`nodes/definitions/llm-json.ts` 统一实现：format=toOllamaFormat(schema)，容忍 ```json 代码块包裹（extractJson），解析失败把上次响应+错误回显给模型重试 1 次，仍失败抛错。chapter.finalizer 例外：重试耗尽后回退占位标题（`第N章`）+ 正文截断 300 字摘要并 log warn——定稿节点不应因 LLM 故障使整章报废。
16. **review.chapter-end 的 UserAction**：§6.3 UserAction 联合类型无章节结束动作。实现读取调用方扩展字段 `{ decision: 'continue' | 'end' }`（readChapterEndDecision），缺省按 'end'（防死循环安全默认）。Renderer 章节结束判定面板（§12.3）落地时需按此字段传递。
17. **generate.paragraph-multi 打分降级**：rank 走一次 LLM 调用（paragraph-gen 路由、温度覆盖为 0、format='json'），解析失败/长度不符降级为全 0.5 不阻断流程；Candidate.scores 的 profileFit / styleSimilarity 暂填 0.5 占位（分别属 Phase 4 成长系统 / Phase 5 风格判别器），rewardScore/pacing/character/consistency 取 rank 分。
18. **chapter.finalizer 复用 chapter-plan 路由**：§7.8 路由表无 summary/title 任务，标题+摘要生成属低温度结构化输出，复用 `chapter-plan` 路由（温度 0）。
19. **CandidatesRepository 补 markSelected / setSatisfaction**：§7.3 picker 需要选中标记与满意度持久化，001_init.sql 已有对应列（selected / satisfaction_*），Phase 2 未建方法，Phase 3 补上。
20. **paragraphs.scene_type 暂填 'daily'**：场景分类是 Phase 5 sidecar /scene/classify 的职责；chapter.accumulator 写段落时以 'daily' 占位（列 NOT NULL），后续由分类结果回填。
21. **Phase 3 未注册 context.style / style.discriminator**：两者属 Phase 5 风格系统；`resources/default-workflows/main-loop.json` 仍引用它们，故默认整图暂不可运行（workflow:run 会在 disc 节点报"节点类型未注册"）。Phase 3 验收用简版 DAG（workflow/integration.test.ts）。memory.updater 的 RAG 入库仅在 params.styleId 非空时触发（fire-and-forget，失败仅 warn）。

## 2026-10-16（Phase 4）

22. **六维打分取代单分 rank**：§9.3 示例代码的 rank 为单一综合分 `{"scores": number[]}`；按任务 4.2 六维要求改为一次 LLM 调用输出 `{"candidates": [{pacing, character, consistency, profileFit, styleSimilarity, rewardScore}, ...]}`（维度即 §6.3 CandidateScores 六字段），解析失败降级六维全 0.5。排序键由 rewardScore 改为 avgScore（六维均值，services/candidate-scoring.ts averageScore）。
23. **新增 IPC 频道**：`candidate:lineage`（req `{runId, candidateId}` → res `{lineage: CandidateLineageNode}`，谱系树含每代 satisfaction/avgScore/strategy）与 `growth:profile`（req `{projectId}` → res `{profile: PreferenceProfile}`，§10.3 维度向量）；§4.1 频道清单未列，登记于此。任务书中的 `candidate:set-satisfaction`/`choose`/`reroll`/`feedback` 按 §4.1 既有频道 satisfy/dissatisfy/unmark/select/regenerate-from/regenerate-similar 落地。
24. **PreferenceSample.reasons 类型扩展**：§6.5 为 `string[]`；为区分用户手填与 §10.2 分数差推断的软标签，扩展为 `PreferenceReason[]`（`{tag, inferred: boolean}`）。软标签键：pacing/character/style/profile/overall（consistency 与 styleSimilarity 均映射 style）。
25. **偏好画像存储与公式**（§10.3 未给细节）：画像存 `growth_stats.stats` JSON（`{profile: {dimensions, totalSamples, updatedAt}}`）；维度即 §10.3 八维，初值 0.5，EMA α=0.3，`new = old + α·(target - old)`（正向标签 target=1，负向 target=0，clamp [0,1]）。标签→维度/方向映射表见 `growth/profile-updater.ts` TAG_DIRECTIONS（如 节奏太快→pacing↓、人设崩→character_fidelity↑）。
26. **成对样本触发规则**：choose/satisfy 锚点为 chosen（与满意度严格更低者成对），dissatisfy 锚点为 rejected（与满意度严格更高者成对）；满意度序 satisfied(2)>unrated(1)>unsatisfied(0)。理由优先取 rejected 的用户标签，无则按六维分数差（阈值 0.2）推断软标签。context 快照为 `{runId, nodeId, chosenId}` JSON。
27. **GrowthStats 聚合近似**：§6.5 部分字段无精确口径——growthIndex=画像八维均值×100；convergenceRate=选中候选中 depth≤1 占比；rejectAllRate 暂无拒全弃事件持久化，恒 0；model/style 段属 Phase 5+，恒 0。
28. **重生成 prompt 无父 systemPrompt**：candidates 表不存生成时 systemPrompt，regenerate（§9.4.2）系统提示用通用「你是小说作家。」；improve prompt 优先用父候选 satisfactionTags 拼「在保持情节不变的前提下改进以下方面：…」，无标签时用 hint/默认语。variant 从 §9.3 策略表选不同风格轴。

## 2026-10-16（Phase 5）

29. **forbidden_words 不自动提取**：§6.4 StyleFingerprint 有 forbiddenWords 字段但未给自动推断规则。实现恒为空列表，由用户在档案中配置维护；其余指纹字段（含 §11.4.1 要求的比喻密度、签名用词）已真实计算。
30. **select_sample_size 补全**：§8.4 伪码引用 `select_sample_size(len(chapters))` 但未定义。实现为 `min(max(1, n), 8)`（抽样至多 8 章，每章截前 1500 字送 LLM）。
31. **build_rag_chunks 签名扩展**：§8.4 签名为 `(chapters, fp)`，实现增加第 3 参 `style_id`（RagChunk.style_id 为必填，fp 保留对齐）。chunk 粒度为段落级（§11.2 分层切片只实现段落级一层，全书/卷/句级切片未建）。
32. **判别器 fake 样本来源**：§8.5 `train(style_id, real, fake)` 未规定 fake 从何而来。实现支持 fake 为空时自动从 real 生成扰动负样本（段落内句序乱序 / 去句读合并 / 句首截断，三种轮换、确定性种子），供冷启动；Main 侧有真实 AI 仿写样本时应显式传入。
33. **判别器训练阈值**：§8.4 伪码用 `DISCRIMINATOR_MIN_CHAPTERS` 未给值。取 2（对齐自适应策略表 N=1 跳过判别器）；另设段落级最小样本数 10（real+fake），不足时流水线静默跳过训练、不阻断 SSE。
34. **风格档案存文件系统 JSON**：§5.2 约定 Python 写 SQLite 的 styles/style_books 表，但 sidecar 尚无 SQLite 主库（§5.1 由 Node 建库）。按 §5.3「风格报告存文件系统」的同思路，sidecar 档案整体存 `data/styles/{styleId}/profile.json` + `report.md`，RAG chunk 存独立 `data/rag.sqlite3`；Main 侧 style:import 完成后把档案落主库 styles/style_books 表（双写，主库为 Renderer 读取源）。
35. **LLM 风格分析配置**：§11.4.2 未规定模型名与配置途径。走环境变量 `NV_STYLE_LLM_MODEL`，默认空串 = 跳过 LLM、由统计指纹生成六节模板报告（叙事视角/节奏/对白/爽点/用词/禁忌，小节结构同 §11.4.2）；LLM 调用失败同样降级模板，不阻断流水线。
36. **sidecar 环境变量**（SPEC 未定义，新增登记）：`NV_DATA_DIR`（数据根目录，缺省 ./data）、`NV_OLLAMA_HOST`（Ollama 地址，缺省 http://localhost:11434）、`NV_STYLE_LLM_MODEL`（见 35）。Embedder 启动时对 Ollama 做一次 2 秒超时健康探测，失败回退确定性 MockEmbedder。
37. **EPUB 解析简化**：按 `container.xml → OPF spine` 定阅读顺序，BeautifulSoup 提取纯文本；无 OPF/解析失败回退按文件名排序。不支持 NCX/nav 目录、加密 EPUB（§8.4 未给 EPUB 细节，登记为实现口径）。
38. **判别器模型存储位置**：§5.3 规定模型缓存存 `data/models/`，实现为 `data/models/discriminator/{styleId}.npz`（numpy npz：weights/bias/mean/std）。`DELETE /style/{id}` 连带删除档案目录、向量行与判别器模型文件。
39. **新增 IPC 频道（style 域）**：`style:list`（req `{}` → res `{styles?: StyleProfile[]}`，按 updated_at 降序）、`style:delete`（req `{styleId}` → res `{ok}`，DB 删除 + sidecar DELETE /style/{id}，sidecar 失败仅 warn）、`style:pick-files`（req `{}` → res `{paths; canceled?}`，Electron dialog 多选，filters txt/epub）。§4.1 频道清单未列，§12.4 风格库面板需要列表/删除/文件选择，登记于此。
40. **style:import-progress 事件扩展 styleId**：§4.1 流事件定义无 styleId 字段。导入进度事件的 jobId 为本次导入预生成 uuid（Done 帧的 styleId 才是档案 id），完成时补发一条 `stage='done', progress=1, styleId` 事件供 UI 关联新档案；StreamEvent 相应扩展可选字段。
41. **StyleAnalyzeEvent done 帧扩展 profile**：§4.2 未给 done 帧字段细节（实现期补全为 `{styleId, reportPath?, profile?}`）。sidecar 完成帧可携带完整 StyleProfile；缺省时 Main 回退 `GET /style/{styleId}` 取档案后落库。
42. **styles 表 ragStats/版本号无独立列**：§5.1 styles 表仅 fingerprint/report 两个 JSON 列；`ragStats`、`discriminatorVersion`、`rewardModelVersion` 序列化进 report JSON 扩展字段，getProfile 时拆出还原，缺省给空值（`{totalChunks: 0, byScene: {}}`）。
43. **CHANGELOG #21 状态变更**：context.style / style.rag-retrieve / style.discriminator 已注册进 builtinNodes（13 个内建节点），main-loop.json 引用的全部节点类型齐备，默认整图可运行；sidecar 不可用时 style.rag-retrieve 输出 `fewshot=[]`、style.discriminator 原样透传（降级不炸）。
44. **context.style 的 stylePrompt 拼接格式**：§7.3 只给端口名。实现为「报告 markdown（截 params.maxReportChars，默认 1200）+ 指纹摘要行（句长 X.X · 对白 XX% · 短句比 XX% · 标志词前 3 个）」；params.styleId 空时取最近更新一条档案；无档案输出缺省「你是小说作家。」（与 generate.paragraph-multi 的 stylePrompt 缺省一致）。
45. **CandidatesRepository 补 updateScores**：style.discriminator 需要把 styleSimilarity 写回 candidates 表；Phase 3 仓库仅有 markSelected/setSatisfaction，补整组 scores JSON 更新方法（`UPDATE candidates SET scores = ? WHERE id = ?`）。

## 2026-10-16（Phase 6）

46. **sidecar GET /reward/status（§4.2 未列）**：成长仪表盘模型段与校准 UI 需要奖励模型版本/准确率。实现为训练指标随 `_save()` 持久化进 `latest.json`（`{version, accuracy, kendallTau, sampleCount, trainedAt}`，老格式仅 version 时指标为 null 容错），新增 `GET /reward/status` 返回全可空五字段；npz 内 meta 未动。
47. **GrowthStats.style 段为近似口径**：`avgSimilarity` = 项目全部候选 `scores.styleSimilarity` 均值（无候选为 0）；`discriminatorScore` = 已选中候选（selected=1）的 styleSimilarity 均值（无选中为 0）。判别器真实分待 sidecar 全量回扫，暂借 styleSimilarity 代替。
48. **校准 pairs 排序键用 marked_at 代 created_at**：candidates 表无 created_at 列（001_init.sql），契约「按创建时间倒序」以 marked_at（标记时间）倒序近似，NULL 排最后；未动 schema。
49. **rejectAllRate 口径**：拒全弃按事件计数持久化（stats JSON `counters.rejectAll`，candidate:reject-all 每次 +1），分母为 distinct (runId,nodeId) 面板总数；同一面板多次拒全弃会使率 >1。growth_stats 为按项目单行 JSON，未建独立事件表。
50. **model 段来源 sidecar + 缓存降级**：rewardVersion=parseInt(version 去 'v')（null/解析失败→0）、rewardAccuracy=accuracy??0；sidecar 2 秒超时/失败时读 stats JSON `rewardStatusCache`（上次成功值），从未成功全 0。candidate:* 触发的 growth:updated 流事件不带 model 段（candidate 域无 sidecar 依赖），真值由 growth:stats / growth:calibration IPC 注入。
51. **evaluatorAlignment 口径（§14 任务 6.3 未给公式）**：项目内 satisfaction∈(satisfied,unsatisfied) 候选的全成对比较（满意 rewardScore > 不满意 rewardScore → concordant，< → discordant，= → tie），alignment=(concordant+0.5·tie)/总对数，无对为 0。
52. **导出目录与最小容器口径**：无现成 dataDir 解析函数（db 直接放 `app.getPath('userData')/novel-forge.db`），exports 取 db 文件旁 `exports/`（better-sqlite3 `db.name` 推导）；内存库（测试）退化 `process.cwd()/exports`。docx 为最小 OOXML（无样式表/sectPr）、epub 为最小 EPUB3（mimetype 首 entry STORED）；ZIP 手写 STORED（无压缩）+ 自实现 CRC32，未引第三方依赖。
53. **WorkflowState 增加 projectId 字段**：§12.6 状态接口无 projectId；仪表盘/导出需要当前项目上下文，load 时写入。workflowStore.load 仍为 Phase 2 占位实现、无项目打开 UI，接通前仪表盘显示空态（后续阶段收尾）。
54. **growthIndex 量纲确认为 0..100**：§6.5 未注明；Main 聚合口径为画像维度均值×100（#27），Renderer 直接取整显示（初版按 0..1 ×100 双重缩放已修正）。画像趋势 delta 为 history 末两条快照维度均值差×100。

## 2026-10-16（收尾：项目入口链路）

55. **project:list 频道（§4.1 未列）**：项目入口页需要项目列表。返回按 updatedAt 降序（排序在 IPC handler 层，未改 ProjectsRepository.list() 的 created_at 口径），每项回填 `defaultWorkflowId`（WorkflowsRepository.listByProject 首条）。
56. **run 完成无流事件的 Renderer 判定口径**：引擎在 run 到达 done 时不发 StreamEvent（仅 node-paused / node-error 有）。Renderer 利用「workflow:run / resume 的 Promise 在稳定态兑现，且流事件经同一 WebContents FIFO 先于响应到达」，兑现时 runStatus 仍 idle/running 即置 done；极端边界（resume 后直接 done 且中间无 node-start）runStatus 可能停留 paused，不影响数据正确性。
57. **close 不停止进行中的 run**：TopBar「项目」按钮仅清空 renderer 侧 projectId/run 状态回入口页；paused run 留库，由引擎 recoverRuns 下次启动恢复，未额外调 workflow:stop。
58. **非 Electron 环境降级**：纯 vite 预览下 window.nv 缺失，App 流订阅 try/catch 跳过，ProjectGate 列表加载显示错误提示而非崩溃。
59. **候选选中不自动 resume**：candidate:select 仅标记选中（Phase 4 既有口径），推进 run 需另行 workflow:resume，本次未接线（后续按需）。

## 2026-10-16（批次 1：主循环 UI 闭环）

60. **UserAction 补 chapter-end 成员**：§6.3 联合类型无章节结束判定动作（#16 原以扩展字段透传）。正式补 `{type:'chapter-end', decision:'continue'|'end'}` 成员，renderer 移除 `as unknown as UserAction` 强转；main 侧 readChapterEndDecision 口径不变。
61. **改后选 editedText 双通道**：`candidate:select` 现在把 editedText 回写候选行 text（CandidatesRepository 新增 updateText）；review.candidate-picker 的 onResume 又以 pausedPayload 旧候选 + userAction.editedText 构造 selected（不回写 DB）。两路径语义一致（选中段落以编辑文本入章）；「确认选中并继续」按面板编辑稿与现文本比对去重后携带。后续若统一，以 DB 回写为准、resume 不再携带。
62. **candidateStore 新增 error 字段**：契约外 renderer 内部状态，候选操作失败在面板展示（原实现静默吞错）。
63. **「生成相似」批量数固定为 3**：SPEC 未给默认值，CandidatePanel 内常量化 SIMILAR_COUNT=3，未下沉 main。
64. **暂停面板互斥按节点类型切换**：requested pause（workflow:pause，payload=null）恰好落在 review.* 节点时面板仍显示但无 payload（chapter-end 纯按钮、picker 靠 candidate:list 拉取），行为可接受。

## 2026-10-16（批次 2：学习闭环）

65. **rejected pattern 伪样本映射方向**：§10.4/10.5 演化 pattern→伪偏好样本时「chosen=childText、rejected=parentText」仅适用 outcome='selected' 行；rejected 行语义相反（用户否决全部改进保留原文），实现 chosen=parentText、rejected=child_texts 逐条展开，保证方向与用户决策一致（growth/prompt-evolution.ts patternsToPseudoSamples）。
66. **pattern 的 hint 来源**：candidates 表无 hint 列（生成参数记在 candidate_lineage），记录 pattern 时从 candidate_lineage 反查同父最近一条的 hint（ipc/candidate.ts latestHintForParent）。
67. **diff 计数近似口径**：selected pattern 的 diff JSON `{removed, added}` 为句级 LCS（services/text-diff.ts diffTexts）合并后 del/add 段条数，非逐句精确计数。
68. **无父候选的落选不入 evolution_patterns**：reject-all 按 parent_candidate_id 分组时空父组不记录（表约束 parent_text NOT NULL，无演化意义）。
69. **prompt_versions.metrics 复用为溯源 JSON**：sidecar 返回的 parentVersion/basedOn 并入 metrics JSON 列存档（表无更细列，shared 冻结不扩表），version 落专列。
70. **trainReward SSE 中间帧不解析**：进度帧宽松处理仅等流结束；流内 `{type:"error"}` 帧按 SidecarHttpError 抛出；指标由调用方完成后 GET /reward/status 回读。
71. **演化/训练契约类型本地定义**：PromptTemplate、EvolutionExtractRequest/Response、RewardTrainRequest、SidecarHttpError 在 sidecar/client.ts 本地定义（shared 冻结不新增导出；形状以实现期核对为准）。
72. **全量偏好样本读取**：growth:train-reward 读全量实现为 `listByProject(projectId, countByProject(projectId))`（仓库默认 limit=100，未改签名）。
73. **演化链阈值重复触发不去重**：pattern≥30 后每次 select/reject-all 都重跑提炼（sidecar 每次生成新 version），依赖 prompt_versions version 递增消费最新版；未做「已提炼过」标记。

## 收尾批次 2 新增频道

74. **growth:train-reward 频道（§4.1 未列）**：手动触发奖励模型训练（§10.2）。req `{projectId}` → res `{ok, metrics?: RewardTrainMetrics, detail?}`；样本<100 时 sidecar 400 的 detail 原文回传；RewardTrainMetrics={version, accuracy, kendallTau, sampleCount, trainedAt}（未训练缺省 0/空串）。

## 2026-10-16（批次 3：设置面板与模型路由）

75. **settings 表（003 migration）**：§5.1 无设置持久化表。新增 `settings(key PRIMARY KEY, value JSON, updated_at)`；路由覆盖存 key='model-routes' 的「覆盖补丁对象」`{task: {model?, temperature?, format?}}`（仅存被改动任务，恢复默认即清空），loadRouteOverrides 兼容读回全量数组形态。
76. **ModelRouter 单例化修缺陷**：此前 3 节点 + candidate-scoring/candidate-regeneration 共 5 处各自 `new ModelRouter()`，setRoute 运行时覆盖对消费点无效。改 `getModelRouter()` 单例（router-instance.ts）；NodeContext/engine options 增可选 router，节点 `ctx.router ?? getModelRouter()`，服务层直取单例。§7.8 运行时覆盖至此真实生效。
77. **settings:* 频道（§4.1 未列）**：get/set-route/reset-routes/list-models/pull-model 五频道 + `settings:pull-progress` 流事件（含 jobId 关联）。
78. **settings:list-models 失败口径**：Ollama 不可达返回 `{ok:true, models:[]}`（契约无 running 字段，运行态由 settings:get 的 ollama.running/detail 表达）；Ollama 实例缺省时 list-models/pull-model 返回 `{ok:false,error}`。
79. **拉取进度认领折中**：契约 pull-model 响应不含 jobId，renderer 以「本次拉取模型名」认领首个 pull-progress 事件并锁定其 jobId，其后按 jobId 过滤防串扰。
80. **启动模型预检**：§7.6「缺失模型可拉取」实现为启动时仅对 embedding、paragraph-gen 两个任务模型名（去重）做 ensureModel，非阻塞、失败仅 warn，进度经 eventBus 推流（范围限定避免一次拉多个大模型）。
81. **saveRouteOverrides 为预留 API**：IPC 仅用 persistRouteOverride（逐条）+ clearRouteOverrides；全量差异落库方法暂无调用点。
82. **db.test.ts 版本断言同步**：新增 003_settings 后 schema_migrations 精确断言更新为含 '003_settings'（必要同步）。

## 2026-10-16（批次 4：流式 / 回滚 / 混合选 / 风格自测）

83. **token 级流式（§15「流式生成不卡 UI」）**：generate.paragraph-multi 的 execute 改 async generator——Promise.all 并发不变，各策略 for-await 消费 chat 流、delta 逐个 yield（executor 自动转 node-token）；多候选 token 交错属同一 nodeId（不区分策略）。「生成中…」token 累计 + 尾部片段状态区放 SidePanel「面板」tab（CandidatePanel 仅暂停时挂载无法展示），workflowStore 新增 tokenCount/tokenTail（TOKEN_TAIL_LENGTH=40）。
84. **migration down 回滚**：001/002/003 各补 `{name}_down.sql`（001 先索引再子后主、末尾删 schema_migrations）；db/index.ts 导出 createMigrator，up 排除 `*_down.sql`，down 按命名约定探测、缺失才抛错；unlog 容忍表已删。测试 down({to:0}) 表全消失→再 up 幂等恢复。
85. **混合选句级合并（§15）**：新 services/candidate-mix.ts `composeMixText`（按 span [start,end) 截取、换行拼接、越界/空片段/候选不存在忽略、空 sources 抛错）；picker onResume 的 mix 分支输出 `selected={text,mode:'mix',sources}`；CandidatePanel「选段」模式划选入混合篮→candidateStore.mix(sources)→resume `{type:'mix',sources}`；快捷键在有文本选择时跳过。candidateStore.mix 经动态 import 取 workflowStore.resume（避免静态模块环）。
86. **风格相似度自测（§15「> 阈值（按 N 分档）」+ §12.4 面板）**：新频道 `style:self-check`。样本语料取 **rag_chunks.text**（001 冻结的 style_books 表无文本列，仅元数据），N 分档的 n 仍按 style_books 条目数；语料上限 SELF_CHECK_MAX_SAMPLES=50（rowid 前 50 段均分）。阈值：N=1→0.55（one）、2..4→0.65（few）、≥5→0.75（many）；无样本/判别器不可用按 skipped 返回原因。
87. **StylePickFilesRes.paths 可选兼容修复**：契约重建后 paths 为 `paths?:`，StyleLibrary 既有展开 `...(res.paths ?? [])`（renderer 侧兼容，未动 shared）。

## 2026-10-16（端到端实机验证）

88. **SidecarManager 启动器回退**：Windows 实机（Electron 环境）`py` 启动器不在 PATH 时 spawn ENOENT 直接失败。DEFAULT_COMMANDS=['py','python'] 逐个尝试，spawn error 事件为 ENOENT 时换下一个命令重试。
89. **READY_PREFIX_ARGS 改 `-m novel_forge_sidecar.main`**：原 `uvicorn novel_forge_sidecar.main:app --port 0` 直起不打印端口 ready JSON（§2 端口协议仅由 main.py `run()` 入口在 bind 后打印），Main 侧读端口 15s 必超时。spawn 参数改为模块入口调用。
90. **SidecarClient.health() 连接重试**：sidecar `run()` 在 bind 之后、listen 之前打印 ready JSON，存在竞态窗口，过早连接 ECONNREFUSED。health() 仅对 ECONNREFUSED/ECONNRESET 重试 10 次×300ms；fetch 连接失败是 TypeError（code 在 cause 链），新增 errCode() 逐层提取（≤3 层）。
91. **main-loop.json e3/e16 双入边 → plan 每章双跑（遗留未修）**：e3 `context→plan.context` 与 e16 `next.context→plan.context` 两入边在章级循环下使 chapter-plan 每章执行 2 次（candidate:generated 计数翻倍、候选面板一轮双开）。实机 E2E 断言放宽为 ≥9 且 %3==0；修复需调整回边拓扑，后续单独处理。
92. **better-sqlite3 Electron ABI 冲突与双态重建脚本**：Node 24 prebuild 按 MODULE_VERSION 137 编译，Electron 33 需 130，主进程启动即 ERR_DLOPEN_FAILED。新增 root devDep `@electron/rebuild` 与脚本 `rebuild:electron`（electron-rebuild -f -w better-sqlite3）/ `rebuild:node`（npm rebuild better-sqlite3）；两态互斥——跑 Electron 前先 `npm run rebuild:electron`，跑 vitest（Node 侧加载 better-sqlite3）前先 `npm run rebuild:node`。
93. **vitest worker PATH 裁剪（实机 E2E 观察记录）**：vitest 子进程内 spawn 'py'/'python' 均 ENOENT（worker PATH 被裁剪），实机冒烟脚本需传解释器全路径；cwd 无效时 spawn 同样报 ENOENT 伪装成命令缺失。NV_E2E=1 门控的 apps/main/src/e2e-real.test.ts 已按此跑通全链路（真实 Ollama + sidecar：生成/暂停/恢复/stop/GrowthStats/TXT+EPUB 导出）后删除，未入库。
94. **sidecarDir 解析按存在性探测**：dev 模式 `app.getAppPath()`=apps/main，原 `path.resolve(appPath, 'sidecar')` 指向不存在的目录，cwd 无效使 spawn 报 ENOENT（伪装成 Python 命令缺失，与 #88 症状叠加误导排查）。index.ts 新增 resolveSidecarDir：env 覆盖 > 打包 extraResources > app 内布局 > dev workspaces 布局（apps/main 上两级），按 existsSync 择首个真实目录。
95. **apps/main dev 先构建再启动**：原 dev=`electron .` 直接跑 dist/index.cjs，src 修改不经编译不生效（本次 sidecar 目录修复因此一度「无效」）。改为 `node scripts/build.mjs && electron .`（esbuild 秒级）。
96. **root dev 用 concurrently 并行**：原 `npm run dev -w apps/main & npm run dev -w apps/renderer` 在 Windows cmd 下 `&` 为顺序执行，electron 前台阻塞导致 vite 永不启动（仅 main 崩溃时才轮到 renderer）。引入 root devDep concurrently（^9）并行拉起，日志按 [main]/[renderer] 前缀区分。

## 2026-10-16（#91 双入边重复执行修复）

97. **引擎汇聚语义（根因更正）**：#91 原记为「e3/e16 双入边拓扑问题」，实为**引擎调度缺陷**——`driveInner` 按入边逐条触发、把 target 直接压入队列且不去重，多入边节点在同一激活轮被重复执行（main-loop 实测 `plan`（e3+e4+e16）×2、`gen`（e5+e6+e7+e12）×4，是 `candidate:generated` 计数翻倍的真正来源）。修复两点：① **同轮去重**（新增 pending 集合，多入边汇聚后每轮只执行一次）；② **必需输入就绪门控**（按 §7.2 `PortSpec.required`，必需端口未齐备时重排让位给生产者节点，`deferrals > maxSteps` 判定死锁失败）。`main-loop.json` 拓扑本身正确（多入边是合法的数据汇聚），**未改动**。回归测试：engine.test.ts 新增「多入边汇聚只执行一次」「必需输入重排」两例，并加载真实 `main-loop.json` 断言每轮 `plan`/`gen` 各只执行一次（旧实现 plan×2、gen×4）；全套 245 例全绿、三包 typecheck 零错误。

## 2026-10-16（#56 run 状态判定边界收尾）

98. **workflow:run / workflow:resume 响应携带权威稳定态 status（收尾 #56）**：#56 记录的极端边界——pause 节点为末位节点（resume 后无出边、中间无 node-start 事件）时，renderer 旧启发（「兑现时仍 running/idle 即 done」）会把 runStatus 滞留 `paused`，且无条件 `set({pausedPayload:null})` 会误清 resume 后在**其它节点**重新暂停的面板载荷。修复：① shared 契约 `WorkflowRunRes`/`WorkflowResumeRes` 增可选 `status: RunState['status']`（IPC 响应在 run 到达 done/error/paused 稳定态后才兑现，状态确定）；② `WorkflowEngine.start/resume` 返回稳定态状态，IPC handler 透传；③ workflowStore 以响应 status 为准置 done/error/paused，保留旧 Main 无 status 字段时的兼容启发；node-paused 事件 FIFO 先于响应到达，仅当 currentNodeId 已变为其它节点（在别处重新暂停）时保留其 currentNodeId/pausedPayload 不清空。engine.test.ts 新增「末位 pause 节点 resume 直达 done 返回 done」用例并为循环用例补 resume 返回值断言（全套 246 绿），三包 typecheck、main+renderer build、sidecar 47 pytest 全绿。

## 2026-10-16（九项缺口审计逐步修复：批次 A/B/C/D，#99）

99. **审计缺口收口（reward/rag 主循环、UI 真实接线、死代码清理）**：
   - **A1 奖励模型接回候选预排序**：原实现六维 rewardScore 维只取 LLM rank 分，已训练奖励模型从未消费（§9.3 打分链路缺口）。shared `RewardScoreResponse` 增可选 `modelVersion: string | null`（sidecar `/reward/score` 本就返回 camelCase，CamelModel 自动别名）；`generate-paragraph-multi` 在 LLM rankCandidates 之后调 `ctx.sidecar.rewardScore({texts})`，**仅当 modelVersion 非空（已训练）**才以 clamp01 的模型分覆写 rewardScore 维并重排序，未训练/sidecar 缺失/调用异常/长度不符一律保留 LLM 分（catch 用 ctx.log 记录，不阻断）。测试 +3（已训练覆写重排序、modelVersion=null 保留、异常保留）。
   - **A2 style.rag-retrieve 挂入主循环**：原 `main-loop.json` 未连 rag 节点（#43 注册后长期离线），fewshot 不进生成链路。拓扑改动：plan 与 gen 之间插入 `rag` 节点（x440 y480），边改为 plan→rag（plan 口）、rag→gen（fewshot 口）、rag→gen（plan 口，透传）；`style.rag-retrieve` outputs 增 `plan` 透传端口、三个 return 均返回 `{fewshot, plan}`（rag 是章级同步点，避免 gen 读到上一章旧 fewshot 先跑）；`generate.paragraph-multi` inputs 增 `{name:'fewshot', dataType:'string[]', required:true}`，prompt 注入【文风例句】段（含「严禁照抄情节与文字」），入参非字符串数组容错为 []。**引擎语义放宽**：`inputsReady()` 的 required 门控仅作用于图中**实际连了入边**的端口（以 `workflow.edges` 判定，非 `workflow.graph.edges`），兼容未连 rag 的旧版/自定义工作流，不构成破坏性变更。engine/rag-retrieve/paragraph 测试同步更新（真实拓扑计数 `{plan:2,rag:2,gen:3}`、plan 透传断言、fewshot 注入/容错 2 例、required 未连线不门控 1 例）。
   - **B 候选面板操作补齐**：`CandidatePanel` header 增「🧹 清除不满意」（既有 `pruneUnsatisfied()` 接线，无不满意候选时禁用），每卡片增「换风格」（既有 `regenerateFrom(id,'variant')` 接线，生成 3 候选）。📌暂存/🔄全新重生成/➕再来候选未做——add-candidates 后端为透传动作、无实际生成链路，接线即成半成品，明确不做。
   - **C StatusBar/TopBar/SidePanel 写死值与占位收口**：新增 renderer store `projectOverviewStore`（并行 `project:get` + `growth:stats` 取章节列表与成长指数；`growth:updated` 事件直接采用携带 stats，`workflow:node-done` 且节点类型 chapter.finalizer 时重拉章节；非 Electron 环境降级空态），App 顶层启动拉 settings、项目切换拉概要、流事件转发三 store。StatusBar 六格接真：队列=runStatus 中文、模型=paragraph-gen 路由 model、Ollama=运行态+已检测模型数（**无 VRAM 查询 API，不编造显存数**，hover 显示模型名/detail）、Token=tokenCount、保存=自动保存（写操作即时落 SQLite）、版本静态；TopBar「章节」=chapters 总数、「成长指数」=growthIndex×100 取整；SidePanel 三占位块中「成长面板」移除（仪表盘已是顶栏独立视图，避免假入口），「章节累加器」接 workflowStore 新增的 `accumulatedCount`（chapter.accumulator 的 node-done 事件从 `output.chapterDraft.paragraphs.length` 按章覆盖，新 run/load/close 重置），「段落历史」渲染 final/draft 章节（序号/标题/状态/字数/摘要两行截断，空态明确）。
   - **D 画布只读 DAG + 死代码删除**：`CanvasArea` 由空白 React Flow 改为从 workflowStore.workflow 只读渲染真实节点/边（type→中文短名表、sourceHandle/targetHandle 按端口映射），running 蓝/paused 琥珀/已执行节点（nodeOutputs 命中）绿三态着色，禁拖拽/连线/选择，未加载工作流显示空态文案；删除 Phase 1 遗留 `apps/main/src/ipc/stubs.ts`（删除前全仓 Grep 确认零引用）。
   - **明确不做项**：sqlite-vec 替换（#审计③，当前数据规模零性能压力，触发大规模再评估）、LoRA 训练（SPEC 标注 Phase 3+）、场景标注 80% 实测率（需真机语料）。
   - 验证：三包 typecheck 零错误；main vitest **252 全绿**（净 +6）；sidecar pytest **47 全绿**；main（esbuild，仅既有 import.meta CJS 警告）与 renderer（vite，仅既有动态/静态混合导入提示）build 通过。
