/** SPEC §7.2 Node Registry：register / get / has / list */

import type { NodeType } from '@novel-forge/shared';
import type { NodeDefinition } from './types.js';

export class NodeRegistry {
  private readonly defs = new Map<NodeType, NodeDefinition>();

  register(def: NodeDefinition): void {
    if (this.defs.has(def.type)) {
      throw new Error(`节点类型重复注册: ${def.type}`);
    }
    this.defs.set(def.type, def);
  }

  get(type: NodeType): NodeDefinition {
    const def = this.defs.get(type);
    if (!def) {
      throw new Error(`节点类型未注册: ${type}`);
    }
    return def;
  }

  has(type: NodeType): boolean {
    return this.defs.has(type);
  }

  list(): NodeDefinition[] {
    return [...this.defs.values()];
  }
}

export type { NodeDefinition, NodeContext, ParamSpec, PortSpec } from './types.js';
