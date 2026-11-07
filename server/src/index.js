import express from "express";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JobManager } from "./jobManager.js";
import { ProjectStore } from "./projectStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");
const workerPath = join(rootDir, "worker", "caption_worker.py");
const webDist = join(rootDir, "web", "dist");
const app = express();
const jobs = new JobManager();
const projects = new ProjectStore();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const pythonCommand = process.env.PYTHON_BIN || "python3";
const execFileAsync = promisify(execFile);
const datasetPreviews = new Map();
const supportedImageExtensions = new Set([".png", ".jpg", ".jpeg"]);
const providerDefaults = {
    "llama.cpp": { apiUrl: "http://localhost:8080", models: "openai" },
    ollama: { apiUrl: "http://localhost:11434", models: "ollama" },
    openai: { apiUrl: "https://api.openai.com/v1", models: "openai" },
    gemini: { apiUrl: "https://generativelanguage.googleapis.com/v1beta", models: "gemini" },
    anthropic: { apiUrl: "https://api.anthropic.com", models: "anthropic" },
    deepseek: { apiUrl: "https://api.deepseek.com/v1", models: "openai" },
};

app.use(express.json({ limit: "32kb" }));

function validateConfig(body) {
    const config = {
        apiType: String(body.apiType || "llama.cpp").trim().toLowerCase(),
        apiUrl: String(body.apiUrl || "http://localhost:8080").trim().replace(/\/$/, ""),
        modelName: String(body.modelName || "qwen2.5-vl").trim(),
        apiKey: String(body.apiKey || "").trim(),
        folderPath: String(body.folderPath || "").trim(),
        triggerWord: String(body.triggerWord || "").trim(),
        masterPrompt: String(body.masterPrompt || "").trim(),
        characterPrompt: String(body.characterPrompt || "").trim(),
        onlyMissing: Boolean(body.onlyMissing),
        captionFormat: String(body.captionFormat || "comma").trim(),
    };
    if (!/^https?:\/\//i.test(config.apiUrl)) throw new Error("Vision API URL must start with http:// or https://.");
    if (!Object.hasOwn(providerDefaults, config.apiType)) throw new Error("Unsupported API provider.");
    if (!config.modelName) throw new Error("A vision model name is required.");
    if (!config.folderPath) throw new Error("A dataset folder path is required.");
    if (!existsSync(config.folderPath)) throw new Error("The dataset folder does not exist.");
    return config;
}

function providerUrl(apiType, apiUrl) {
    const base = apiUrl.replace(/\/$/, "");
    if (["openai", "deepseek"].includes(apiType)) return base.endsWith("/v1") ? base : `${base}/v1`;
    if (apiType === "llama.cpp") return base.endsWith("/v1") ? base : `${base}/v1`;
    return base;
}

function providerHeaders(apiType, apiKey) {
    if (apiType === "anthropic") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    if (apiType === "gemini") return {};
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function providerHttpError(provider, status) {
    if ([401, 403].includes(status)) return `${provider} API key is missing, invalid, or unauthorized. Check the API key.`;
    if (status === 404) return `${provider} model or endpoint was not found. Check the API URL and model name.`;
    if ([400, 415].includes(status)) return `${provider} rejected the request. Check that the selected model supports images.`;
    return `${provider} connection failed with HTTP ${status}.`;
}

async function fetchProviderModels(apiType, apiUrl, apiKey) {
    if (["openai", "gemini", "anthropic", "deepseek"].includes(apiType) && !apiKey) throw new Error(`${apiType} API key is required. Enter it before loading models or testing the connection.`);
    if (apiType === "anthropic") {
        const response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/models`, { headers: providerHeaders(apiType, apiKey) });
        if (!response.ok) throw new Error(providerHttpError("Anthropic", response.status));
        const data = await response.json();
        return (data.data || []).map((model) => model.id).filter(Boolean);
    }
    if (apiType === "ollama") {
        const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/tags`);
        if (!response.ok) throw new Error(providerHttpError("Ollama", response.status));
        const data = await response.json();
        return (data.models || []).map((model) => model.name).filter(Boolean);
    }
    if (apiType === "gemini") {
        const response = await fetch(`${apiUrl.replace(/\/$/, "")}/models?key=${encodeURIComponent(apiKey)}`);
        if (!response.ok) throw new Error(providerHttpError("Gemini", response.status));
        const data = await response.json();
        return (data.models || []).map((model) => String(model.name || "").replace(/^models\//, "")).filter(Boolean);
    }
    const response = await fetch(`${providerUrl(apiType, apiUrl)}/models`, { headers: providerHeaders(apiType, apiKey) });
    if (!response.ok) throw new Error(providerHttpError(apiType, response.status));
    const data = await response.json();
    return (data.data || []).map((model) => model.id).filter(Boolean);
}

async function generatePrompt(apiType, apiUrl, modelName, apiKey, kind, brief, action = "generate") {
    if (!/^https?:\/\//i.test(apiUrl)) throw new Error("Vision API URL must start with http:// or https://.");
    if (!modelName) throw new Error("A vision model name is required.");
    if (!brief) throw new Error("Describe what the prompt should contain first.");
    const promptType = kind === "character" ? "character-specific rules for permanent traits, anatomy, and removable features" : "a global master prompt for image caption style, composition, environment, and formatting";
    const actionInstruction = action === "improve" ? "Improve clarity, specificity, and consistency without changing the user's intent." : action === "shorten" ? "Shorten the instruction while preserving every important constraint." : "Write the finished instruction from the rough request.";
    const instruction = `Write a concise, production-ready ${promptType} for a LoRA image captioning workflow. ${actionInstruction} The user's rough request is: ${brief}. Return only the finished instruction text, with no preamble, analysis, markdown fences, or labels.`;
    let endpoint;
    let payload;
    if (apiType === "ollama") {
        endpoint = `${apiUrl.replace(/\/$/, "")}/api/generate`;
        payload = { model: modelName, prompt: instruction, stream: false };
    } else if (apiType === "gemini") {
        endpoint = `${apiUrl.replace(/\/$/, "")}/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
        payload = { contents: [{ parts: [{ text: instruction }] }] };
    } else if (apiType === "anthropic") {
        endpoint = `${apiUrl.replace(/\/$/, "")}/v1/messages`;
        payload = { model: modelName, max_tokens: 1024, messages: [{ role: "user", content: instruction }] };
    } else {
        endpoint = `${providerUrl(apiType, apiUrl)}/chat/completions`;
        payload = { model: modelName, messages: [{ role: "user", content: instruction }], stream: false };
    }
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...providerHeaders(apiType, apiKey) }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Prompt model returned HTTP ${response.status}.`);
    const data = await response.json();
    const text = apiType === "ollama" ? data.response : apiType === "gemini" ? data.candidates?.[0]?.content?.parts?.[0]?.text : apiType === "anthropic" ? data.content?.[0]?.text : data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("Prompt model returned no text.");
    return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:text|markdown)?/gi, "").replace(/```/g, "").trim();
}

function startWorker(job) {
    const child = spawn(pythonCommand, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
    job.process = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                jobs.publish(job.id, JSON.parse(line));
            } catch {
                jobs.publish(job.id, { type: "log", level: "warning", message: "Worker emitted an invalid event." });
            }
        }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => jobs.publish(job.id, { type: "log", level: "warning", message: chunk.trim() }));
    child.on("error", (error) => jobs.finish(job.id, "error", { message: error.message }));
    child.on("close", (code) => {
        if (!["complete", "error"].includes(jobs.get(job.id)?.status)) {
            jobs.finish(job.id, code === 0 ? "complete" : "error", { message: code === 0 ? "Worker finished without a completion event." : `Worker exited with code ${code}.` });
        }
        runNextJob();
    });
    child.stdin.end(JSON.stringify(job.config));
}

function runNextJob() {
    if (jobs.activeJob()) return;
    const job = jobs.queuedJob();
    if (!job) return;
    jobs.publish(job.id, { type: "status", status: "starting", message: "Starting queued dataset..." });
    startWorker(job);
}

app.get("/api/health", (_request, response) => response.json({ ok: true, activeJob: jobs.activeJob()?.id ?? null }));

app.post("/api/models", async (request, response) => {
    try {
        const apiType = String(request.body.apiType || "llama.cpp").trim().toLowerCase();
        const apiUrl = String(request.body.apiUrl || providerDefaults[apiType]?.apiUrl || "").trim();
        const apiKey = String(request.body.apiKey || "").trim();
        if (!Object.hasOwn(providerDefaults, apiType)) throw new Error("Unsupported API provider.");
        const models = await fetchProviderModels(apiType, apiUrl, apiKey);
        response.json({ models });
    } catch (error) {
        response.status(400).json({ error: error.message });
    }
});

app.post("/api/test-connection", async (request, response) => {
    try {
        const apiType = String(request.body.apiType || "llama.cpp").trim().toLowerCase();
        const apiUrl = String(request.body.apiUrl || providerDefaults[apiType]?.apiUrl || "").trim();
        const apiKey = String(request.body.apiKey || "").trim();
        if (!Object.hasOwn(providerDefaults, apiType)) throw new Error("Unsupported API provider.");
        const models = await fetchProviderModels(apiType, apiUrl, apiKey);
        response.json({ ok: true, modelCount: models.length, message: `Connected. ${models.length} model(s) available.` });
    } catch (error) {
        response.status(400).json({ ok: false, error: error.message });
    }
});

app.post("/api/browse-folder", async (_request, response) => {
    const startPath = process.env.HOME || "/";
    const pickers = [
        ["kdialog", ["--getexistingdirectory", startPath, "--title", "Select dataset folder"]],
        ["zenity", ["--file-selection", "--directory", `--filename=${startPath}/`, "--title=Select dataset folder"]],
    ];
    for (const [command, argumentsList] of pickers) {
        try {
            const result = await execFileAsync(command, argumentsList, { timeout: 120000, maxBuffer: 1024 * 1024 });
            const folderPath = result.stdout.trim();
            if (folderPath) return response.json({ path: folderPath });
            return response.status(400).json({ error: "Folder selection was cancelled." });
        } catch (error) {
            if (error.code === "ENOENT" || error.code === 127) continue;
            if (error.killed) return response.status(408).json({ error: "Folder picker timed out." });
            if (error.code === 1) return response.status(400).json({ error: "Folder selection was cancelled." });
        }
    }
    return response.status(500).json({ error: "No native folder picker is available on the server." });
});

app.post("/api/dataset-preview", (request, response) => {
    const folderPath = resolve(String(request.body.folderPath || "").trim());
    if (!folderPath || !existsSync(folderPath)) return response.status(400).json({ error: "The dataset folder does not exist." });
    const images = readdirSync(folderPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && supportedImageExtensions.has(extname(entry.name).toLowerCase()))
        .map((entry) => {
            const captionPath = resolve(folderPath, `${entry.name.replace(/\.[^.]+$/, "")}.txt`);
            return { filename: entry.name, size: statSync(resolve(folderPath, entry.name)).size, captionExists: existsSync(captionPath) };
        })
        .sort((left, right) => left.filename.localeCompare(right.filename, undefined, { numeric: true, sensitivity: "base" }));
    const previewId = randomUUID();
    datasetPreviews.set(previewId, { folderPath, createdAt: Date.now() });
    response.json({ previewId, total: images.length, captioned: images.filter((image) => image.captionExists).length, missing: images.filter((image) => !image.captionExists).length, images: images.slice(0, 300) });
});

app.post("/api/captions", (request, response) => {
    const folderPath = resolve(String(request.body.folderPath || "").trim());
    const filename = String(request.body.filename || "");
    const caption = String(request.body.caption || "").trim();
    if (!existsSync(folderPath) || !caption || !filename || filename !== resolve(filename).split(/[\\/]/).pop() || !supportedImageExtensions.has(extname(filename).toLowerCase())) {
        return response.status(400).json({ error: "Invalid caption save request." });
    }
    const captionPath = resolve(folderPath, `${filename.replace(/\.[^.]+$/, "")}.txt`);
    const previousCaption = existsSync(captionPath) ? readFileSync(captionPath, "utf8").trim() : "";
    const historyPath = resolve(folderPath, ".caption-history.json");
    let historyStore = {};
    try { historyStore = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : {}; } catch { historyStore = {}; }
    const history = Array.isArray(historyStore[captionPath.split(/[\\/]/).pop()]) ? historyStore[captionPath.split(/[\\/]/).pop()] : [];
    const legacyPath = `${captionPath}.history.json`;
    try { if (existsSync(legacyPath)) { history.push(...JSON.parse(readFileSync(legacyPath, "utf8"))); unlinkSync(legacyPath); } } catch { /* Keep a malformed legacy file untouched. */ }
    if (previousCaption !== caption) {
        history.push({ timestamp: new Date().toISOString(), previous: previousCaption, next: caption, source: "manual" });
    }
    historyStore[captionPath.split(/[\\/]/).pop()] = history.slice(-50);
    writeFileSync(historyPath, `${JSON.stringify(historyStore, null, 2)}\n`, "utf8");
    writeFileSync(captionPath, `${caption}\n`, "utf8");
    response.json({ ok: true, filename, caption, previousCaption });
});

app.post("/api/captions/history", (request, response) => {
    const folderPath = resolve(String(request.body.folderPath || "").trim());
    const filename = String(request.body.filename || "");
    if (!existsSync(folderPath) || !filename || filename !== resolve(filename).split(/[\\/]/).pop()) return response.status(400).json({ error: "Invalid caption history request." });
    const historyPath = resolve(folderPath, ".caption-history.json");
    const key = `${filename.replace(/\.[^.]+$/, "")}.txt`;
    try {
        const store = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : {};
        return response.json({ history: Array.isArray(store[key]) ? store[key] : [] });
    } catch { return response.json({ history: [] }); }
});

app.get("/api/dataset-preview/:previewId/images/:filename", (request, response) => {
    const preview = datasetPreviews.get(request.params.previewId);
    if (!preview) return response.status(404).json({ error: "Dataset preview expired." });
    const filename = request.params.filename;
    const extension = extname(filename).toLowerCase();
    if (!filename || filename !== resolve(filename).split(/[\\/]/).pop() || !supportedImageExtensions.has(extension)) {
        return response.status(400).json({ error: "Invalid image filename." });
    }
    const imagePath = resolve(preview.folderPath, filename);
    const relativePath = relative(preview.folderPath, imagePath);
    if (relativePath.startsWith("..") || relativePath.includes(".." + "/") || relativePath.includes(".." + "\\") || !existsSync(imagePath)) {
        return response.status(404).json({ error: "Image not found." });
    }
    return response.sendFile(imagePath);
});

app.post("/api/prompts/generate", async (request, response) => {
    try {
        const apiType = String(request.body.apiType || "llama.cpp").trim().toLowerCase();
        if (!Object.hasOwn(providerDefaults, apiType)) throw new Error("Unsupported API provider.");
        const text = await generatePrompt(apiType, String(request.body.apiUrl || "").trim(), String(request.body.modelName || "").trim(), String(request.body.apiKey || "").trim(), String(request.body.kind || "master"), String(request.body.brief || "").trim(), String(request.body.action || "generate"));
        response.json({ prompt: text });
    } catch (error) {
        response.status(400).json({ error: error.message });
    }
});

app.get("/api/projects", (_request, response) => response.json({ projects: projects.list() }));

app.post("/api/projects", (request, response) => {
    const name = String(request.body.name || "").trim();
    if (!name) return response.status(400).json({ error: "Project name is required." });
    response.status(201).json({ project: projects.create(name, request.body.config || {}) });
});

app.put("/api/projects/:id", (request, response) => {
    const name = String(request.body.name || "").trim();
    if (!name) return response.status(400).json({ error: "Project name is required." });
    const project = projects.update(request.params.id, name, request.body.config || {});
    if (!project) return response.status(404).json({ error: "Project not found." });
    response.json({ project });
});

app.post("/api/projects/:id/clone", (request, response) => {
    const name = String(request.body.name || "").trim();
    if (!name) return response.status(400).json({ error: "Project name is required." });
    const project = projects.clone(request.params.id, name);
    if (!project) return response.status(404).json({ error: "Project not found." });
    response.status(201).json({ project });
});

app.delete("/api/projects/:id", (request, response) => {
    if (!projects.remove(request.params.id)) return response.status(404).json({ error: "Project not found." });
    response.status(204).end();
});

app.get("/api/jobs", (_request, response) => response.json({ jobs: jobs.list() }));

app.post("/api/jobs", (request, response) => {
    try {
        const job = jobs.create(validateConfig(request.body));
        jobs.publish(job.id, { type: "status", status: "queued", message: "Added to the captioning queue." });
        runNextJob();
        response.status(202).json({ jobId: job.id, status: job.status });
    } catch (error) {
        response.status(error.statusCode || 400).json({ error: error.message });
    }
});

app.delete("/api/jobs/:id", (request, response) => {
    const job = jobs.get(request.params.id);
    if (!jobs.cancel(request.params.id)) return response.status(404).json({ error: "Job is not active or was not found." });
    if (!job?.process) runNextJob();
    response.status(202).json({ cancelled: true });
});

app.post("/api/jobs/:id/pause", (request, response) => {
    if (!jobs.pause(request.params.id)) return response.status(400).json({ error: "Only a running workflow can be paused." });
    response.json({ paused: true });
});

app.post("/api/jobs/:id/resume", (request, response) => {
    if (!jobs.resume(request.params.id)) return response.status(400).json({ error: "Only a paused workflow can be resumed." });
    response.json({ resumed: true });
});

app.post("/api/jobs/:id/retry-failed", (request, response) => {
    const source = jobs.get(request.params.id);
    if (!source || !source.failedFiles.length) return response.status(400).json({ error: "This workflow has no failed files to retry." });
    const job = jobs.create({ ...source.config, onlyMissing: false, onlyFiles: source.failedFiles });
    jobs.publish(job.id, { type: "status", status: "queued", message: `Retry queued for ${source.failedFiles.length} failed file(s).` });
    runNextJob();
    response.status(202).json({ jobId: job.id, status: job.status });
});

app.post("/api/jobs/:id/retry-file", (request, response) => {
    const source = jobs.get(request.params.id);
    const filename = String(request.body.filename || "");
    if (!source || !filename || !source.failedFiles.includes(filename)) return response.status(400).json({ error: "This file is not marked as failed in the workflow." });
    const job = jobs.create({ ...source.config, onlyMissing: false, onlyFiles: [filename] });
    jobs.publish(job.id, { type: "status", status: "queued", message: `Retry queued for ${filename}.` });
    runNextJob();
    response.status(202).json({ jobId: job.id, status: job.status });
});

app.get("/api/jobs/:id/report", (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) return response.status(404).json({ error: "Workflow not found." });
    response.setHeader("Content-Disposition", `attachment; filename="caption-report-${job.id.slice(0, 8)}.json"`);
    response.json({ id: job.id, status: job.status, createdAt: job.createdAt, progress: job.progress, failedFiles: job.failedFiles, summary: job.summary });
});

app.post("/api/open-folder", (request, response) => {
    const folderPath = resolve(String(request.body.folderPath || "").trim());
    if (!existsSync(folderPath)) return response.status(400).json({ error: "Dataset folder does not exist." });
    execFile("xdg-open", [folderPath], (error) => {
        if (error) return response.status(500).json({ error: "Could not open the dataset folder." });
        response.json({ opened: true });
    });
});

app.get("/api/jobs/:id/images/:filename", (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) return response.status(404).json({ error: "Job not found." });
    const filename = request.params.filename;
    const extension = extname(filename).toLowerCase();
    if (!filename || filename !== resolve(filename).split(/[\\/]/).pop() || ![".png", ".jpg", ".jpeg"].includes(extension)) {
        return response.status(400).json({ error: "Invalid image filename." });
    }
    const folderPath = resolve(job.config.folderPath);
    const imagePath = resolve(folderPath, filename);
    const relativePath = relative(folderPath, imagePath);
    if (relativePath.startsWith("..") || relativePath.includes(".." + "/") || relativePath.includes(".." + "\\") || !existsSync(imagePath)) {
        return response.status(404).json({ error: "Image not found." });
    }
    return response.sendFile(imagePath);
});

app.get("/api/jobs/:id/events", (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) return response.status(404).json({ error: "Job not found." });
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    for (const event of job.events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    jobs.addClient(job.id, response);
    request.on("close", () => jobs.removeClient(job.id, response));
});

if (process.env.NODE_ENV === "production" && existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((request, response, next) => {
        if (request.method === "GET" && !request.path.startsWith("/api/")) {
            return response.sendFile(join(webDist, "index.html"));
        }
        return next();
    });
}

app.listen(port, host, () => console.log(`LoRA Smart Captioner server listening on http://${host}:${port}`));
