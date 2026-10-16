/** SPEC §6.2 workflow.ts */

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  version: number;
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  params: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: { nodeId: string; port: string };
  target: { nodeId: string; port: string };
  condition?: { port: string; equals: unknown };
}

export type NodeType =
  | 'input.context' | 'input.manual'
  | 'context.memory' | 'context.style'
  | 'generate.chapter-plan' | 'generate.paragraph-multi'
  | 'generate.dialogue' | 'generate.polish'
  | 'review.candidate-picker' | 'review.chapter-end'
  | 'chapter.accumulator' | 'chapter.finalizer' | 'chapter.next-starter'
  | 'memory.updater'
  | 'growth.capture-diff' | 'growth.update-profile' | 'growth.calibrate-evaluator'
  | 'style.rag-retrieve' | 'style.discriminator';
