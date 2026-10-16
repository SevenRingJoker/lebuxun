/** SPEC §6.6 RunState */

export interface RunState {
  runId: string;
  workflowId: string;
  status: 'running' | 'paused' | 'done' | 'error';
  currentNodeId?: string;
  outputs: Record<string, Record<string, unknown>>;
  context: {
    projectId: string;
    chapterId?: string;
    styleId?: string;
    accumulatedParagraphs: string[];
    [key: string]: unknown;
  };
}
