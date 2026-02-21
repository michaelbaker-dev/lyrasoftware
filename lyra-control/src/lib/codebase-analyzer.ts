/**
 * Filesystem-based codebase analyzer.
 * Inspects a repo path to detect framework, dependencies, test setup, etc.
 * Used during onboarding to feed real project data into PRD/ARD generation.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename, extname, relative } from "path";

export type CodeStats = {
  totalFiles: number;
  totalLines: number;
  byExtension: Record<string, { files: number; lines: number }>;
};

export type SourceFileSummary = {
  path: string;
  lines: number;
  extension: string;
};

export interface CodebaseAnalysis {
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
  existingDocs: string | null;
  existingAiConfig: string | null;
  ciConfig: string | null;
  buildOutput: string | null;
  aiSummary: string | null;
  // Deep inspection fields
  sourceFiles: SourceFileSummary[];
  apiRoutes: string[];
  components: string[];
  dbModels: string[];
  stateManagement: string | null;
  authPattern: string | null;
  configSummary: Record<string, string>;
  envVars: string[];
  monorepoType: string | null;
  codeStats: CodeStats;
  sourceExcerpts: Record<string, string>;
  docFiles: Record<string, string>;
}

export type AnalysisMode = "full" | "launch";

export async function analyzeCodebase(repoPath: string, mode: AnalysisMode = "full"): Promise<CodebaseAnalysis> {
  const analysis: CodebaseAnalysis = {
    framework: "Unknown",
    language: "Unknown",
    packageManager: "npm",
    scripts: {},
    keyDependencies: [],
    devDependencies: [],
    testFramework: null,
    testPattern: null,
    directoryOverview: "",
    entryPoints: [],
    existingDocs: null,
    existingAiConfig: null,
    ciConfig: null,
    buildOutput: null,
    aiSummary: null,
    sourceFiles: [],
    apiRoutes: [],
    components: [],
    dbModels: [],
    stateManagement: null,
    authPattern: null,
    configSummary: {},
    envVars: [],
    monorepoType: null,
    codeStats: { totalFiles: 0, totalLines: 0, byExtension: {} },
    sourceExcerpts: {},
    docFiles: {},
  };

  // Detect package manager
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) {
    analysis.packageManager = "pnpm";
  } else if (existsSync(join(repoPath, "yarn.lock"))) {
    analysis.packageManager = "yarn";
  } else if (existsSync(join(repoPath, "bun.lockb"))) {
    analysis.packageManager = "bun";
  }

  // Read package.json
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

      // Scripts (root + immediate subdirectory package.json scripts)
      analysis.scripts = pkg.scripts || {};
      // Check for subdirectory package.json files (server/, client/, etc.)
      const subDirs = ["server", "client", "backend", "frontend", "api", "web", "app"];
      for (const sub of subDirs) {
        const subPkgPath = join(repoPath, sub, "package.json");
        if (existsSync(subPkgPath)) {
          try {
            const subPkg = JSON.parse(readFileSync(subPkgPath, "utf-8"));
            if (subPkg.scripts) {
              for (const [name, cmd] of Object.entries(subPkg.scripts)) {
                analysis.scripts[`${sub}:${name}`] = cmd as string;
              }
            }
          } catch { /* ignore */ }
        }
      }

      // Dependencies
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      analysis.keyDependencies = deps.slice(0, 20);
      analysis.devDependencies = devDeps.slice(0, 20);

      // Detect language
      if (devDeps.includes("typescript") || deps.includes("typescript") || existsSync(join(repoPath, "tsconfig.json"))) {
        analysis.language = "TypeScript";
      } else {
        analysis.language = "JavaScript";
      }

      // Detect framework
      analysis.framework = detectFramework(repoPath, deps, devDeps);
    } catch {
      // package.json parse failure
    }
  } else if (existsSync(join(repoPath, "Cargo.toml"))) {
    analysis.language = "Rust";
    analysis.framework = "Rust/Cargo";
    analysis.packageManager = "cargo";
  } else if (existsSync(join(repoPath, "go.mod"))) {
    analysis.language = "Go";
    analysis.framework = "Go";
    analysis.packageManager = "go";
  } else if (existsSync(join(repoPath, "requirements.txt")) || existsSync(join(repoPath, "pyproject.toml"))) {
    analysis.language = "Python";
    analysis.framework = detectPythonFramework(repoPath);
    analysis.packageManager = existsSync(join(repoPath, "pyproject.toml")) ? "poetry/pip" : "pip";
  }

  // Detect test framework
  const testInfo = detectTestFramework(repoPath, analysis.devDependencies, analysis.keyDependencies);
  analysis.testFramework = testInfo.framework;
  analysis.testPattern = testInfo.pattern;

  // Directory overview
  analysis.directoryOverview = buildDirectoryOverview(repoPath);

  // Entry points
  analysis.entryPoints = detectEntryPoints(repoPath);

  // README
  const readmePath = findFile(repoPath, ["README.md", "readme.md", "README.MD", "README"]);
  if (readmePath) {
    const content = readFileSync(readmePath, "utf-8");
    analysis.existingDocs = content.slice(0, 2000);
  }

  // Existing AI config
  const aiConfigPath = findFile(repoPath, ["CLAUDE.md", ".cursorrules", ".cursor/rules"]);
  if (aiConfigPath) {
    const content = readFileSync(aiConfigPath, "utf-8");
    analysis.existingAiConfig = content.slice(0, 2000);
  }

  // CI config
  const workflowDir = join(repoPath, ".github", "workflows");
  if (existsSync(workflowDir)) {
    try {
      const workflows = readdirSync(workflowDir).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));
      analysis.ciConfig = workflows.length > 0 ? workflows.join(", ") : null;
    } catch {
      // Permission error
    }
  }

  // Build output
  const buildDirs = [".next", "dist", "build", "out", ".output", "target"];
  const foundBuildDirs = buildDirs.filter(d => existsSync(join(repoPath, d)));
  analysis.buildOutput = foundBuildDirs.length > 0 ? foundBuildDirs.join(", ") : null;

  // ── Fields needed by both modes ──────────────────────────────────
  const allDeps = [...analysis.keyDependencies, ...analysis.devDependencies];
  analysis.configSummary = collectConfigSummary(repoPath);
  analysis.envVars = collectEnvVars(repoPath);
  analysis.monorepoType = detectMonorepo(repoPath);

  // ── Deep inspection (skip in launch mode for speed) ────────────
  if (mode === "full") {
    const { sourceFiles, codeStats } = collectSourceFiles(repoPath);
    analysis.sourceFiles = sourceFiles;
    analysis.codeStats = codeStats;

    analysis.apiRoutes = detectApiRoutes(repoPath, analysis.framework);
    analysis.components = detectComponents(repoPath, analysis.framework);
    analysis.dbModels = detectDbModels(repoPath);

    analysis.stateManagement = detectStateManagement(allDeps);
    analysis.authPattern = detectAuthPattern(repoPath, allDeps);
    analysis.sourceExcerpts = collectSourceExcerpts(repoPath, analysis.entryPoints);
    analysis.docFiles = collectDocFiles(repoPath);
  }

  return analysis;
}

function detectFramework(repoPath: string, deps: string[], devDeps: string[]): string {
  const allDeps = [...deps, ...devDeps];

  // Next.js
  if (allDeps.includes("next") || existsSync(join(repoPath, "next.config.js")) || existsSync(join(repoPath, "next.config.mjs")) || existsSync(join(repoPath, "next.config.ts"))) {
    return "Next.js";
  }
  // Nuxt
  if (allDeps.includes("nuxt") || existsSync(join(repoPath, "nuxt.config.ts"))) {
    return "Nuxt";
  }
  // SvelteKit
  if (allDeps.includes("@sveltejs/kit")) return "SvelteKit";
  // Remix
  if (allDeps.includes("@remix-run/node") || allDeps.includes("@remix-run/react")) return "Remix";
  // Astro
  if (allDeps.includes("astro")) return "Astro";
  // Vite + React
  if (allDeps.includes("vite") && allDeps.includes("react")) return "Vite + React";
  // Vite + Vue
  if (allDeps.includes("vite") && allDeps.includes("vue")) return "Vite + Vue";
  // Vite + Svelte
  if (allDeps.includes("vite") && allDeps.includes("svelte")) return "Vite + Svelte";
  // CRA
  if (allDeps.includes("react-scripts")) return "Create React App";
  // React (standalone)
  if (allDeps.includes("react")) return "React";
  // Vue (standalone)
  if (allDeps.includes("vue")) return "Vue";
  // Angular
  if (allDeps.includes("@angular/core")) return "Angular";
  // Express
  if (deps.includes("express")) return "Express";
  // Fastify
  if (deps.includes("fastify")) return "Fastify";
  // Hono
  if (deps.includes("hono")) return "Hono";
  // NestJS
  if (allDeps.includes("@nestjs/core")) return "NestJS";
  // Electron
  if (allDeps.includes("electron")) return "Electron";

  return "Node.js";
}

function detectPythonFramework(repoPath: string): string {
  const reqPath = join(repoPath, "requirements.txt");
  if (existsSync(reqPath)) {
    const content = readFileSync(reqPath, "utf-8").toLowerCase();
    if (content.includes("django")) return "Django";
    if (content.includes("flask")) return "Flask";
    if (content.includes("fastapi")) return "FastAPI";
  }
  const pyprojectPath = join(repoPath, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    const content = readFileSync(pyprojectPath, "utf-8").toLowerCase();
    if (content.includes("django")) return "Django";
    if (content.includes("flask")) return "Flask";
    if (content.includes("fastapi")) return "FastAPI";
  }
  return "Python";
}

function detectTestFramework(
  repoPath: string,
  devDeps: string[],
  deps: string[]
): { framework: string | null; pattern: string | null } {
  const allDeps = [...deps, ...devDeps];

  // Vitest
  if (allDeps.includes("vitest") || existsSync(join(repoPath, "vitest.config.ts")) || existsSync(join(repoPath, "vitest.config.js"))) {
    return { framework: "Vitest", pattern: "**/*.test.{ts,tsx}" };
  }
  // Jest
  if (allDeps.includes("jest") || existsSync(join(repoPath, "jest.config.js")) || existsSync(join(repoPath, "jest.config.ts"))) {
    return { framework: "Jest", pattern: "**/*.test.{ts,tsx,js,jsx}" };
  }
  // Mocha
  if (allDeps.includes("mocha")) {
    return { framework: "Mocha", pattern: "test/**/*.{ts,js}" };
  }
  // Playwright
  if (allDeps.includes("@playwright/test") || existsSync(join(repoPath, "playwright.config.ts"))) {
    return { framework: "Playwright", pattern: "**/*.spec.{ts,tsx}" };
  }
  // Cypress
  if (allDeps.includes("cypress")) {
    return { framework: "Cypress", pattern: "cypress/e2e/**/*.cy.{ts,js}" };
  }
  // pytest (Python)
  if (existsSync(join(repoPath, "pytest.ini")) || existsSync(join(repoPath, "conftest.py"))) {
    return { framework: "pytest", pattern: "test_*.py / *_test.py" };
  }

  return { framework: null, pattern: null };
}

function buildDirectoryOverview(repoPath: string, maxDepth: number = 3): string {
  const lines: string[] = [];
  const ignoreDirs = new Set([
    "node_modules", ".git", ".next", "dist", "build", ".output",
    "coverage", ".cache", ".turbo", "__pycache__", ".venv", "venv",
    "target", ".idea", ".vscode",
  ]);

  function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir).filter(e => !e.startsWith(".") || e === ".github");
      entries.sort();
    } catch {
      return;
    }

    // Filter out ignored dirs
    entries = entries.filter(e => !ignoreDirs.has(e));

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fullPath = join(dir, entry);
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const newPrefix = prefix + (isLast ? "    " : "│   ");

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          lines.push(`${prefix}${connector}${entry}/`);
          walk(fullPath, newPrefix, depth + 1);
        } else if (depth === 0) {
          // Only show files at root level
          lines.push(`${prefix}${connector}${entry}`);
        }
      } catch {
        // Permission error
      }
    }
  }

  walk(repoPath, "", 0);
  return lines.join("\n");
}

function detectEntryPoints(repoPath: string): string[] {
  const entryPoints: string[] = [];

  // Common entry point files
  const candidates = [
    "src/index.ts", "src/index.tsx", "src/index.js",
    "src/main.ts", "src/main.tsx", "src/main.js",
    "src/app.ts", "src/app.js",
    "src/server.ts", "src/server.js",
    "src/app/layout.tsx", "src/app/page.tsx",
    "src/pages/index.tsx", "src/pages/index.js",
    "app/layout.tsx", "app/page.tsx",
    "pages/index.tsx", "pages/index.js",
    "index.ts", "index.js",
    "main.ts", "main.js",
    "server.ts", "server.js",
    "app.ts", "app.js",
    "manage.py",
  ];

  for (const candidate of candidates) {
    if (existsSync(join(repoPath, candidate))) {
      entryPoints.push(candidate);
    }
  }

  // Check package.json main/module
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.main && !entryPoints.includes(pkg.main)) entryPoints.push(pkg.main);
      if (pkg.module && !entryPoints.includes(pkg.module)) entryPoints.push(pkg.module);
    } catch {
      // ignore
    }
  }

  return entryPoints;
}

function findFile(dir: string, names: string[]): string | null {
  for (const name of names) {
    const fullPath = join(dir, name);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

// ── Deep inspection functions ──────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".rb",
  ".vue", ".svelte", ".astro",
  ".css", ".scss", ".less",
  ".html", ".hbs", ".ejs",
  ".sql", ".graphql", ".gql",
  ".sh", ".bash",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".output",
  "coverage", ".cache", ".turbo", "__pycache__", ".venv", "venv",
  "target", ".idea", ".vscode", ".nuxt", ".svelte-kit",
  "out", ".parcel-cache", ".expo",
]);

const MAX_SOURCE_FILES = 500;
const MAX_SOURCE_EXCERPTS = 10;
const MAX_EXCERPT_LINES = 200;

function countLines(filePath: string): number {
  try {
    // Estimate lines from file size (~40 bytes per line average) to avoid
    // reading entire file contents. Much faster for large files.
    const stat = statSync(filePath);
    return Math.max(1, Math.round(stat.size / 40));
  } catch {
    return 0;
  }
}

function collectSourceFiles(repoPath: string): { sourceFiles: SourceFileSummary[]; codeStats: CodeStats } {
  const sourceFiles: SourceFileSummary[] = [];
  const byExtension: Record<string, { files: number; lines: number }> = {};
  let totalLines = 0;

  function walk(dir: string) {
    if (sourceFiles.length >= MAX_SOURCE_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (sourceFiles.length >= MAX_SOURCE_FILES) break;
      if (entry.startsWith(".") && entry !== ".github") continue;
      if (IGNORE_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          const ext = extname(entry).toLowerCase();
          if (SOURCE_EXTENSIONS.has(ext)) {
            const lines = countLines(fullPath);
            const relPath = relative(repoPath, fullPath);
            sourceFiles.push({ path: relPath, lines, extension: ext });
            totalLines += lines;
            if (!byExtension[ext]) byExtension[ext] = { files: 0, lines: 0 };
            byExtension[ext].files++;
            byExtension[ext].lines += lines;
          }
        }
      } catch {
        // Permission error
      }
    }
  }

  walk(repoPath);

  return {
    sourceFiles,
    codeStats: {
      totalFiles: sourceFiles.length,
      totalLines,
      byExtension,
    },
  };
}

function detectApiRoutes(repoPath: string, framework: string): string[] {
  const routes: string[] = [];

  if (framework === "Next.js") {
    // App Router: src/app/**/route.ts
    walkForFiles(repoPath, (relPath) => {
      if (/\/route\.(ts|js)$/.test(relPath)) {
        const routePath = relPath
          .replace(/^src\/app/, "")
          .replace(/\/route\.(ts|js)$/, "") || "/";
        routes.push(routePath);
      }
      // Pages Router: src/pages/api/**
      if (/pages\/api\//.test(relPath) && /\.(ts|js)$/.test(relPath)) {
        const routePath = relPath
          .replace(/^src\/pages/, "")
          .replace(/\.(ts|js)$/, "")
          .replace(/\/index$/, "") || "/api";
        if (!routes.includes(routePath)) routes.push(routePath);
      }
    });
  } else if (["Express", "Fastify", "Hono", "NestJS"].includes(framework)) {
    // Grep for route patterns in source files
    walkForFiles(repoPath, (relPath, fullPath) => {
      if (!/\.(ts|js)$/.test(relPath)) return;
      try {
        const content = readFileSync(fullPath, "utf-8");
        const routePatterns = content.match(/(?:app|router|server)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g);
        if (routePatterns) {
          for (const match of routePatterns) {
            const pathMatch = match.match(/["'`]([^"'`]+)["'`]/);
            if (pathMatch && !routes.includes(pathMatch[1])) {
              routes.push(pathMatch[1]);
            }
          }
        }
      } catch {
        // Read error
      }
    });
  }

  return routes.slice(0, 100);
}

function detectComponents(repoPath: string, framework: string): string[] {
  const components: string[] = [];

  if (["Next.js", "React", "Vite + React", "Create React App"].includes(framework)) {
    walkForFiles(repoPath, (relPath, fullPath) => {
      if (!/\.(tsx|jsx)$/.test(relPath)) return;
      // Next.js App Router pages/layouts
      if (/\/(page|layout)\.(tsx|jsx)$/.test(relPath)) {
        const pagePath = relPath
          .replace(/^src\/app/, "")
          .replace(/\/(page|layout)\.(tsx|jsx)$/, "") || "/";
        const type = relPath.includes("layout.") ? "layout" : "page";
        components.push(`${pagePath} (${type})`);
        return;
      }
      // Regular components — check for export default or named function exports
      const fileName = basename(relPath, extname(relPath));
      if (/^[A-Z]/.test(fileName)) {
        components.push(fileName);
      }
    });
  } else if (["Vue", "Nuxt", "Vite + Vue"].includes(framework)) {
    walkForFiles(repoPath, (relPath) => {
      if (/\.vue$/.test(relPath)) {
        components.push(basename(relPath, ".vue"));
      }
    });
  } else if (["SvelteKit", "Vite + Svelte"].includes(framework)) {
    walkForFiles(repoPath, (relPath) => {
      if (/\.svelte$/.test(relPath)) {
        components.push(basename(relPath, ".svelte"));
      }
    });
  }

  return components.slice(0, 200);
}

function detectDbModels(repoPath: string): string[] {
  const models: string[] = [];

  // Prisma
  const prismaPath = join(repoPath, "prisma", "schema.prisma");
  if (existsSync(prismaPath)) {
    try {
      const content = readFileSync(prismaPath, "utf-8");
      const matches = content.match(/^model\s+(\w+)\s*\{/gm);
      if (matches) {
        for (const m of matches) {
          const name = m.match(/^model\s+(\w+)/)?.[1];
          if (name) models.push(`${name} (Prisma)`);
        }
      }
    } catch {
      // Read error
    }
  }

  // TypeORM entities
  walkForFiles(repoPath, (relPath, fullPath) => {
    if (/\.entity\.(ts|js)$/.test(relPath)) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        const match = content.match(/class\s+(\w+)/);
        if (match) models.push(`${match[1]} (TypeORM)`);
      } catch {
        // Read error
      }
    }
  });

  // Mongoose schemas
  walkForFiles(repoPath, (relPath, fullPath) => {
    if (/\.schema\.(ts|js)$/.test(relPath) && !relPath.includes("prisma")) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        if (content.includes("Schema(") || content.includes("mongoose")) {
          const match = content.match(/(?:class|const)\s+(\w+)/);
          if (match) models.push(`${match[1]} (Mongoose)`);
        }
      } catch {
        // Read error
      }
    }
  });

  // Sequelize/Django models directory
  const modelsDir = join(repoPath, "models");
  if (existsSync(modelsDir)) {
    try {
      const entries = readdirSync(modelsDir).filter(
        (f) => /\.(ts|js|py)$/.test(f) && f !== "index.ts" && f !== "index.js"
      );
      for (const entry of entries) {
        models.push(basename(entry, extname(entry)));
      }
    } catch {
      // Permission error
    }
  }

  return models;
}

function detectStateManagement(deps: string[]): string | null {
  const mapping: [string, string][] = [
    ["@reduxjs/toolkit", "Redux Toolkit"],
    ["redux", "Redux"],
    ["zustand", "Zustand"],
    ["recoil", "Recoil"],
    ["jotai", "Jotai"],
    ["mobx", "MobX"],
    ["valtio", "Valtio"],
    ["pinia", "Pinia"],
    ["vuex", "Vuex"],
    ["@tanstack/react-query", "TanStack Query"],
    ["swr", "SWR"],
    ["xstate", "XState"],
  ];

  const found: string[] = [];
  for (const [pkg, label] of mapping) {
    if (deps.includes(pkg)) found.push(label);
  }
  return found.length > 0 ? found.join(", ") : null;
}

function detectAuthPattern(repoPath: string, deps: string[]): string | null {
  const mapping: [string, string][] = [
    ["next-auth", "NextAuth.js"],
    ["@auth/core", "Auth.js"],
    ["passport", "Passport.js"],
    ["@clerk/nextjs", "Clerk"],
    ["@clerk/clerk-react", "Clerk"],
    ["@auth0/nextjs-auth0", "Auth0"],
    ["@auth0/auth0-react", "Auth0"],
    ["firebase", "Firebase Auth"],
    ["@supabase/supabase-js", "Supabase Auth"],
    ["@supabase/auth-helpers-nextjs", "Supabase Auth"],
    ["jsonwebtoken", "JWT (custom)"],
    ["bcrypt", "Password hashing (custom auth)"],
    ["bcryptjs", "Password hashing (custom auth)"],
    ["lucia", "Lucia Auth"],
    ["better-auth", "Better Auth"],
  ];

  const found: string[] = [];
  for (const [pkg, label] of mapping) {
    if (deps.includes(pkg) && !found.includes(label)) found.push(label);
  }

  // Check for auth directories
  const authDirs = ["src/auth", "src/lib/auth", "app/api/auth", "src/app/api/auth", "auth"];
  for (const dir of authDirs) {
    if (existsSync(join(repoPath, dir))) {
      if (found.length === 0) found.push("Custom auth directory");
      break;
    }
  }

  return found.length > 0 ? found.join(", ") : null;
}

function collectConfigSummary(repoPath: string): Record<string, string> {
  const summary: Record<string, string> = {};

  // tsconfig files — include all tsconfig*.json for accurate build path tracing
  try {
    const rootEntries = readdirSync(repoPath);
    const tsconfigFiles = rootEntries.filter(f => /^tsconfig.*\.json$/.test(f));
    for (const f of tsconfigFiles) {
      try {
        const content = readFileSync(join(repoPath, f), "utf-8");
        const config = JSON.parse(content);
        const opts = config.compilerOptions || {};
        const highlights: string[] = [];
        if (opts.strict) highlights.push("strict mode");
        if (opts.paths) highlights.push(`path aliases: ${Object.keys(opts.paths).join(", ")}`);
        if (opts.target) highlights.push(`target: ${opts.target}`);
        if (opts.module) highlights.push(`module: ${opts.module}`);
        if (opts.jsx) highlights.push(`jsx: ${opts.jsx}`);
        if (opts.outDir) highlights.push(`outDir: ${opts.outDir}`);
        if (opts.rootDir) highlights.push(`rootDir: ${opts.rootDir}`);
        if (config.include) highlights.push(`include: ${JSON.stringify(config.include)}`);
        summary[f] = highlights.join("; ") || "default config";
      } catch {
        // Parse error
      }
    }
  } catch {
    // Permission error
  }

  // ESLint config
  const eslintFiles = [".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yml", "eslint.config.js", "eslint.config.mjs"];
  for (const f of eslintFiles) {
    if (existsSync(join(repoPath, f))) {
      summary["eslint"] = f;
      break;
    }
  }

  // Prettier config
  const prettierFiles = [".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js", "prettier.config.mjs"];
  for (const f of prettierFiles) {
    if (existsSync(join(repoPath, f))) {
      summary["prettier"] = f;
      break;
    }
  }

  // Tailwind config
  const tailwindFiles = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs"];
  for (const f of tailwindFiles) {
    const fullPath = join(repoPath, f);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        const plugins = content.match(/require\(["']([^"']+)["']\)/g);
        summary["tailwind"] = plugins
          ? `${f} (plugins: ${plugins.map((p) => p.match(/["']([^"']+)["']/)?.[1]).filter(Boolean).join(", ")})`
          : f;
      } catch {
        summary["tailwind"] = f;
      }
      break;
    }
  }

  // Next.js config
  const nextFiles = ["next.config.ts", "next.config.js", "next.config.mjs"];
  for (const f of nextFiles) {
    if (existsSync(join(repoPath, f))) {
      summary["next.config"] = f;
      break;
    }
  }

  // Vite config
  const viteFiles = ["vite.config.ts", "vite.config.js", "vite.config.mjs"];
  for (const f of viteFiles) {
    if (existsSync(join(repoPath, f))) {
      summary["vite.config"] = f;
      break;
    }
  }

  // Docker
  if (existsSync(join(repoPath, "Dockerfile")) || existsSync(join(repoPath, "docker-compose.yml")) || existsSync(join(repoPath, "docker-compose.yaml"))) {
    summary["docker"] = [
      existsSync(join(repoPath, "Dockerfile")) ? "Dockerfile" : "",
      existsSync(join(repoPath, "docker-compose.yml")) || existsSync(join(repoPath, "docker-compose.yaml")) ? "docker-compose" : "",
    ].filter(Boolean).join(", ");
  }

  return summary;
}

function collectEnvVars(repoPath: string): string[] {
  const envFiles = [".env.example", ".env.sample", ".env.local", ".env.template", ".env.development"];
  const vars: Set<string> = new Set();

  for (const f of envFiles) {
    const fullPath = join(repoPath, f);
    if (!existsSync(fullPath)) continue;
    try {
      const content = readFileSync(fullPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
        if (match) vars.add(match[1]);
      }
    } catch {
      // Read error
    }
  }

  return Array.from(vars);
}

function detectMonorepo(repoPath: string): string | null {
  // Turborepo
  if (existsSync(join(repoPath, "turbo.json"))) return "Turborepo";

  // Nx
  if (existsSync(join(repoPath, "nx.json"))) return "Nx";

  // Lerna
  if (existsSync(join(repoPath, "lerna.json"))) return "Lerna";

  // pnpm workspaces
  if (existsSync(join(repoPath, "pnpm-workspace.yaml"))) return "pnpm workspaces";

  // npm/yarn workspaces in package.json
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.workspaces) return "npm/yarn workspaces";
    } catch {
      // Parse error
    }
  }

  return null;
}

function collectSourceExcerpts(repoPath: string, entryPoints: string[]): Record<string, string> {
  const excerpts: Record<string, string> = {};
  let count = 0;

  // Key architecture files to try reading
  const candidates = [
    ...entryPoints,
    "src/app/layout.tsx",
    "src/app/page.tsx",
    "src/middleware.ts",
    "src/lib/db.ts",
    "src/lib/auth.ts",
    "prisma/schema.prisma",
    "next.config.ts",
    "next.config.js",
    "next.config.mjs",
    "vite.config.ts",
    "src/store/index.ts",
    "src/store.ts",
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (count >= MAX_SOURCE_EXCERPTS) break;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const fullPath = join(repoPath, candidate);
    if (!existsSync(fullPath)) continue;

    try {
      const content = readFileSync(fullPath, "utf-8");
      const lines = content.split("\n").slice(0, MAX_EXCERPT_LINES);
      excerpts[candidate] = lines.join("\n");
      count++;
    } catch {
      // Read error
    }
  }

  return excerpts;
}

/** Walk source files and call callback with relative path and full path */
function walkForFiles(repoPath: string, callback: (relPath: string, fullPath: string) => void): void {
  let count = 0;
  const maxFiles = 5000; // Safety limit for walking

  function walk(dir: string) {
    if (count >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (count >= maxFiles) break;
      if (entry.startsWith(".") && entry !== ".github") continue;
      if (IGNORE_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          count++;
          callback(relative(repoPath, fullPath), fullPath);
        }
      } catch {
        // Permission error
      }
    }
  }

  walk(repoPath);
}

const MAX_DOC_FILES = 10;
const MAX_DOC_SIZE = 3000; // chars per doc file

/** Collect key documentation files (markdown, text) from the repo root and docs/ directory */
function collectDocFiles(repoPath: string): Record<string, string> {
  const docs: Record<string, string> = {};
  let count = 0;

  // Known doc file patterns at root level (README is already in existingDocs, skip it)
  const rootCandidates = [
    "API.md", "api.md",
    "ARCHITECTURE.md", "architecture.md",
    "CONTRIBUTING.md", "contributing.md",
    "CHANGELOG.md", "changelog.md",
    "DEPLOYMENT.md", "deployment.md",
    "DESIGN.md", "design.md",
    "DEVELOPMENT.md", "development.md",
    "SECURITY.md", "security.md",
    "TODO.md", "todo.md",
    "ROADMAP.md", "roadmap.md",
    "SETUP.md", "setup.md",
    "GETTING_STARTED.md", "getting-started.md",
    "RELEASE_NOTES.md",
  ];

  for (const candidate of rootCandidates) {
    if (count >= MAX_DOC_FILES) break;
    const fullPath = join(repoPath, candidate);
    if (!existsSync(fullPath)) continue;
    try {
      const content = readFileSync(fullPath, "utf-8");
      docs[candidate] = content.slice(0, MAX_DOC_SIZE);
      count++;
    } catch {
      // Read error
    }
  }

  // Also check for RELEASE_NOTES_*.md pattern at root
  try {
    const rootEntries = readdirSync(repoPath);
    for (const entry of rootEntries) {
      if (count >= MAX_DOC_FILES) break;
      if (/^RELEASE_NOTES.*\.md$/i.test(entry) && !docs[entry]) {
        const fullPath = join(repoPath, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isFile()) {
            docs[entry] = readFileSync(fullPath, "utf-8").slice(0, MAX_DOC_SIZE);
            count++;
          }
        } catch {
          // Read error
        }
      }
    }
  } catch {
    // Permission error
  }

  // Scan docs/ directory if it exists
  const docsDir = join(repoPath, "docs");
  if (existsSync(docsDir)) {
    try {
      const entries = readdirSync(docsDir).filter((f) => /\.md$/i.test(f));
      for (const entry of entries) {
        if (count >= MAX_DOC_FILES) break;
        const relPath = `docs/${entry}`;
        const fullPath = join(docsDir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isFile()) {
            docs[relPath] = readFileSync(fullPath, "utf-8").slice(0, MAX_DOC_SIZE);
            count++;
          }
        } catch {
          // Read error
        }
      }
    } catch {
      // Permission error
    }
  }

  return docs;
}
