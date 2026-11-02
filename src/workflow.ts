/** Strict helpers for ComfyUI API-format workflow JSON. */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ApiNode = {
  class_type: string;
  inputs: Record<string, JsonValue>;
  [key: string]: unknown;
};
export type ApiWorkflow = Record<string, ApiNode>;
export type ObjectInfo = Record<string, unknown>;

const MAX_WORKFLOW_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export type ValidationIssue = { path: string; message: string };
export type ValidationResult = { valid: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] };

function ownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encodedSize(value: unknown): number {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new WorkflowError("Workflow must be JSON serializable");
  }
  if (typeof text !== "string") throw new WorkflowError("Workflow must be a JSON object");
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_WORKFLOW_BYTES) throw new WorkflowError(`Workflow exceeds ${MAX_WORKFLOW_BYTES} bytes`);
  return bytes;
}

function assertSafeKeys(value: unknown, path = "$", seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new WorkflowError(`${path}: cyclic values are not allowed`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeKeys(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new WorkflowError(`${path}: forbidden property ${key}`);
      assertSafeKeys(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function parseApiWorkflow(value: unknown): ApiWorkflow {
  assertSafeKeys(value);
  encodedSize(value);
  if (!ownRecord(value)) throw new WorkflowError("Workflow must be an API-format object keyed by node ID");
  if (Array.isArray(value.nodes)) {
    throw new WorkflowError("This appears to be a ComfyUI UI workflow; export API format before editing or running it");
  }
  if (Object.keys(value).length === 0) throw new WorkflowError("Workflow has no nodes");
  const clone: Record<string, ApiNode> = Object.create(null) as Record<string, ApiNode>;
  for (const [nodeId, raw] of Object.entries(value)) {
    if (!nodeId || nodeId.length > 128 || /[\u0000-\u001f]/.test(nodeId)) {
      throw new WorkflowError(`Invalid node ID: ${JSON.stringify(nodeId)}`);
    }
    if (!ownRecord(raw) || typeof raw.class_type !== "string" || !raw.class_type.trim()) {
      throw new WorkflowError(`Node ${nodeId} must contain a class_type string`);
    }
    if (!ownRecord(raw.inputs)) throw new WorkflowError(`Node ${nodeId} must contain an inputs object`);
    clone[nodeId] = structuredClone(raw) as ApiNode;
  }
  return clone;
}

type NodeSpec = { input: Record<string, unknown>; output: unknown; output_name: unknown; output_is_list?: unknown };

function nodeSpec(objectInfo: ObjectInfo | undefined, classType: string): NodeSpec | undefined {
  const spec = objectInfo?.[classType];
  return ownRecord(spec) ? (spec as unknown as NodeSpec) : undefined;
}

function inputDefinitions(spec: NodeSpec): { definitions: Record<string, unknown>; required: Set<string> } {
  const input = ownRecord(spec.input) ? spec.input : {};
  const requiredObject = ownRecord(input.required) ? input.required : {};
  const optionalObject = ownRecord(input.optional) ? input.optional : {};
  const definitions: Record<string, unknown> = { ...optionalObject, ...requiredObject };
  return { definitions, required: new Set(Object.keys(requiredObject)) };
}

function asConnection(value: unknown): [string, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  if (typeof value[0] !== "string" || !Number.isInteger(value[1])) {
    return undefined;
  }
  return [value[0], value[1] as number];
}

function declaredType(definition: unknown): string | undefined {
  return Array.isArray(definition) && typeof definition[0] === "string" ? definition[0] : undefined;
}

function enumOptions(definition: unknown): unknown[] | undefined {
  if (!Array.isArray(definition) || !Array.isArray(definition[0])) return undefined;
  return definition[0];
}

/** Validate graph structure and, when supplied, live ComfyUI node definitions. */
export function validateApiWorkflow(value: unknown, objectInfo?: ObjectInfo): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  let workflow: ApiWorkflow;
  try {
    workflow = parseApiWorkflow(value);
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: "$", message: error instanceof Error ? error.message : String(error) }],
      warnings,
    };
  }

  for (const [nodeId, node] of Object.entries(workflow)) {
    const spec = nodeSpec(objectInfo, node.class_type);
    if (objectInfo && !spec) {
      errors.push({ path: `${nodeId}.class_type`, message: `Unknown ComfyUI node type: ${node.class_type}` });
    }
    const defs = spec ? inputDefinitions(spec) : undefined;
    if (defs) {
      for (const inputName of defs.required) {
        if (!(inputName in node.inputs)) {
          errors.push({ path: `${nodeId}.inputs.${inputName}`, message: "Required input is missing" });
        }
      }
      for (const inputName of Object.keys(node.inputs)) {
        if (!(inputName in defs.definitions)) {
          warnings.push({ path: `${nodeId}.inputs.${inputName}`, message: "Input is not declared by live node metadata" });
          continue;
        }
        const choices = enumOptions(defs.definitions[inputName]);
        const inputValue = node.inputs[inputName];
        if (choices && !asConnection(inputValue) && !choices.some((choice) => Object.is(choice, inputValue))) {
          errors.push({ path: `${nodeId}.inputs.${inputName}`, message: `Value is not one of the live choices: ${choices.map(String).slice(0, 10).join(", ")}` });
        }
      }
    }
    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      if (!Array.isArray(inputValue)) continue;
      const edge = asConnection(inputValue);
      const path = `${nodeId}.inputs.${inputName}`;
      if (!edge) {
        errors.push({ path, message: "Connections must be [sourceNodeId, outputIndex] pairs" });
        continue;
      }
      const [sourceId, outputIndex] = edge;
      const source = workflow[sourceId];
      if (!source) {
        errors.push({ path, message: `Source node ${sourceId} does not exist` });
        continue;
      }
      const sourceSpec = nodeSpec(objectInfo, source.class_type);
      if (sourceSpec && Array.isArray(sourceSpec.output)) {
        if (outputIndex < 0 || outputIndex >= sourceSpec.output.length) {
          errors.push({ path, message: `Source output index ${outputIndex} is out of range` });
          continue;
        }
        const targetType = defs ? declaredType(defs.definitions[inputName]) : undefined;
        const sourceType = sourceSpec.output[outputIndex];
        if (targetType && typeof sourceType === "string" && targetType !== "*" && sourceType !== "*" &&
            targetType !== sourceType) {
          errors.push({ path, message: `Connection type mismatch: expected ${targetType}, got ${sourceType}` });
        }
      } else if (objectInfo && sourceSpec) {
        warnings.push({ path, message: `Output metadata is incomplete for ${source.class_type}` });
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

export type WorkflowSummary = {
  nodeCount: number;
  nodes: Array<{ id: string; classType: string; inputs: string[] }>;
  connections: number;
  outputNodes: string[];
};

export function summarizeApiWorkflow(value: unknown): WorkflowSummary {
  const workflow = parseApiWorkflow(value);
  const nodes = Object.entries(workflow).map(([id, node]) => ({ id, classType: node.class_type, inputs: Object.keys(node.inputs) }));
  const outputNodes: string[] = [];
  const referenced = new Set<string>();
  let connections = 0;
  for (const [id, node] of Object.entries(workflow)) {
    for (const inputValue of Object.values(node.inputs)) {
      const connection = asConnection(inputValue);
      if (connection) { connections += 1; referenced.add(connection[0]); }
    }
    if (/save|preview|output/i.test(node.class_type)) outputNodes.push(id);
  }
  if (!outputNodes.length) {
    for (const { id } of nodes) if (!referenced.has(id)) outputNodes.push(id);
  }
  return { nodeCount: nodes.length, nodes, connections, outputNodes: [...new Set(outputNodes)] };
}

export type WorkflowPatch =
  | { op: "setInput"; nodeId: string; input: string; value: JsonValue }
  | { op: "addNode"; nodeId: string; node: ApiNode }
  | { op: "removeNode"; nodeId: string; disconnect?: boolean }
  | { op: "connect"; sourceNodeId: string; outputIndex: number; targetNodeId: string; input: string }
  | { op: "disconnect"; targetNodeId: string; input: string };

function safeName(value: string, label: string): void {
  if (!value || FORBIDDEN_KEYS.has(value) || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    throw new WorkflowError(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

/** Apply explicit node/input edits to a new workflow object. The input is never mutated. */
export function applyWorkflowPatch(value: unknown, patches: WorkflowPatch[], objectInfo?: ObjectInfo): ApiWorkflow {
  if (!Array.isArray(patches) || patches.length > 1000) throw new WorkflowError("Patch must contain at most 1000 operations");
  const workflow = parseApiWorkflow(value);
  for (const patch of patches) {
    switch (patch.op) {
      case "setInput": {
        safeName(patch.nodeId, "node ID"); safeName(patch.input, "input name"); assertSafeKeys(patch.value); encodedSize(patch.value);
        const node = workflow[patch.nodeId];
        if (!node) throw new WorkflowError(`Node ${patch.nodeId} does not exist`);
        const spec = nodeSpec(objectInfo, node.class_type);
        if (objectInfo && !spec) throw new WorkflowError(`Unknown node type: ${node.class_type}`);
        if (spec && !(patch.input in inputDefinitions(spec).definitions)) {
          throw new WorkflowError(`Input ${patch.input} is not declared for ${node.class_type}`);
        }
        node.inputs[patch.input] = structuredClone(patch.value);
        break;
      }
      case "addNode": {
        safeName(patch.nodeId, "node ID");
        if (workflow[patch.nodeId]) throw new WorkflowError(`Node ${patch.nodeId} already exists`);
        const addition = parseApiWorkflow({ [patch.nodeId]: patch.node });
        const addedNode = addition[patch.nodeId];
        if (!addedNode) throw new WorkflowError("Failed to create node");
        if (objectInfo && !nodeSpec(objectInfo, addedNode.class_type)) {
          throw new WorkflowError(`Unknown node type: ${addedNode.class_type}`);
        }
        workflow[patch.nodeId] = addedNode;
        break;
      }
      case "removeNode": {
        safeName(patch.nodeId, "node ID");
        if (!workflow[patch.nodeId]) throw new WorkflowError(`Node ${patch.nodeId} does not exist`);
        const incoming: Array<[ApiNode, string]> = [];
        for (const node of Object.values(workflow)) {
          for (const [inputName, inputValue] of Object.entries(node.inputs)) {
            if (asConnection(inputValue)?.[0] === patch.nodeId) incoming.push([node, inputName]);
          }
        }
        if (incoming.length && !patch.disconnect) {
          throw new WorkflowError(`Node ${patch.nodeId} is connected; request disconnect: true to remove it`);
        }
        for (const [node, inputName] of incoming) delete node.inputs[inputName];
        delete workflow[patch.nodeId];
        break;
      }
      case "connect": {
        safeName(patch.sourceNodeId, "source node ID"); safeName(patch.targetNodeId, "target node ID"); safeName(patch.input, "input name");
        if (!Number.isInteger(patch.outputIndex) || patch.outputIndex < 0) throw new WorkflowError("outputIndex must be a non-negative integer");
        const source = workflow[patch.sourceNodeId]; const target = workflow[patch.targetNodeId];
        if (!source || !target) throw new WorkflowError("Both connection nodes must exist");
        if (!(patch.input in target.inputs)) throw new WorkflowError(`Input ${patch.input} does not exist on node ${patch.targetNodeId}`);
        target.inputs[patch.input] = [patch.sourceNodeId, patch.outputIndex];
        break;
      }
      case "disconnect": {
        safeName(patch.targetNodeId, "target node ID"); safeName(patch.input, "input name");
        const target = workflow[patch.targetNodeId];
        if (!target) throw new WorkflowError(`Node ${patch.targetNodeId} does not exist`);
        if (!asConnection(target.inputs[patch.input])) throw new WorkflowError(`Input ${patch.input} is not connected`);
        delete target.inputs[patch.input];
        break;
      }
      default:
        throw new WorkflowError("Unsupported workflow patch operation");
    }
  }
  const validation = validateApiWorkflow(workflow, objectInfo);
  if (!validation.valid) throw new WorkflowError(`Patched workflow is invalid: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  encodedSize(workflow);
  return workflow;
}
