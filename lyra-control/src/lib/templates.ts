/**
 * Handlebars template rendering for project scaffolding.
 * Reads .hbs files from src/templates/ and compiles with project data.
 */

import Handlebars from "handlebars";
import { readFileSync } from "fs";
import { join } from "path";

const TEMPLATE_DIR = join(process.cwd(), "src", "templates");

function loadTemplate(name: string): HandlebarsTemplateDelegate {
  const raw = readFileSync(join(TEMPLATE_DIR, name), "utf-8");
  return Handlebars.compile(raw);
}

export interface TemplateInput {
  projectName: string;
  jiraKey: string;
  githubRepo: string;
  techStack: string;
  description: string;
  archProfile?: string;
  environments?: string | null;
  codebaseAnalysis?: string | null;
}

export interface ProjectTemplateData {
  projectName: string;
  jiraKey: string;
  githubRepo: string;
  techStack: string;
  description: string;
  commitPrefix: string;
  nodeVersion: string;
  commands: { name: string; command: string }[];
  curlyOpen: string;
  curlyClose: string;
  isComplex: boolean;
  environments?: { name: string; port: number; branch: string }[];
  codebaseAnalysis?: {
    framework: string;
    language: string;
    packageManager: string;
    scripts: Record<string, string>;
    keyDependencies: string[];
    devDependencies: string[];
    testFramework: string | null;
    testPattern: string | null;
    directoryOverview: string;
    entryPoints: string[];
  } | null;
}

function buildData(input: TemplateInput): ProjectTemplateData {
  const isComplex = input.archProfile === "complex";
  let environments: { name: string; port: number; branch: string }[] | undefined;
  if (isComplex && input.environments) {
    try {
      environments = JSON.parse(input.environments);
    } catch {
      environments = [
        { name: "dev", port: 3000, branch: "develop" },
        { name: "qa", port: 3001, branch: "develop" },
        { name: "prod", port: 3002, branch: "main" },
      ];
    }
  }

  // Parse codebase analysis if available
  let codebaseAnalysis: ProjectTemplateData["codebaseAnalysis"] = null;
  if (input.codebaseAnalysis) {
    try {
      codebaseAnalysis = JSON.parse(input.codebaseAnalysis);
    } catch {
      // Invalid JSON — skip
    }
  }

  return {
    projectName: input.projectName,
    jiraKey: input.jiraKey,
    githubRepo: input.githubRepo,
    techStack: input.techStack,
    description: input.description,
    commitPrefix: "feat",
    nodeVersion: "20",
    commands: [
      { name: "Dev", command: "npm run dev" },
      { name: "Build", command: "npm run build" },
      { name: "Test", command: "npm test" },
      { name: "Lint", command: "npm run lint" },
    ],
    curlyOpen: "${{",
    curlyClose: "}}",
    isComplex,
    environments,
    codebaseAnalysis,
  };
}

export function renderClaudeMd(input: TemplateInput): string {
  const template = loadTemplate("claude-md.hbs");
  return template(buildData(input));
}

export function renderCiYml(input: TemplateInput): string {
  const template = loadTemplate("ci.yml.hbs");
  return template(buildData(input));
}

export function renderAutoMergeYml(input: TemplateInput): string {
  const template = loadTemplate("auto-merge.yml.hbs");
  return template(buildData(input));
}

export function renderRollbackYml(input: TemplateInput): string {
  const template = loadTemplate("rollback.yml.hbs");
  return template(buildData(input));
}

export function renderPrTemplate(input: TemplateInput): string {
  const template = loadTemplate("pr-template.hbs");
  return template(buildData(input));
}

/** Render all templates and return as a map of relative path -> content */
export function renderAllTemplates(input: TemplateInput): Record<string, string> {
  return {
    "CLAUDE.md": renderClaudeMd(input),
    ".github/workflows/ci.yml": renderCiYml(input),
    ".github/workflows/auto-merge.yml": renderAutoMergeYml(input),
    ".github/workflows/rollback.yml": renderRollbackYml(input),
    ".github/pull_request_template.md": renderPrTemplate(input),
  };
}
