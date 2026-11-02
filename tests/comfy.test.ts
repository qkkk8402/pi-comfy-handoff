import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ComfyCancelError, ComfyClient } from "../src/comfy.js";
import { OutcomeUnknown, type Workflow } from "../src/types.js";

const objectInfo = {
  Source: { input: { required: {} }, output: ["MODEL"], output_name: ["model"] },
  Save: { input: { required: { model: ["MODEL"], filename_prefix: ["STRING", { default: "image" }] }, optional: {} }, output: [], output_name: [] },
};
const workflow: Workflow = {
  "1": { class_type: "Source", inputs: {} },
  "2": { class_type: "Save", inputs: { model: ["1", 0], filename_prefix: "cat" } },
};

async function requestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

test("submits a validated workflow with job metadata and a unique client ID", async () => {
  await serve(async (req, res) => {
    if (req.url === "/object_info") { sendJson(res, objectInfo); return; }
    if (req.url === "/prompt") {
      const body = await requestBody(req) as { prompt: unknown; client_id: string; extra_data: { pi: { job_id: string } } };
      assert.deepEqual(body.prompt, workflow);
      assert.equal(body.extra_data.pi.job_id, "job-1");
      assert.ok(body.client_id.length > 10);
      sendJson(res, { prompt_id: "prompt-1", number: 1 });
      return;
    }
    sendJson(res, { error: "unexpected" }, 404);
  }, async (baseUrl) => {
    const client = new ComfyClient(baseUrl);
    assert.equal(await client.submit(workflow, "job-1"), "prompt-1");
  });
});

test("waits for exact prompt history and returns output references", async () => {
  let polls = 0;
  await serve(async (req, res) => {
    if (req.url === "/history/prompt-1") {
      polls += 1;
      sendJson(res, polls < 2 ? {} : { "prompt-1": {
        status: { status_str: "success", completed: true },
        outputs: { "2": { images: [{ filename: "cat.png", subfolder: "", type: "output" }] } },
      } });
      return;
    }
    sendJson(res, { queue_running: [], queue_pending: [] });
  }, async (baseUrl) => {
    const client = new ComfyClient(baseUrl, { pollMs: 1 });
    const result = await client.wait("prompt-1");
    assert.equal(polls, 2);
    assert.equal(result.promptId, "prompt-1");
    const output = result.outputs[0] as { nodeId: string; filename: string; viewUrl: string };
    assert.equal(output.nodeId, "2");
    assert.equal(output.filename, "cat.png");
    assert.match(output.viewUrl, /filename=cat.png/);
  });
});

test("waits for long-running generations when generationMs is zero", async () => {
  let polls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await serve(async (req, res) => {
    if (req.url === "/history/prompt-1") {
      polls++;
      if (polls === 1) await gate;
      sendJson(res, polls < 2 ? {} : { "prompt-1": { status: { status_str: "success", completed: true }, outputs: {} } });
      return;
    }
    if (req.url === "/queue") { sendJson(res, { queue_running: [[0, "prompt-1"]], queue_pending: [] }); return; }
    sendJson(res, {}, 404);
  }, async (baseUrl) => {
    const client = new ComfyClient(baseUrl, { pollMs: 1, generationMs: 0 });
    const waiting = client.wait("prompt-1");
    try {
      while (polls === 0) await new Promise(resolve => setTimeout(resolve, 1));
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(polls, 1, "the request remains pending without a generation deadline");
    } finally { release(); }
    const result = await waiting;
    assert.equal(result.promptId, "prompt-1");
    assert.equal(polls, 2);
  });
});

test("does not treat a job missing from history and queue as successful", async () => {
  await serve((_req, res) => sendJson(res, { queue_running: [], queue_pending: [] }), async (baseUrl) => {
    const client = new ComfyClient(baseUrl, { pollMs: 1, unknownGraceMs: 5, generationMs: 100 });
    await assert.rejects(client.wait("gone"), OutcomeUnknown);
  });
});

test("fails closed when ComfyUI queue status is missing or malformed", async () => {
  let body: unknown = {};
  await serve((_req, res) => sendJson(res, body), async (baseUrl) => {
    const client = new ComfyClient(baseUrl);
    await assert.rejects(client.queue(), /missing queue_running or queue_pending/);
    body = { queue_running: [[0]], queue_pending: [] };
    await assert.rejects(client.queue(), /no valid prompt ID/);
  });
});

test("ambiguous server errors and disconnects from submit require reconciliation", async () => {
  await serve(async (req, res) => {
    if (req.url === "/object_info") { sendJson(res, objectInfo); return; }
    if (req.url === "/prompt") { await requestBody(req); sendJson(res, { error: "later" }, 500); return; }
    sendJson(res, {});
  }, async (baseUrl) => {
    const client = new ComfyClient(baseUrl);
    await assert.rejects(client.submit(workflow, "job-uncertain"), OutcomeUnknown);
  });
});

test("refuses server-wide interrupt unless isolated and the target is the sole running job", async () => {
  let interrupted = false;
  await serve(async (req, res) => {
    if (req.url === "/queue") { sendJson(res, { queue_running: [[1, "prompt-1"], [2, "other"]], queue_pending: [] }); return; }
    if (req.url === "/interrupt") interrupted = true;
    sendJson(res, {});
  }, async (baseUrl) => {
    const client = new ComfyClient(baseUrl, { dedicatedServer: true });
    await assert.rejects(client.cancel("prompt-1"), ComfyCancelError);
    assert.equal(interrupted, false);
  });
});

test("uses a targeted interrupt and accepts ComfyUI's empty success body", async () => {
  let running = true;
  await serve(async (req, res) => {
    if (req.url === "/queue") {
      sendJson(res, { queue_running: running ? [[1, "prompt-1"]] : [], queue_pending: [] });
      return;
    }
    if (req.url === "/interrupt") {
      assert.deepEqual(await requestBody(req), { prompt_id: "prompt-1" });
      running = false;
      res.writeHead(200);
      res.end();
      return;
    }
    sendJson(res, {});
  }, async (baseUrl) => { await new ComfyClient(baseUrl, { dedicatedServer: true }).cancel("prompt-1"); });
});

test("deletes only the named queued prompt and accepts an empty success body", async () => {
  let pending = true;
  await serve(async (req, res) => {
    if (req.url === "/queue" && req.method === "GET") {
      sendJson(res, { queue_running: [], queue_pending: pending ? [[1, "prompt-1"]] : [] });
      return;
    }
    if (req.url === "/queue" && req.method === "POST") {
      assert.deepEqual(await requestBody(req), { delete: ["prompt-1"] });
      pending = false;
      res.writeHead(200);
      res.end();
      return;
    }
    sendJson(res, {});
  }, async (baseUrl) => { await new ComfyClient(baseUrl, { pollMs: 1 }).cancel("prompt-1"); });
});

test("requests both model unload and memory release", async () => {
  await serve(async (req, res) => {
    if (req.url === "/free") {
      assert.deepEqual(await requestBody(req), { unload_models: true, free_memory: true });
      res.writeHead(200);
      res.end();
      return;
    }
    sendJson(res, {});
  }, async (baseUrl) => { await new ComfyClient(baseUrl).free(); });
});

test("waitForRelease observes stable CUDA-compatible headroom after free", async () => {
  let freeCalled = false;
  let reads = 0;
  await serve(async (req, res) => {
    if (req.url === "/free") { freeCalled = true; res.writeHead(200); res.end(); return; }
    if (req.url === "/queue") { sendJson(res, { queue_running: [], queue_pending: [] }); return; }
    if (req.url === "/system_stats") {
      assert.equal(freeCalled, true);
      reads += 1;
      const reserved = reads === 1 ? 300 : 200;
      sendJson(res, { devices: [{ type: "cuda", vram_free: 800 * 1024 * 1024, torch_vram_free: 100 * 1024 * 1024, torch_vram_total: reserved * 1024 * 1024 }] });
      return;
    }
    sendJson(res, {}, 404);
  }, async (baseUrl) => {
    const client = new ComfyClient(baseUrl, { pollMs: 1, settleMs: 100 });
    await client.free();
    await client.waitForRelease(600);
    assert.ok(reads >= 3);
  });
});

test("Comfy requests support bearer auth and prefixed endpoints", async () => {
  await serve(async (req, res) => {
    assert.equal(req.url, "/prefix/queue");
    assert.equal(req.headers.authorization, "Bearer secret");
    sendJson(res, { queue_running: [], queue_pending: [] });
  }, async (baseUrl) => {
    const client = new ComfyClient(`${baseUrl}/prefix/`, { apiKey: "secret" });
    await client.queue();
  });
});

test("does not claim release when GPU metrics are unsupported or malformed", async () => {
  await serve(async (req, res) => {
    if (req.url === "/queue") { sendJson(res, { queue_running: [], queue_pending: [] }); return; }
    sendJson(res, { devices: [{ type: "mps", vram_free: 1024 }] });
  }, async (baseUrl) => {
    const client = new ComfyClient(baseUrl, { settleMs: 100 });
    await assert.rejects(client.waitForRelease(), OutcomeUnknown);
  });
});

test("streams input files to ComfyUI without overwriting an existing upload", async () => {
  const dir = await mkdtemp(join(process.cwd(), "work", "comfy-upload-test-"));
  const input = join(dir, "clip.mp4");
  await writeFile(input, Buffer.from("media-bytes"));
  try {
    await serve(async (req, res) => {
      assert.equal(req.url, "/upload/image");
      assert.match(req.headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      assert.match(body, /name="overwrite"\r\n\r\nfalse/);
      assert.match(body, /name="type"\r\n\r\ninput/);
      assert.match(body, /filename="clip.mp4"/);
      assert.ok(body.includes("\r\n\r\nmedia-bytes\r\n--"));
      sendJson(res, { name: "clip.mp4", subfolder: "session-1", type: "input" });
    }, async (baseUrl) => {
      const result = await new ComfyClient(baseUrl).uploadInput(input, "session-1");
      assert.deepEqual(result, { name: "clip.mp4", subfolder: "session-1", type: "input" });
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rejects unsafe output paths before downloading", async () => {
  const outputDir = await mkdtemp(join(process.cwd(), "work", "comfy-test-"));
  try {
    await serve(async (req, res) => {
      if (req.url === "/history/prompt-1") {
        sendJson(res, { "prompt-1": { status: { status_str: "success", completed: true }, outputs: { "2": { images: [{ filename: "../escape.png", type: "output" }] } } } });
        return;
      }
      sendJson(res, { queue_running: [], queue_pending: [] });
    }, async (baseUrl) => {
      const client = new ComfyClient(baseUrl, { outputDir, pollMs: 1 });
      await assert.rejects(client.wait("prompt-1"), /Unsafe ComfyUI output filename/);
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("does not overwrite or delete an existing output file", async () => {
  const outputDir = await mkdtemp(join(process.cwd(), "work", "comfy-output-test-"));
  const existing = join(outputDir, "prompt-1-0-cat.png");
  await writeFile(existing, "keep");
  try {
    await serve(async (req, res) => {
      if (req.url === "/history/prompt-1") {
        sendJson(res, { "prompt-1": {
          status: { status_str: "success", completed: true },
          outputs: { "2": { images: [{ filename: "cat.png", type: "output" }] } },
        } });
        return;
      }
      res.writeHead(500);
      res.end("download should not be requested");
    }, async (baseUrl) => {
      await assert.rejects(new ComfyClient(baseUrl, { outputDir }).wait("prompt-1"), /already exists/);
      assert.equal((await readFile(existing, "utf8")), "keep");
    });
  } finally { await rm(outputDir, { recursive: true, force: true }); }
});

test("removes incomplete downloaded output when the transfer is interrupted", async () => {
  const cwd = await mkdtemp(join(process.cwd(), "work", "comfy-download-interrupted-"));
  const outputDir = join(cwd, "outputs");
  try {
    await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "100000" });
      res.write(Buffer.alloc(32));
      setTimeout(() => res.destroy(), 5);
    }, async (baseUrl) => {
      const client = new ComfyClient(baseUrl, { outputDir });
      await assert.rejects(client.downloadOutput("prompt", { nodeId: "1", filename: "partial.png", subfolder: "", type: "output" }, 0));
      assert.deepEqual(await readdir(outputDir), [], "partial data must not look like a completed output file");
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
