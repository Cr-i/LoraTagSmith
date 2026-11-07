import { randomUUID } from "node:crypto";

const MAX_EVENTS = 300;
const MAX_JOBS = 10;

export class JobManager {
    constructor() {
        this.jobs = new Map();
    }

    create(config) {
        const { apiKey: _apiKey, folderPath: _folderPath, ...publicConfig } = config;
        const job = {
            id: randomUUID(),
            status: "queued",
            createdAt: new Date().toISOString(),
            config: { ...config },
            publicConfig,
            events: [],
            clients: new Set(),
            process: null,
            summary: null,
            progress: { total: 0, completed: 0, success: 0, failed: 0 },
            failedFiles: [],
        };
        this.jobs.set(job.id, job);
        this.trimJobs();
        return job;
    }

    activeJob() {
        return [...this.jobs.values()].find((job) => ["starting", "running", "paused"].includes(job.status));
    }

    queuedJob() {
        return [...this.jobs.values()].find((job) => job.status === "queued");
    }

    list() {
        return [...this.jobs.values()]
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map((job) => ({
                id: job.id,
                status: job.status,
                createdAt: job.createdAt,
                summary: job.summary,
                progress: job.progress,
                failedFiles: job.failedFiles,
                config: job.publicConfig,
            }));
    }

    get(id) {
        return this.jobs.get(id);
    }

    addClient(id, response) {
        const job = this.get(id);
        if (!job) return false;
        job.clients.add(response);
        return true;
    }

    removeClient(id, response) {
        this.get(id)?.clients.delete(response);
    }

    publish(id, event) {
        const job = this.get(id);
        if (!job) return;
        job.events.push(event);
        if (job.events.length > MAX_EVENTS) job.events.shift();
        if (event.type === "status") job.status = event.status;
        if (event.type === "status" || event.type === "file") {
            job.progress = {
                total: event.total ?? job.progress.total,
                completed: event.completed ?? job.progress.completed,
                success: event.success ?? job.progress.success,
                failed: event.failed ?? job.progress.failed,
            };
        }
        if (event.type === "file" && event.result === "error" && event.filename && !job.failedFiles.includes(event.filename)) job.failedFiles.push(event.filename);
        if (["complete", "error", "cancelled"].includes(event.type)) {
            job.status = event.type;
            job.summary = event.summary ?? null;
        }
        const payload = `data: ${JSON.stringify(event)}\n\n`;
        for (const client of job.clients) client.write(payload);
    }

    finish(id, status, summary) {
        const job = this.get(id);
        if (!job || ["complete", "error", "cancelled"].includes(job.status)) return;
        this.publish(id, { type: status === "complete" ? "complete" : "error", summary });
    }

    cancel(id) {
        const job = this.get(id);
        if (!job || ["complete", "error", "cancelled"].includes(job.status)) return false;
        this.publish(id, { type: "cancelled", summary: { message: "Job cancelled by user." }, message: "Job cancelled by user." });
        if (job.process && !job.process.killed) job.process.kill("SIGTERM");
        return true;
    }

    pause(id) {
        const job = this.get(id);
        if (!job || job.status !== "running" || !job.process) return false;
        job.process.kill("SIGSTOP");
        this.publish(id, { type: "status", status: "paused", message: "Job paused." });
        return true;
    }

    resume(id) {
        const job = this.get(id);
        if (!job || job.status !== "paused" || !job.process) return false;
        job.process.kill("SIGCONT");
        this.publish(id, { type: "status", status: "running", message: "Job resumed." });
        return true;
    }

    trimJobs() {
        while (this.jobs.size > MAX_JOBS) {
            const oldest = [...this.jobs.values()].find((job) => !job.clients.size && !["queued", "starting", "running", "paused"].includes(job.status));
            if (!oldest) return;
            this.jobs.delete(oldest.id);
        }
    }
}
