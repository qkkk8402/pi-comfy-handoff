import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkflowPatch,
  parseApiWorkflow,
  summarizeApiWorkflow,
  validateApiWorkflow,
  WorkflowError,
  type ApiWorkflow,
  type ObjectInfo,
} from "../src/workflow.js";

const objectInfo: ObjectInfo = {
  Source: { input: { required: {} }, output: ["MODEL"], output_name: ["model"] },
  WrongSource: { input: { required: {} }, output: ["CLIP"], output_name: ["clip"] },
  Save: { input: { required: { model: ["MODEL"], filename_prefix: ["STRING", { default: "image" }] }, optional: {} }, output: [], output_name: [] },
  Optional: { input: { required: {}, optional: { model: ["MODEL"] } }, output: [], output_name: [] },
};
const valid: ApiWorkflow = {
  "1": { class_type: "Source", inputs: {} },
  "2": { class_type: "Save", inputs: { model: ["1", 0], filename_prefix: "test" } },
};

test("validates required inputs, live node classes, and link output types", () => {
  assert.equal(validateApiWorkflow(valid, objectInfo).valid, true);
  const missing = structuredClone(valid);
  delete missing["2"]!.inputs.filename_prefix;
  assert.match(validateApiWorkflow(missing, objectInfo).errors[0]!.message, /Required input/);
  const badType = structuredClone(valid);
  badType["2"]!.inputs.model = ["1", 2];
  assert.match(validateApiWorkflow(badType, objectInfo).errors[0]!.message, /out of range/);
  const wrongType = structuredClone(valid);
  wrongType["1"]!.class_type = "WrongSource";
  assert.match(validateApiWorkflow(wrongType, objectInfo).errors[0]!.message, /type mismatch/);
});

test("rejects UI-format, empty, oversized, and unsafe-key workflows", () => {
  assert.throws(() => parseApiWorkflow({ nodes: [], links: [] }), /UI workflow/);
  assert.throws(() => parseApiWorkflow({}), /no nodes/);
  assert.throws(() => parseApiWorkflow(JSON.parse('{"1":{"class_type":"X","inputs":{},"__proto__":{}}}')), /forbidden property/);
});

test("summarizes nodes, links, and terminal workflow nodes", () => {
  assert.deepEqual(summarizeApiWorkflow(valid), {
    nodeCount: 2,
    nodes: [
      { id: "1", classType: "Source", inputs: [] },
      { id: "2", classType: "Save", inputs: ["model", "filename_prefix"] },
    ],
    connections: 1,
    outputNodes: ["2"],
  });
});

test("patches are immutable and dangling node removal requires explicit disconnect", () => {
  const patched = applyWorkflowPatch(valid, [{ op: "setInput", nodeId: "2", input: "filename_prefix", value: "changed" }], objectInfo);
  assert.equal(patched["2"]!.inputs.filename_prefix, "changed");
  assert.equal(valid["2"]!.inputs.filename_prefix, "test");
  assert.throws(() => applyWorkflowPatch(valid, [{ op: "removeNode", nodeId: "1" }], objectInfo), /connected/);
});

test("disconnect and explicit source removal preserve a valid graph", () => {
  const patch = [
    { op: "setInput", nodeId: "2", input: "model", value: "fallback" },
    { op: "removeNode", nodeId: "1" },
  ] as const;
  const result = applyWorkflowPatch(valid, patch as unknown as Parameters<typeof applyWorkflowPatch>[1], objectInfo);
  assert.deepEqual(Object.keys(result), ["2"]);

  const optionalWorkflow: ApiWorkflow = {
    "1": { class_type: "Source", inputs: {} },
    "2": { class_type: "Optional", inputs: { model: ["1", 0] } },
  };
  const disconnected = applyWorkflowPatch(optionalWorkflow, [
    { op: "disconnect", targetNodeId: "2", input: "model" },
  ], objectInfo);
  assert.equal("model" in disconnected["2"]!.inputs, false);
  const removed = applyWorkflowPatch(optionalWorkflow, [
    { op: "removeNode", nodeId: "1", disconnect: true },
  ], objectInfo);
  assert.deepEqual(Object.keys(removed), ["2"]);
  assert.equal("model" in removed["2"]!.inputs, false);
});

test("rejects input names that can mutate object prototypes", () => {
  assert.throws(() => applyWorkflowPatch(valid, [{ op: "setInput", nodeId: "2", input: "__proto__", value: {} }]), WorkflowError);
});
