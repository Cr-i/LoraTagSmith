import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const dataPath = resolve(process.env.PROJECTS_FILE || join(process.cwd(), "server", "data", "projects.json"));

function sanitizeConfig(config) {
    if (!config || typeof config !== "object") return {};
    const { apiKey: _apiKey, ...safeConfig } = config;
    return safeConfig;
}

function ensureDataFile() {
    if (!existsSync(dirname(dataPath))) mkdirSync(dirname(dataPath), { recursive: true });
    if (!existsSync(dataPath)) writeFileSync(dataPath, "[]\n", "utf8");
}

function readProjects() {
    ensureDataFile();
    try {
        const projects = JSON.parse(readFileSync(dataPath, "utf8"));
        if (!Array.isArray(projects)) return [];
        const sanitizedProjects = projects.map((project) => ({ ...project, config: sanitizeConfig(project.config) }));
        if (JSON.stringify(projects) !== JSON.stringify(sanitizedProjects)) writeProjects(sanitizedProjects);
        return sanitizedProjects;
    } catch {
        return [];
    }
}

function writeProjects(projects) {
    ensureDataFile();
    writeFileSync(dataPath, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
}

export class ProjectStore {
    list() {
        return readProjects().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    get(id) {
        return readProjects().find((project) => project.id === id) ?? null;
    }

    create(name, config = {}) {
        const now = new Date().toISOString();
        const project = { id: randomUUID(), name, config: sanitizeConfig(config), createdAt: now, updatedAt: now };
        const projects = readProjects();
        projects.push(project);
        writeProjects(projects);
        return project;
    }

    update(id, name, config) {
        const projects = readProjects();
        const index = projects.findIndex((project) => project.id === id);
        if (index < 0) return null;
        projects[index] = { ...projects[index], name, config: sanitizeConfig(config), updatedAt: new Date().toISOString() };
        writeProjects(projects);
        return projects[index];
    }

    clone(id, name) {
        const source = this.get(id);
        if (!source) return null;
        return this.create(name, source.config);
    }

    remove(id) {
        const projects = readProjects();
        const remaining = projects.filter((project) => project.id !== id);
        if (remaining.length === projects.length) return false;
        writeProjects(remaining);
        return true;
    }
}
