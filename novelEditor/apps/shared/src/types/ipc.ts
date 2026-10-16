/** Channel A · Renderer ↔ Main IPC 类型（SPEC §4.1） */

import type { Candidate, CandidateLineageNode, Satisfaction, UserAction } from './candidate.js';
import type { GrowthStats, PreferenceProfile, ProfileSnapshot } from './growth.js';
import type { ModelRoute, OllamaModel } from './llm.js';
import type { Chapter, Project } from './project.js';
import type { RunState } from './run-state.js';
import type { StyleProfile } from './style.js';
import type { Workflow } from './workflow.js';

/** 统一响应基座：stub 与真实实现共用 */
export interface IpcResult {
  ok: boolean;
  error?: string;
}

// ---- project ----
export interface ProjectCreateReq {
  name: string;
  genre: string;
  description?: string;
}
export interface ProjectCreateRes extends IpcResult {
  project?: Project;
}

export interface ProjectGetReq {
  id: string;
}
export interface ProjectGetRes extends IpcResult {
  project?: Project;
  chapters?: Chapter[];
}

/** 收尾新增频道（SPEC §4.1 未列，SPEC-CHANGELOG 登记）：项目列表（项目入口页，按 updatedAt 降序） */
export interface ProjectListItem extends Project {
  /** 项目绑定的默认工作流 id（project:create 时播种），缺失说明播种失败 */
  defaultWorkflowId?: string;
}
export interface ProjectListReq {}
export interface ProjectListRes extends IpcResult {
  projects?: ProjectListItem[];
}

// ---- workflow ----
export interface WorkflowLoadReq {
  projectId: string;
  workflowId: string;
}
export interface WorkflowLoadRes extends IpcResult {
  workflow?: Workflow;
}

export interface WorkflowRunReq {
  projectId: string;
  workflowId: string;
  fromNodeId?: string;
}
export interface WorkflowRunRes extends IpcResult {
  runId?: string;
  /** run 到达稳定态（done/error/paused）时的权威状态（#56：renderer 不再依赖事件启发判定） */
  status?: RunState['status'];
}

export interface WorkflowPauseReq {
  runId: string;
}
export type WorkflowPauseRes = IpcResult;

export interface WorkflowResumeReq {
  runId: string;
  nodeId: string;
  userAction: UserAction;
}
export interface WorkflowResumeRes extends IpcResult {
  /** resume 驱动到达下一个稳定态（done/error/paused）时的权威状态（#56） */
  status?: RunState['status'];
}

export interface WorkflowStopReq {
  runId: string;
}
export type WorkflowStopRes = IpcResult;

// ---- candidate ----
export interface CandidateListReq {
  runId: string;
  nodeId: string;
}
export interface CandidateListRes extends IpcResult {
  candidates?: Candidate[];
}

export interface CandidateSelectReq {
  runId: string;
  nodeId: string;
  candidateId: string;
  editedText?: string;
}
export type CandidateSelectRes = IpcResult;

export interface CandidateRejectAllReq {
  runId: string;
  nodeId: string;
  reason?: string;
}
export type CandidateRejectAllRes = IpcResult;

export interface CandidateSatisfyReq {
  runId: string;
  nodeId: string;
  candidateId: string;
}
export type CandidateSatisfyRes = IpcResult;

export interface CandidateDissatisfyReq {
  runId: string;
  nodeId: string;
  candidateId: string;
  reason?: string;
  reasonTags?: string[];
}
export type CandidateDissatisfyRes = IpcResult;

export interface CandidateUnmarkReq {
  runId: string;
  nodeId: string;
  candidateId: string;
}
export type CandidateUnmarkRes = IpcResult;

export interface CandidateRegenerateFromReq {
  runId: string;
  nodeId: string;
  candidateId: string;
  mode: 'improve' | 'variant';
  hint?: string;
}
export interface CandidateRegenerateFromRes extends IpcResult {
  newCandidateIds?: string[];
}

export interface CandidateRegenerateSimilarReq {
  runId: string;
  nodeId: string;
  candidateId: string;
  count: number;
}
export interface CandidateRegenerateSimilarRes extends IpcResult {
  newCandidateIds?: string[];
}

export interface CandidatePruneUnsatisfiedReq {
  runId: string;
  nodeId: string;
}
export interface CandidatePruneUnsatisfiedRes extends IpcResult {
  removed?: number;
}

/** Phase 4 新增频道（SPEC §4.1 未列，SPEC-CHANGELOG 登记）：候选谱系树 */
export interface CandidateLineageReq {
  runId: string;
  candidateId: string;
}
export interface CandidateLineageRes extends IpcResult {
  lineage?: CandidateLineageNode;
}

/** Phase 6 新增频道（SPEC §4.1 未列，SPEC-CHANGELOG 登记）：候选版本对比（§14 任务 6.4 diff 高亮） */
export interface DiffSegment {
  type: 'same' | 'add' | 'del';
  text: string;
}
export interface CandidateDiffReq {
  candidateIdA: string;
  candidateIdB: string;
}
export interface CandidateDiffRes extends IpcResult {
  /** 句级 LCS diff；del 属 A 侧、add 属 B 侧，same 两侧共有 */
  segments?: DiffSegment[];
}

// ---- style ----
export interface StyleImportReq {
  authorName: string;
  genre: string;
  bookPaths: string[];
}
export interface StyleImportRes extends IpcResult {
  jobId?: string;
}

export interface StyleGetReq {
  styleId: string;
}
export interface StyleGetRes extends IpcResult {
  profile?: StyleProfile;
}

/** Phase 5 新增频道（SPEC §4.1 未列，SPEC-CHANGELOG 登记）：风格库列表（§12.4） */
export interface StyleListReq {}
export interface StyleListRes extends IpcResult {
  styles?: StyleProfile[];
}

/** Phase 5 新增频道（SPEC §4.1 未列，SPEC-CHANGELOG 登记）：删除风格档案 */
export interface StyleDeleteReq {
  styleId: string;
}
export type StyleDeleteRes = IpcResult;

/** Phase 5 新增频道（SPEC §4.1 未列，SPEC-CHANGELOG 登记）：导入作品文件选择对话框 */
export interface StylePickFilesReq {}
export interface StylePickFilesRes extends IpcResult {
  paths?: string[];
  canceled?: boolean;
}

/** 收尾批次 4 新增（SPEC §15「风格相似度 > 阈值（按 N 分档）」自测，§12.4 风格库面板「风格相似度自测 XX%」） */
export interface StyleSelfCheckReq {
  styleId: string;
}
export interface StyleSelfCheckRes extends IpcResult {
  /** 判别器对 style_books 风格库样本文本的平均分 0..1 */
  score?: number;
  /** 样本数（style_books 条目数，N 分档口径） */
  n?: number;
  /** 阈值档位名：one | few | many（N=1 / 2≤N≤4 / N≥5） */
  band?: string;
  /** 该档阈值；score >= threshold 即判定达标 */
  threshold?: number;
  /** 样本为空或判别器未训练时 true（无分可判定） */
  skipped?: boolean;
  /** skipped 原因（如「风格库无样本」「判别器未训练」） */
  reason?: string;
}

// ---- growth ----
export interface GrowthStatsReq {
  projectId: string;
}
export interface GrowthStatsRes extends IpcResult {
  stats?: GrowthStats;
}

/** Phase 4 新增频道（SPEC §4.1 未列，SPEC-CHANGELOG 登记）：偏好画像（§10.3 维度向量） */
export interface GrowthProfileReq {
  projectId: string;
}
export interface GrowthProfileRes extends IpcResult {
  profile?: PreferenceProfile;
  /** Phase 6：画像历史快照（趋势图数据，时间升序，封顶 50 条） */
  history?: ProfileSnapshot[];
}

/** Phase 6 新增频道（SPEC §4.1 未列，SPEC-CHANGELOG 登记）：评估器校准（§14 任务 6.3） */
export interface CalibrationPair {
  candidateId: string;
  rewardScore: number;
  avgScore: number;
  satisfaction: Satisfaction;
}
export interface GrowthCalibrationReq {
  projectId: string;
}
export interface GrowthCalibrationRes extends IpcResult {
  /** 奖励模型预测分与用户满意度的成对一致率 0..1（无足够标注对时为 0） */
  alignment?: number;
  /** 奖励模型版本号（未训练为 0）与训练留出集准确率（未知为 0），来自 sidecar /reward/status */
  rewardVersion?: number;
  rewardAccuracy?: number;
  /** 已标记满意度的候选（按创建时间倒序，封顶 50 条） */
  pairs?: CalibrationPair[];
}

/** 收尾批次 2 新增频道（SPEC §4.1 未列，SPEC-CHANGELOG 登记）：手动触发奖励模型训练（§10.2） */
export interface GrowthTrainRewardReq {
  projectId: string;
}
/** 训练完成后回读 sidecar /reward/status 的指标（未训练全为 0/空串） */
export interface RewardTrainMetrics {
  version: string;
  accuracy: number;
  kendallTau: number;
  sampleCount: number;
  trainedAt: number;
}
export interface GrowthTrainRewardRes extends IpcResult {
  metrics?: RewardTrainMetrics;
  /** 样本不足等业务失败提示（sidecar 400 的 detail 原文） */
  detail?: string;
}

/** Phase 6 新增频道（SPEC §4.1 未列，SPEC-CHANGELOG 登记）：导出成稿（§14 任务 6.6，§5.3 data/exports/） */
export type ExportFormat = 'txt' | 'md' | 'docx' | 'epub';
export interface ExportManuscriptReq {
  projectId: string;
  format: ExportFormat;
}
export interface ExportManuscriptRes extends IpcResult {
  /** 导出文件绝对路径 */
  path?: string;
}

// ---- settings（收尾批次 3 新增：设置面板与模型路由，SPEC §7.8 / §15 功能验收） ----
/** Ollama 运行状态 + 已安装模型名（GET /api/tags 失败时 running=false、models=[]） */
export interface SettingsOllamaStatus {
  running: boolean;
  models: string[];
  /** 查询失败时的提示（running=false 时的原因） */
  detail?: string;
}
export interface SettingsGetReq {}
export interface SettingsGetRes extends IpcResult {
  /** 当前全部任务路由（含运行时覆盖后的值） */
  routes?: ModelRoute[];
  ollama?: SettingsOllamaStatus;
}
export interface SettingsSetRouteReq {
  task: ModelRoute['task'];
  model?: string;
  temperature?: number;
}
export interface SettingsSetRouteRes extends IpcResult {
  /** 覆盖后的全量路由 */
  routes?: ModelRoute[];
}
export interface SettingsListModelsReq {}
export interface SettingsListModelsRes extends IpcResult {
  models?: OllamaModel[];
}
export interface SettingsPullModelReq {
  name: string;
}
export interface SettingsPullModelRes extends IpcResult {
  /** 拉取完成后模型是否可用 */
  available?: boolean;
}
/** 路由覆盖持久化清除（恢复 DEFAULT_ROUTES） */
export interface SettingsResetRoutesReq {}
export interface SettingsResetRoutesRes extends IpcResult {
  routes?: ModelRoute[];
}

/** 频道名 → 请求类型（SPEC §4.1 频道清单，名字必须完全一致） */
export interface IpcRequestMap {
  'project:create': ProjectCreateReq;
  'project:get': ProjectGetReq;
  'project:list': ProjectListReq;
  'workflow:load': WorkflowLoadReq;
  'workflow:run': WorkflowRunReq;
  'workflow:pause': WorkflowPauseReq;
  'workflow:resume': WorkflowResumeReq;
  'workflow:stop': WorkflowStopReq;
  'candidate:list': CandidateListReq;
  'candidate:select': CandidateSelectReq;
  'candidate:reject-all': CandidateRejectAllReq;
  'candidate:satisfy': CandidateSatisfyReq;
  'candidate:dissatisfy': CandidateDissatisfyReq;
  'candidate:unmark': CandidateUnmarkReq;
  'candidate:regenerate-from': CandidateRegenerateFromReq;
  'candidate:regenerate-similar': CandidateRegenerateSimilarReq;
  'candidate:prune-unsatisfied': CandidatePruneUnsatisfiedReq;
  'candidate:lineage': CandidateLineageReq;
  'style:import': StyleImportReq;
  'style:get': StyleGetReq;
  'style:list': StyleListReq;
  'style:delete': StyleDeleteReq;
  'style:pick-files': StylePickFilesReq;
  'style:self-check': StyleSelfCheckReq;
  'growth:stats': GrowthStatsReq;
  'growth:profile': GrowthProfileReq;
  'growth:calibration': GrowthCalibrationReq;
  'growth:train-reward': GrowthTrainRewardReq;
  'candidate:diff': CandidateDiffReq;
  'export:manuscript': ExportManuscriptReq;
  'settings:get': SettingsGetReq;
  'settings:set-route': SettingsSetRouteReq;
  'settings:reset-routes': SettingsResetRoutesReq;
  'settings:list-models': SettingsListModelsReq;
  'settings:pull-model': SettingsPullModelReq;
}

export interface IpcResponseMap {
  'project:create': ProjectCreateRes;
  'project:get': ProjectGetRes;
  'project:list': ProjectListRes;
  'workflow:load': WorkflowLoadRes;
  'workflow:run': WorkflowRunRes;
  'workflow:pause': WorkflowPauseRes;
  'workflow:resume': WorkflowResumeRes;
  'workflow:stop': WorkflowStopRes;
  'candidate:list': CandidateListRes;
  'candidate:select': CandidateSelectRes;
  'candidate:reject-all': CandidateRejectAllRes;
  'candidate:satisfy': CandidateSatisfyRes;
  'candidate:dissatisfy': CandidateDissatisfyRes;
  'candidate:unmark': CandidateUnmarkRes;
  'candidate:regenerate-from': CandidateRegenerateFromRes;
  'candidate:regenerate-similar': CandidateRegenerateSimilarRes;
  'candidate:prune-unsatisfied': CandidatePruneUnsatisfiedRes;
  'candidate:lineage': CandidateLineageRes;
  'style:import': StyleImportRes;
  'style:get': StyleGetRes;
  'style:list': StyleListRes;
  'style:delete': StyleDeleteRes;
  'style:pick-files': StylePickFilesRes;
  'style:self-check': StyleSelfCheckRes;
  'growth:stats': GrowthStatsRes;
  'growth:profile': GrowthProfileRes;
  'growth:calibration': GrowthCalibrationRes;
  'growth:train-reward': GrowthTrainRewardRes;
  'candidate:diff': CandidateDiffRes;
  'export:manuscript': ExportManuscriptRes;
  'settings:get': SettingsGetRes;
  'settings:set-route': SettingsSetRouteRes;
  'settings:reset-routes': SettingsResetRoutesRes;
  'settings:list-models': SettingsListModelsRes;
  'settings:pull-model': SettingsPullModelRes;
}

export type IpcChannel = keyof IpcRequestMap;
