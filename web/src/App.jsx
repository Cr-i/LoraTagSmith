import { useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, Copy, Download, Eye, EyeOff, FolderOpen, Image, LoaderCircle, Pause, Play, Plus, RefreshCw, RotateCcw, Save, Server, Sparkles, Terminal, Trash2, XCircle } from "lucide-react";

const defaults = {
    apiType: "llama.cpp",
    apiUrl: "http://localhost:8080",
    modelName: "qwen2.5-vl",
    apiKey: "",
    folderPath: "",
    triggerWord: "",
    onlyMissing: false,
    captionFormat: "comma",
    masterPrompt: "Describe the visible subject, composition, lighting, environment, clothing, colors, and camera perspective. Use concise comma-separated tags suitable for LoRA training.",
    characterPrompt: "Preserve the character's permanent genetic traits and fixed anatomy. Mention removable clothing and accessories separately from locked physical features.",
};

function loadSettings() {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem("lora-captioner-settings") || "{}"), apiKey: "" } } catch { return defaults; }
}

function comparableConfig(config) {
    const { apiKey, ...safeConfig } = config;
    return JSON.stringify(safeConfig);
}

const providerDefaults = {
    "llama.cpp": "http://localhost:8080",
    ollama: "http://localhost:11434",
    openai: "https://api.openai.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    anthropic: "https://api.anthropic.com",
    deepseek: "https://api.deepseek.com/v1",
};

const emptyProjectConfig = {
    apiType: "llama.cpp",
    apiUrl: "http://localhost:8080",
    modelName: "qwen2.5-vl",
    apiKey: "",
    folderPath: "",
    triggerWord: "",
    onlyMissing: false,
    captionFormat: "comma",
    masterPrompt: "",
    characterPrompt: "",
};

const promptPresets = {
    master: {
        "Anime character": "Anime character portrait, clean line art, expressive eyes, detailed hair, balanced composition, clear background separation.",
        "Realistic portrait": "Realistic portrait photography, natural skin texture, controlled lighting, accurate anatomy, detailed environment, shallow depth of field.",
        "Product photography": "Professional product photography, centered subject, clean studio lighting, accurate material texture, uncluttered background, sharp details.",
        "Dataset tags": "Describe only visible details as concise comma-separated tags, prioritizing subject, pose, clothing, environment, lighting, colors, and camera perspective.",
    },
    character: {
        "Anime character": "Lock permanent anime character traits, facial structure, eye color, hairstyle, body proportions, and distinctive anatomy. Keep clothing and accessories removable.",
        "Realistic portrait": "Lock permanent facial identity, skin tone, eye color, hair characteristics, body proportions, and anatomy. Treat clothing, jewelry, and accessories as removable.",
        "Product photography": "Lock the product's permanent shape, materials, dimensions, markings, and distinctive design features. Treat packaging and props as removable context.",
        "Dataset tags": "Always preserve fixed identity and anatomy traits. Separate permanent features from removable clothing, accessories, pose, and environment.",
    },
};

function App() {
    const [form, setForm] = useState(loadSettings);
    const [projects, setProjects] = useState([]);
    const [selectedProjectId, setSelectedProjectId] = useState(null);
    const [projectName, setProjectName] = useState("");
    const [newProjectName, setNewProjectName] = useState("");
    const [projectDialogOpen, setProjectDialogOpen] = useState(false);
    const [savedSnapshot, setSavedSnapshot] = useState(null);
    const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);
    const [pendingProject, setPendingProject] = useState(null);
    const [jobs, setJobs] = useState([]);
    const [generatorOpen, setGeneratorOpen] = useState({ master: false, character: false });
    const [generatorBrief, setGeneratorBrief] = useState({ master: "", character: "" });
    const [generatorLoading, setGeneratorLoading] = useState({ master: false, character: false });
    const [promptPreview, setPromptPreview] = useState({ master: "", character: "" });
    const [promptHistory, setPromptHistory] = useState(() => {
        try { return JSON.parse(localStorage.getItem("lora-captioner-prompt-history") || "[]"); } catch { return []; }
    });
    const [browseLoading, setBrowseLoading] = useState(false);
    const [models, setModels] = useState([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState("");
    const [showApiKey, setShowApiKey] = useState(false);
    const [datasetPreview, setDatasetPreview] = useState(null);
    const [selectedDatasetImages, setSelectedDatasetImages] = useState([]);
    const [previewFilter, setPreviewFilter] = useState("all");
    const [lightbox, setLightbox] = useState(null);
    const [historyDialog, setHistoryDialog] = useState(null);
    const [jobId, setJobId] = useState(null);
    const [state, setState] = useState({ status: "idle", total: 0, completed: 0, success: 0, failed: 0, current: "", logs: [], items: [] });
    const [error, setError] = useState("");
    const running = ["starting", "running", "paused"].includes(state.status);
    const percent = useMemo(() => state.total ? Math.round((state.completed / state.total) * 100) : 0, [state.completed, state.total]);
    const isDirty = Boolean(savedSnapshot && comparableConfig(form) !== savedSnapshot);

    useEffect(() => {
        const { apiKey, ...safeForm } = form;
        localStorage.setItem("lora-captioner-settings", JSON.stringify(safeForm));
    }, [form]);

    useEffect(() => localStorage.setItem("lora-captioner-prompt-history", JSON.stringify(promptHistory.slice(-30))), [promptHistory]);

    useEffect(() => {
        function handleDatasetThumbClick(event) {
            const button = event.target.closest(".dataset-thumb");
            if (!button) return;
            const filename = button.querySelector("img")?.alt;
            if (!filename) return;
            event.preventDefault();
            event.stopPropagation();
            setSelectedDatasetImages((current) => current.includes(filename) ? current.filter((item) => item !== filename) : [...current, filename]);
        }
        document.addEventListener("click", handleDatasetThumbClick, true);
        return () => document.removeEventListener("click", handleDatasetThumbClick, true);
    }, []);

    useEffect(() => {
        document.querySelectorAll(".dataset-thumb").forEach((button) => {
            const filename = button.querySelector("img")?.alt;
            button.classList.toggle("selected", Boolean(filename && selectedDatasetImages.includes(filename)));
        });
    }, [selectedDatasetImages]);

    useEffect(() => {
        async function loadProjects() {
            const response = await fetch("/api/projects");
            const data = await response.json();
            setProjects(data.projects || []);
            if (data.projects?.length && !selectedProjectId) {
                const first = data.projects[0];
                setSelectedProjectId(first.id);
                setProjectName(first.name);
                setForm({ ...emptyProjectConfig, ...first.config, apiKey: "" });
                setSavedSnapshot(comparableConfig({ ...emptyProjectConfig, ...first.config }));
                if (first.config.folderPath) loadDatasetPreview(first.config.folderPath);
            }
        }
        loadProjects().catch(() => setError("Projects could not be loaded."));
    }, [selectedProjectId]);

    useEffect(() => {
        async function loadJobs() {
            const response = await fetch("/api/jobs");
            const data = await response.json();
            setJobs(data.jobs || []);
        }
        loadJobs().catch(() => undefined);
        const timer = window.setInterval(() => loadJobs().catch(() => undefined), 1500);
        return () => window.clearInterval(timer);
    }, []);

    function update(key, value) { setForm((current) => ({ ...current, [key]: value })); }

    function applyProject(project) {
        setSelectedProjectId(project.id);
        setProjectName(project.name);
        setForm({ ...emptyProjectConfig, ...project.config, apiKey: "" });
        setSavedSnapshot(comparableConfig({ ...emptyProjectConfig, ...project.config }));
        if (project.config.folderPath) loadDatasetPreview(project.config.folderPath);
        else setDatasetPreview(null);
        setError("");
    }

    function selectProject(project) {
        if (project.id === selectedProjectId) return;
        if (isDirty) {
            setPendingProject(project);
            setUnsavedDialogOpen(true);
            return;
        }
        applyProject(project);
    }

    async function saveProject() {
        if (!selectedProjectId || !projectName.trim()) return;
        const { apiKey, ...savedConfig } = form;
        const response = await fetch(`/api/projects/${selectedProjectId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: projectName.trim(), config: savedConfig }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Project could not be saved.");
        setProjects((current) => current.map((project) => project.id === data.project.id ? data.project : project));
        setSavedSnapshot(comparableConfig(data.project.config));
    }

    async function createProject(event) {
        event?.preventDefault();
        if (!newProjectName.trim()) return;
        const { apiKey, ...savedConfig } = emptyProjectConfig;
        const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newProjectName.trim(), config: savedConfig }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Project could not be created.");
        setProjects((current) => [data.project, ...current]);
        setForm(emptyProjectConfig);
        setDatasetPreview(null);
        setModels([]);
        setConnectionStatus("");
        setState({ status: "idle", total: 0, completed: 0, success: 0, failed: 0, current: "", logs: [], items: [] });
        setJobId(null);
        setSavedSnapshot(comparableConfig(emptyProjectConfig));
        applyProject(data.project);
        setNewProjectName("");
        setProjectDialogOpen(false);
    }

    async function cloneProject() {
        if (!selectedProjectId) return;
        const response = await fetch(`/api/projects/${selectedProjectId}/clone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `${projectName} copy` }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Project could not be cloned.");
        setProjects((current) => [data.project, ...current]);
        selectProject(data.project);
    }

    async function deleteProject() {
        if (!selectedProjectId || !window.confirm(`Delete ${projectName}?`)) return;
        const response = await fetch(`/api/projects/${selectedProjectId}`, { method: "DELETE" });
        if (!response.ok) throw new Error("Project could not be deleted.");
        const remaining = projects.filter((project) => project.id !== selectedProjectId);
        setProjects(remaining);
        if (remaining[0]) selectProject(remaining[0]);
        else { setSelectedProjectId(null); setProjectName(""); }
    }

    async function saveAndSwitchProject() {
        try {
            await saveProject();
            if (pendingProject) applyProject(pendingProject);
            setPendingProject(null);
            setUnsavedDialogOpen(false);
        } catch (caught) {
            setError(caught.message);
        }
    }

    function discardAndSwitchProject() {
        if (pendingProject) applyProject(pendingProject);
        setPendingProject(null);
        setUnsavedDialogOpen(false);
    }

    async function startJob(event, jobConfig = form, startMessage = "Submitting captioning job...") {
        event.preventDefault();
        setError("");
        setState({ status: "starting", total: 0, completed: 0, success: 0, failed: 0, current: "", logs: [startMessage], items: [] });
        try {
            const response = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(jobConfig) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Unable to start the job.");
            setJobId(data.jobId);
            setJobs((current) => [{ id: data.jobId, status: data.status, config: jobConfig }, ...current]);
            const stream = new EventSource(`/api/jobs/${data.jobId}/events`);
            stream.onmessage = ({ data: raw }) => {
                const event = JSON.parse(raw);
                setState((current) => {
                    let items = current.items;
                    if (event.type === "file" && event.filename) {
                        const existingIndex = items.findIndex((item) => item.filename === event.filename);
                        const item = {
                            filename: event.filename,
                            caption: event.caption ?? (existingIndex >= 0 ? items[existingIndex].caption : ""),
                            previousCaption: event.previous_caption ?? (existingIndex >= 0 ? items[existingIndex].previousCaption : ""),
                            result: event.result ?? (existingIndex >= 0 ? items[existingIndex].result : "processing"),
                        };
                        items = existingIndex >= 0 ? items.map((currentItem, index) => index === existingIndex ? item : currentItem) : [...items, item];
                    }
                    return { ...current, status: event.status || (event.type === "complete" ? "complete" : event.type === "error" ? "error" : current.status), total: event.total ?? event.summary?.total ?? current.total, completed: event.completed ?? event.summary?.completed ?? current.completed, success: event.success ?? event.summary?.success ?? current.success, failed: event.failed ?? event.summary?.failed ?? current.failed, current: event.filename || current.current, logs: [...current.logs, event.message].filter(Boolean).slice(-200), items };
                });
                if (["complete", "error", "cancelled"].includes(event.type)) stream.close();
            };
            stream.onerror = () => { setError("The live progress connection closed unexpectedly."); stream.close(); };
        } catch (requestError) {
            setError(requestError.message);
            setState((current) => ({ ...current, status: "error", logs: [...current.logs, requestError.message] }));
        }
    }

    async function cancelJob(job) {
        await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    }

    async function pauseJob(job) { await fetch(`/api/jobs/${job.id}/pause`, { method: "POST" }); }
    async function resumeJob(job) { await fetch(`/api/jobs/${job.id}/resume`, { method: "POST" }); }
    async function retryFailed(job) { await fetch(`/api/jobs/${job.id}/retry-failed`, { method: "POST" }); }
    async function retryFile(item) {
        if (!jobId) return;
        const response = await fetch(`/api/jobs/${jobId}/retry-file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: item.filename }) });
        if (!response.ok) { const data = await response.json(); throw new Error(data.error || "File retry failed."); }
    }

    async function retagImages(filenames, onlyMissing = false) {
        const onlyFiles = filenames.filter(Boolean);
        if (!onlyFiles.length) return;
        await startJob({ preventDefault() { } }, { ...form, onlyMissing, onlyFiles }, onlyMissing ? "Selected images queued for tagging..." : "Selected images queued for retagging...");
    }
    async function openFolder() { await fetch("/api/open-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderPath: form.folderPath }) }); }
    function exportReport(job) { window.open(`/api/jobs/${job.id}/report`, "_blank"); }

    function changeProvider(apiType) {
        update("apiType", apiType);
        update("apiUrl", providerDefaults[apiType]);
        setModels([]);
        setConnectionStatus("");
    }

    async function loadModels() {
        setModelsLoading(true);
        setConnectionStatus("");
        try {
            const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiType: form.apiType, apiUrl: form.apiUrl, apiKey: form.apiKey }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Models could not be loaded.");
            setModels(data.models || []);
            if (!form.modelName && data.models?.[0]) update("modelName", data.models[0]);
            setConnectionStatus(`${data.models?.length || 0} model(s) loaded.`);
        } catch (caught) {
            setConnectionStatus(caught.message);
        } finally {
            setModelsLoading(false);
        }
    }

    async function testConnection() {
        setModelsLoading(true);
        setConnectionStatus("Testing connection...");
        try {
            const response = await fetch("/api/test-connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiType: form.apiType, apiUrl: form.apiUrl, apiKey: form.apiKey }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Connection test failed.");
            setConnectionStatus(data.message);
        } catch (caught) {
            setConnectionStatus(caught.message);
        } finally {
            setModelsLoading(false);
        }
    }

    async function generatePrompt(kind, action = "generate") {
        const brief = action === "generate" ? generatorBrief[kind].trim() : form[kind === "master" ? "masterPrompt" : "characterPrompt"].trim();
        if (!brief) return;
        setGeneratorLoading((current) => ({ ...current, [kind]: true }));
        setError("");
        try {
            const response = await fetch("/api/prompts/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiType: form.apiType, apiUrl: form.apiUrl, apiKey: form.apiKey, modelName: form.modelName, kind, brief, action }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Prompt could not be generated.");
            setPromptPreview((current) => ({ ...current, [kind]: data.prompt }));
        } catch (caught) {
            setError(caught.message);
        } finally {
            setGeneratorLoading((current) => ({ ...current, [kind]: false }));
        }
    }

    function applyPrompt(kind, prompt) {
        update(kind === "master" ? "masterPrompt" : "characterPrompt", prompt);
        setPromptHistory((current) => [...current, { kind, text: prompt, createdAt: new Date().toISOString() }]);
        setPromptPreview((current) => ({ ...current, [kind]: "" }));
        setGeneratorOpen((current) => ({ ...current, [kind]: false }));
    }

    function applyPreset(kind, preset) {
        if (!preset) return;
        applyPrompt(kind, promptPresets[kind][preset]);
    }

    async function browseFolder() {
        setBrowseLoading(true);
        setError("");
        try {
            const response = await fetch("/api/browse-folder", { method: "POST" });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Folder could not be selected.");
            update("folderPath", data.path);
            await loadDatasetPreview(data.path);
        } catch (caught) {
            setError(caught.message);
        } finally {
            setBrowseLoading(false);
        }
    }

    async function loadDatasetPreview(folderPath) {
        const path = String(folderPath || "").trim();
        if (!path) {
            setDatasetPreview(null);
            return;
        }
        try {
            const response = await fetch("/api/dataset-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderPath: path }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Dataset preview could not be loaded.");
            setDatasetPreview(data);
        } catch (caught) {
            setDatasetPreview(null);
            setError(caught.message);
        }
    }

    const workflowJobs = jobs.slice(0, 6);

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function updateItemCaption(filename, caption) {
        setState((current) => ({ ...current, items: current.items.map((item) => item.filename === filename ? { ...item, caption } : item) }));
    }

    async function saveCaption(item) {
        const response = await fetch("/api/captions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderPath: form.folderPath, filename: item.filename, caption: item.caption }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Caption could not be saved.");
        setState((current) => ({ ...current, items: current.items.map((currentItem) => currentItem.filename === item.filename ? { ...currentItem, result: "success" } : currentItem) }));
        loadDatasetPreview(form.folderPath);
    }

    async function loadCaptionHistory(item) {
        const response = await fetch("/api/captions/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderPath: form.folderPath, filename: item.filename }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Caption history could not be loaded.");
        setHistoryDialog({ filename: item.filename, history: data.history || [] });
    }

    const datasetImages = datasetPreview?.images || [];
    const filteredDatasetImages = datasetImages.filter((image) => previewFilter === "missing" ? !image.captionExists : true);
    const filteredItems = state.items.filter((item) => previewFilter === "failed" ? item.result === "error" : previewFilter === "missing" ? !item.caption : true);

    return <main className="app-shell">
        <aside className="sidebar">
            <div className="sidebar-brand"><div className="brand-mark"><Activity size={20} /></div><div><p className="eyebrow">LOCAL PIPELINE</p><strong>LoraTagSmith</strong></div></div>
            <div className="sidebar-title"><span>PROJECTS</span><button className="icon-button" type="button" title="Create project" onClick={() => setProjectDialogOpen(true)}><Plus size={16} /></button></div>
            <button className="new-project-button" type="button" onClick={() => setProjectDialogOpen(true)}><Plus size={15} />New project</button>
            <div className="project-list">{projects.length ? projects.map((project) => <button className={`project-item ${project.id === selectedProjectId ? "selected" : ""}`} type="button" key={project.id} onClick={() => selectProject(project)}><span className="project-dot" /><span>{project.name}</span></button>) : <p className="sidebar-empty">Create a project to save caption settings.</p>}</div>
            <div className="sidebar-footer"><span className="status-dot" /> LAN READY</div>
        </aside>
        <section className={`workspace ${selectedProjectId ? "" : "workspace-empty"}`}>
            <header className="workspace-header"><div><p className="eyebrow">PROJECT WORKSPACE</p><h1>{projectName || "Untitled project"}</h1><p className="subtitle">Layered prompts for consistent, training-ready image captions.</p></div><div className="workflow-panel"><div className="workflow-heading"><span><Terminal size={15} /> WORKFLOWS</span><b>{jobs.filter((job) => ["queued", "starting", "running", "paused"].includes(job.status)).length}</b></div><div className="workflow-list">{workflowJobs.length ? workflowJobs.map((job) => <div className="workflow-item" key={job.id}><span className={`workflow-state ${job.status}`} /><span className="workflow-name"><b>{job.status === "complete" ? "Completed" : job.status === "error" ? "Failed" : job.status === "cancelled" ? "Cancelled" : job.status === "paused" ? "Paused" : job.status === "queued" ? "Queued" : "Processing"}</b><small>{job.id.slice(0, 8)} {job.progress?.total ? `· ${job.progress.completed}/${job.progress.total}` : ""}</small></span>{job.status === "running" && <button className="icon-button" type="button" title="Pause workflow" onClick={() => pauseJob(job)}><Pause size={14} /></button>}{job.status === "paused" && <button className="icon-button" type="button" title="Resume workflow" onClick={() => resumeJob(job)}><Play size={14} /></button>}{["queued", "starting", "running", "paused"].includes(job.status) && <button className="icon-button danger" type="button" title="Cancel workflow" onClick={() => cancelJob(job)}><XCircle size={15} /></button>}{job.status === "error" && <button className="icon-button" type="button" title="Retry failed files" onClick={() => retryFailed(job)}><RotateCcw size={14} /></button>}{["complete", "error", "cancelled"].includes(job.status) && <button className="icon-button" type="button" title="Export report" onClick={() => exportReport(job)}><Download size={14} /></button>}</div>) : <span className="workflow-empty">No workflows yet</span>}</div></div></header>
            {!selectedProjectId && <div className="empty-project-state"><div className="empty-project-copy"><p className="eyebrow">A CLEAN START</p><h2>Create your first project</h2><p>Give your dataset settings a name and keep prompts, provider preferences, and workflow history together.</p><button className="empty-project-button" type="button" onClick={() => setProjectDialogOpen(true)}><Plus size={16} />Create your first project</button></div></div>}
            <div className="project-actions"><button className="secondary-button" type="button" onClick={() => saveProject().catch((caught) => setError(caught.message))}><Save size={15} />Save settings</button><button className="secondary-button" type="button" disabled={!selectedProjectId} onClick={() => cloneProject().catch((caught) => setError(caught.message))}><Copy size={15} />Clone</button><button className="secondary-button" type="button" disabled={!form.folderPath} onClick={() => openFolder().catch((caught) => setError(caught.message))}><FolderOpen size={15} />Open output folder</button>{state.failed > 0 && jobId && <button className="secondary-button" type="button" onClick={() => retryFailed(jobs.find((job) => job.id === jobId))}><RotateCcw size={15} />Retry failed</button>}<button className="icon-button danger" type="button" disabled={!selectedProjectId} title="Delete project" onClick={() => deleteProject().catch((caught) => setError(caught.message))}><Trash2 size={16} /></button></div>
            <form onSubmit={startJob}>
                <section className="panel connection-panel"><div className="panel-heading"><Server size={18} /><div><h2>AI Connection</h2><p>Choose a provider, load available models, and test the connection.</p></div></div><div className="field-grid connection-grid"><label>Provider<select value={form.apiType} onChange={(e) => changeProvider(e.target.value)}><option value="llama.cpp">llama.cpp server</option><option value="ollama">Ollama</option><option value="openai">OpenAI</option><option value="gemini">Google Gemini</option><option value="anthropic">Anthropic Claude</option><option value="deepseek">DeepSeek</option></select></label><label>API URL<input value={form.apiUrl} onChange={(e) => update("apiUrl", e.target.value)} placeholder="https://api.openai.com/v1" /></label><label>API key<div className="secret-input-row"><input type={showApiKey ? "text" : "password"} value={form.apiKey} onChange={(e) => update("apiKey", e.target.value)} placeholder="Required for cloud providers" autoComplete="off" /><button className="secret-toggle" type="button" title={showApiKey ? "Hide API key" : "Show API key"} onClick={() => setShowApiKey((current) => !current)}>{showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label><label>Vision model<select value={form.modelName} onChange={(e) => update("modelName", e.target.value)}>{models.length ? [...new Set([form.modelName, ...models])].filter(Boolean).map((model) => <option value={model} key={model}>{model}</option>) : <option value={form.modelName}>{form.modelName || "Load models first"}</option>}</select></label></div><div className="connection-actions"><button className="secondary-button" type="button" disabled={modelsLoading} onClick={loadModels}>{modelsLoading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Load models</button><button className="secondary-button" type="button" disabled={modelsLoading} onClick={testConnection}>Test connection</button>{connectionStatus && <span className="connection-status">{connectionStatus}</span>}</div><p className="security-note">API keys stay in memory and are never saved with project settings.</p></section>
                <section className="panel"><div className="panel-heading"><FolderOpen size={18} /><div><h2>Dataset</h2><p>Caption files are written beside their source images.</p></div></div><div className="field-grid two"><label>Absolute folder path<div className="path-input-row"><input value={form.folderPath} onChange={(e) => { update("folderPath", e.target.value); setDatasetPreview(null); }} onBlur={() => loadDatasetPreview(form.folderPath)} placeholder="/home/you/datasets/character" /><button className="browse-button" type="button" disabled={browseLoading} onClick={browseFolder}>{browseLoading ? "Opening..." : "Browse"}</button></div></label><label>Trigger word<input value={form.triggerWord} onChange={(e) => update("triggerWord", e.target.value)} placeholder="character_name" /></label></div><div className="dataset-options"><label className="checkbox-label"><input type="checkbox" checked={form.onlyMissing} onChange={(e) => update("onlyMissing", e.target.checked)} />Only process images without captions</label><label className="compact-select">Caption format<select value={form.captionFormat} onChange={(e) => update("captionFormat", e.target.value)}><option value="comma">Comma-separated tags</option><option value="natural">Natural language paragraph</option><option value="danbooru">Danbooru-style tags</option></select></label></div>{datasetPreview && <div className="dataset-preview"><div className="dataset-preview-heading"><span>DATASET PREVIEW</span><b>{datasetPreview.total} images</b><b className="dataset-stat-good">{datasetPreview.captioned} captioned</b><b className="dataset-stat-missing">{datasetPreview.missing} missing</b><small>scroll horizontally</small></div>{filteredDatasetImages.length ? <div className="dataset-strip">{filteredDatasetImages.map((image) => <button className="dataset-thumb" type="button" key={image.filename} onClick={() => setLightbox({ src: `/api/dataset-preview/${datasetPreview.previewId}/images/${encodeURIComponent(image.filename)}`, title: image.filename })}><img src={`/api/dataset-preview/${datasetPreview.previewId}/images/${encodeURIComponent(image.filename)}`} alt={image.filename} title={`${image.filename} - ${formatBytes(image.size)}`} loading="lazy" /><span>{image.filename}<small>{formatBytes(image.size)}</small></span></button>)}</div> : <div className="dataset-empty">No images match this filter.</div>}</div>}</section>
                <div className="dataset-action-bar"><span>{selectedDatasetImages.length ? `${selectedDatasetImages.length} image(s) selected` : "Click thumbnails to select images"}</span><button className="secondary-button" type="button" disabled={!selectedDatasetImages.length} onClick={() => retagImages(selectedDatasetImages, true).catch((caught) => setError(caught.message))}>Tag selected</button><button className="secondary-button" type="button" disabled={!selectedDatasetImages.length} onClick={() => retagImages(selectedDatasetImages, false).catch((caught) => setError(caught.message))}>Retag selected</button><button className="secondary-button" type="button" disabled={!datasetImages.length} onClick={() => retagImages(datasetImages.map((image) => image.filename), false).catch((caught) => setError(caught.message))}>Retag all</button></div>
                <section className="prompt-layout">
                    <div className="panel prompt-panel">
                        <div className="panel-heading"><span className="section-index">01</span><div className="prompt-heading-content"><div><h2>Master prompt</h2><p>Global style, composition, and background rules.</p></div><button className="ai-button" type="button" onClick={() => setGeneratorOpen((current) => ({ ...current, master: !current.master }))}><Sparkles size={14} />Generate prompt with AI</button></div></div>
                        <div className="prompt-tools"><select defaultValue="" onChange={(event) => applyPreset("master", event.target.value)}><option value="">Prompt preset</option>{Object.keys(promptPresets.master).map((preset) => <option value={preset} key={preset}>{preset}</option>)}</select><select defaultValue="" onChange={(event) => { const history = promptHistory.find((entry) => entry.kind === "master" && entry.text === event.target.value); if (history) update("masterPrompt", history.text); }}><option value="">Prompt history</option>{promptHistory.filter((entry) => entry.kind === "master").slice(-8).reverse().map((entry, index) => <option value={entry.text} key={`${entry.createdAt}-${index}`}>{new Date(entry.createdAt).toLocaleTimeString()}</option>)}</select><button className="prompt-action" type="button" onClick={() => generatePrompt("master", "improve")} disabled={generatorLoading.master}>Improve</button><button className="prompt-action" type="button" onClick={() => generatePrompt("master", "shorten")} disabled={generatorLoading.master}>Shorten</button><span className="char-counter">{form.masterPrompt.length} chars</span></div>
                        <textarea value={form.masterPrompt} onChange={(event) => update("masterPrompt", event.target.value)} rows="10" placeholder="Describe the global visual style, layout, environment, lighting, and caption format..." />
                        {generatorOpen.master && <div className="generator-drawer"><label>Describe it briefly<textarea value={generatorBrief.master} onChange={(event) => setGeneratorBrief((current) => ({ ...current, master: event.target.value }))} rows="3" placeholder="Cinematic portrait, dark forest, soft rim light..." /></label><button className="generate-button" type="button" disabled={generatorLoading.master || !generatorBrief.master.trim()} onClick={() => generatePrompt("master")}>{generatorLoading.master ? "Generating..." : "Generate master prompt"}</button></div>}
                        {promptPreview.master && <div className="prompt-preview"><span>AI preview</span><p>{promptPreview.master}</p><button className="generate-button" type="button" onClick={() => applyPrompt("master", promptPreview.master)}>Apply prompt</button></div>}
                    </div>
                    <div className="panel prompt-panel accent-panel">
                        <div className="panel-heading"><span className="section-index">02</span><div className="prompt-heading-content"><div><h2>Character rules</h2><p>Permanent traits and fixed anatomy locking.</p></div><button className="ai-button" type="button" onClick={() => setGeneratorOpen((current) => ({ ...current, character: !current.character }))}><Sparkles size={14} />Generate prompt with AI</button></div></div>
                        <div className="prompt-tools"><select defaultValue="" onChange={(event) => applyPreset("character", event.target.value)}><option value="">Prompt preset</option>{Object.keys(promptPresets.character).map((preset) => <option value={preset} key={preset}>{preset}</option>)}</select><select defaultValue="" onChange={(event) => { const history = promptHistory.find((entry) => entry.kind === "character" && entry.text === event.target.value); if (history) update("characterPrompt", history.text); }}><option value="">Prompt history</option>{promptHistory.filter((entry) => entry.kind === "character").slice(-8).reverse().map((entry, index) => <option value={entry.text} key={`${entry.createdAt}-${index}`}>{new Date(entry.createdAt).toLocaleTimeString()}</option>)}</select><button className="prompt-action" type="button" onClick={() => generatePrompt("character", "improve")} disabled={generatorLoading.character}>Improve</button><button className="prompt-action" type="button" onClick={() => generatePrompt("character", "shorten")} disabled={generatorLoading.character}>Shorten</button><span className="char-counter">{form.characterPrompt.length} chars</span></div>
                        <textarea value={form.characterPrompt} onChange={(event) => update("characterPrompt", event.target.value)} rows="10" placeholder="Describe fixed anatomy, genetic traits, identity features, and removable accessories..." />
                        {generatorOpen.character && <div className="generator-drawer"><label>Describe it briefly<textarea value={generatorBrief.character} onChange={(event) => setGeneratorBrief((current) => ({ ...current, character: event.target.value }))} rows="3" placeholder="Long silver hair, horns, fixed eye color, removable armor..." /></label><button className="generate-button" type="button" disabled={generatorLoading.character || !generatorBrief.character.trim()} onClick={() => generatePrompt("character")}>{generatorLoading.character ? "Generating..." : "Generate character rules"}</button></div>}
                        {promptPreview.character && <div className="prompt-preview"><span>AI preview</span><p>{promptPreview.character}</p><button className="generate-button" type="button" onClick={() => applyPrompt("character", promptPreview.character)}>Apply prompt</button></div>}
                    </div>
                </section>
                <section className="run-strip"><div><p className="eyebrow">BATCH CONTROL</p><h2>{running ? `Processing ${state.current || "dataset"}` : state.status === "complete" ? "Batch complete" : "Ready to caption"}</h2><div className="progress-track"><span style={{ width: `${percent}%` }} /></div><p className="progress-label">{percent}% <span>{state.total ? `${state.completed} of ${state.total} images` : "No batch started"}</span></p></div><button className="start-button" disabled={running} type="submit">{running ? <LoaderCircle className="spin" size={19} /> : <Play size={19} />}{running ? "RUNNING" : "START BATCH"}</button></section>
            </form>
            <section className="dashboard-grid"><div className="panel stats-panel"><div className="panel-heading"><Image size={18} /><div><h2>Batch stats</h2><p>Current worker summary.</p></div></div><div className="stats"><div><strong>{state.total}</strong><span>Total</span></div><div className="good"><strong>{state.success}</strong><span>Saved</span></div><div className="bad"><strong>{state.failed}</strong><span>Failed</span></div></div>{error && <div className="error-message"><XCircle size={16} />{error}</div>}</div><div className="panel log-panel"><div className="panel-heading"><Terminal size={18} /><div><h2>Live activity</h2><p>{jobId ? `Job ${jobId.slice(0, 8)}` : "Waiting for a batch"}</p></div></div><div className="log-window">{state.logs.length ? state.logs.map((log, index) => <div className="log-line" key={`${index}-${log}`}><span>›</span>{log}</div>) : <div className="empty-log"><CheckCircle2 size={18} />Logs will appear here when the worker starts.</div>}</div></div></section>
            <section className="panel preview-panel"><div className="panel-heading"><Image size={18} /><div><h2>Image previews & tags</h2><p>Generated captions can be reviewed and edited before saving.</p></div><select className="preview-filter" value={previewFilter} onChange={(event) => setPreviewFilter(event.target.value)}><option value="all">All images</option><option value="missing">Missing captions</option><option value="failed">Failed images</option></select></div>{state.items.length ? filteredItems.length ? <div className="preview-grid">{filteredItems.map((item) => <article className="preview-card" key={item.filename}><img className="preview-image-clickable" src={`/api/jobs/${jobId}/images/${encodeURIComponent(item.filename)}`} alt={item.filename} onClick={() => setLightbox({ src: `/api/jobs/${jobId}/images/${encodeURIComponent(item.filename)}`, title: item.filename })} /><div className="preview-body"><p className="preview-filename">{item.filename}</p><textarea className="caption-editor" value={item.caption || ""} onChange={(event) => updateItemCaption(item.filename, event.target.value)} placeholder={item.result === "error" ? "Caption failed. Edit or retry this image." : "Waiting for caption..."} /><div className="caption-actions"><span className={item.result === "error" ? "caption-status is-error" : "caption-status"}>{item.result === "error" ? "Failed" : "Editable"}</span><button className="save-caption-button" type="button" onClick={() => loadCaptionHistory(item).catch((caught) => setError(caught.message))}>History</button>{item.result === "error" && <button className="save-caption-button retry-caption-button" type="button" onClick={() => retryFile(item).catch((caught) => setError(caught.message))}>Retry</button>}<button className="save-caption-button" type="button" disabled={!item.caption?.trim()} onClick={() => saveCaption(item).catch((caught) => setError(caught.message))}>Save caption</button></div></div></article>)}</div> : <div className="preview-empty"><Image size={20} />No images match this filter.</div> : <div className="preview-empty"><Image size={20} />Processed images and their tags will appear here.</div>}</section>
            {lightbox && <div className="lightbox" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}><div className="lightbox-content" onClick={(event) => event.stopPropagation()}><button className="lightbox-close" type="button" onClick={() => setLightbox(null)}><XCircle size={20} /></button><img src={lightbox.src} alt={lightbox.title} /><p>{lightbox.title}</p></div></div>}
            {projectDialogOpen && <div className="project-dialog-backdrop" role="presentation" onClick={() => setProjectDialogOpen(false)}><form className="project-dialog" onSubmit={(event) => createProject(event).catch((caught) => setError(caught.message))} onClick={(event) => event.stopPropagation()}><p className="eyebrow">NEW PROJECT</p><h2>Create a project</h2><p className="project-dialog-copy">Name this workspace to keep its dataset, prompts, and provider settings together.</p><label>Project name<input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="e.g. Character LoRA v1" /></label><div className="project-dialog-actions"><button className="secondary-button" type="button" onClick={() => setProjectDialogOpen(false)}>Cancel</button><button className="empty-project-button" type="submit" disabled={!newProjectName.trim()}><Plus size={15} />Create project</button></div></form></div>}
            {unsavedDialogOpen && <div className="project-dialog-backdrop" role="presentation"><div className="project-dialog unsaved-dialog"><p className="eyebrow">UNSAVED CHANGES</p><h2>Save changes to {projectName}?</h2><p className="project-dialog-copy">You have edits that are not saved. Choose what to do before opening {pendingProject?.name || "the next project"}.</p><div className="project-dialog-actions"><button className="secondary-button" type="button" onClick={() => { setPendingProject(null); setUnsavedDialogOpen(false); }}>Cancel</button><button className="secondary-button danger-action" type="button" onClick={discardAndSwitchProject}>Don't save</button><button className="empty-project-button" type="button" onClick={saveAndSwitchProject}>Save</button></div></div></div>}
            {historyDialog && <div className="project-dialog-backdrop" role="presentation" onClick={() => setHistoryDialog(null)}><div className="project-dialog history-dialog" onClick={(event) => event.stopPropagation()}><p className="eyebrow">CAPTION HISTORY</p><h2>{historyDialog.filename}</h2><div className="history-list">{historyDialog.history.length ? historyDialog.history.slice().reverse().map((entry, index) => <div className="history-entry" key={`${entry.timestamp}-${index}`}><small>{new Date(entry.timestamp).toLocaleString()} · {entry.source}</small><p>{entry.next}</p>{entry.previous && <em>Previous: {entry.previous}</em>}</div>) : <p className="project-dialog-copy">No previous caption versions yet.</p>}</div><div className="project-dialog-actions"><button className="secondary-button" type="button" onClick={() => setHistoryDialog(null)}>Close</button></div></div></div>}
        </section>
    </main>;
}

export default App;
