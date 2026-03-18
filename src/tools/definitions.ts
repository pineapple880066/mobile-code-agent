import { exec, execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import fg from "fast-glob";
import { z } from "zod";

import type { ToolCall, ToolSpec } from "../agent/types.js";
import type { IndexManager } from "../rag/index-manager.js";
import {
  listWorkspaceDirectory,
  relativeToWorkspace,
  resolveWorkspacePath,
  SEARCH_IGNORE,
} from "../workspace/fs.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_TOOL_RESULT_CHARS = 12_000;
const DEFAULT_READ_LIMIT = 250;
const MAX_GLOB_RESULTS = 200;
const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const MAX_CHECK_TIMEOUT_MS = 600_000;

type ToolContext = {
  workspaceRoot: string;
  indexManager?: IndexManager;
  gitBaselinePromise: Promise<GitSnapshot | null>;
  packageMetadataPromise: Promise<PackageMetadata>;
};

type GitSnapshot = {
  branch: string;
  raw: string;
  entries: string[];
  clean: boolean;
};

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type PackageMetadata = {
  packageManager: PackageManager;
  scripts: Record<string, string>;
};

type CheckProfile = "auto" | "safety" | "build" | "test" | "lint" | "typecheck";

type CheckCommand = {
  label: string;
  command: string;
};

type ToolPayload = {
  ok: boolean;
  summary: string;
  content?: string;
  items?: string[];
  path?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

type ToolDefinition<TInput> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parse: (value: unknown) => TInput;
  execute: (input: TInput, context: ToolContext) => Promise<ToolPayload>;
};

export type ToolRegistry = {
  specs: ToolSpec[];
  execute(toolCall: ToolCall): Promise<string>;
};

function truncate(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...<truncated>`;
}

function serialize(payload: ToolPayload): string {
  return truncate(JSON.stringify(payload, null, 2));
}

function scriptCommand(packageManager: PackageManager, scriptName: string): string {
  if (packageManager === "yarn") {
    return `yarn ${scriptName}`;
  }

  if (packageManager === "pnpm") {
    return scriptName === "test" ? "pnpm test" : `pnpm run ${scriptName}`;
  }

  if (packageManager === "bun") {
    return `bun run ${scriptName}`;
  }

  return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
}

function parsePackageManager(value: unknown): PackageManager | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const name = value.split("@")[0]?.trim();
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : null;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageMetadata(workspaceRoot: string): Promise<PackageMetadata> {
  let parsedPackageJson: Record<string, unknown> = {};

  try {
    const raw = await readFile(path.join(workspaceRoot, "package.json"), "utf8");
    parsedPackageJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsedPackageJson = {};
  }

  const packageManagerFromManifest = parsePackageManager(parsedPackageJson.packageManager);
  const scriptsValue = parsedPackageJson.scripts;
  const scripts =
    scriptsValue && typeof scriptsValue === "object"
      ? Object.fromEntries(
          Object.entries(scriptsValue).filter(
            (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
          ),
        )
      : {};

  let packageManager = packageManagerFromManifest;

  if (!packageManager && (await fileExists(path.join(workspaceRoot, "pnpm-lock.yaml")))) {
    packageManager = "pnpm";
  }
  if (!packageManager && (await fileExists(path.join(workspaceRoot, "yarn.lock")))) {
    packageManager = "yarn";
  }
  if (!packageManager && (await fileExists(path.join(workspaceRoot, "bun.lockb")) || (await fileExists(path.join(workspaceRoot, "bun.lock"))))) {
    packageManager = "bun";
  }

  return {
    packageManager: packageManager ?? "npm",
    scripts,
  };
}

function parseGitSnapshot(raw: string): GitSnapshot {
  const trimmed = raw.trimEnd();
  const lines = trimmed ? trimmed.split(/\r?\n/) : [];
  const branch = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "(detached)";
  const entries = lines.slice(1).filter(Boolean);

  return {
    branch,
    raw,
    entries,
    clean: entries.length === 0,
  };
}

async function captureGitSnapshot(workspaceRoot: string): Promise<GitSnapshot | null> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--branch", "--porcelain=v1"], {
      cwd: workspaceRoot,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });

    return parseGitSnapshot(stdout);
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException & { code?: string | number; status?: number };
    const code = typedError.code !== undefined ? String(typedError.code) : "";
    const status = typedError.status;

    if (code === "128" || code === "ENOENT" || status === 128) {
      return null;
    }

    throw error;
  }
}

function captureGitSnapshotSync(workspaceRoot: string): GitSnapshot | null {
  const result = spawnSync("git", ["status", "--short", "--branch", "--porcelain=v1"], {
    cwd: workspaceRoot,
    timeout: 15_000,
    encoding: "utf8",
  });

  const spawnError = result.error as (NodeJS.ErrnoException & { code?: string | number }) | undefined;
  const errorCode = spawnError?.code !== undefined ? String(spawnError.code) : "";
  if (errorCode === "ENOENT" || result.status === 128) {
    return null;
  }

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || "git status failed.");
  }

  return parseGitSnapshot(result.stdout);
}

function summarizeGitEntries(entries: string[]): string[] {
  return entries.length > 0 ? entries : ["Working tree clean."];
}

function resolveCheckCommands(
  profile: CheckProfile,
  packageMetadata: PackageMetadata,
  gitSnapshot: GitSnapshot | null,
): CheckCommand[] {
  const commands: CheckCommand[] = [];

  if ((profile === "auto" || profile === "safety") && gitSnapshot) {
    commands.push({
      label: "git diff --check",
      command: "git diff --check",
    });
  }

  const scriptNamesByProfile: Record<CheckProfile, string[]> = {
    auto: ["lint", "typecheck", "build", "test"],
    safety: [],
    build: ["build"],
    test: ["test"],
    lint: ["lint"],
    typecheck: ["typecheck"],
  };

  for (const scriptName of scriptNamesByProfile[profile]) {
    if (!packageMetadata.scripts[scriptName]) {
      continue;
    }

    commands.push({
      label: `${packageMetadata.packageManager}:${scriptName}`,
      command: scriptCommand(packageMetadata.packageManager, scriptName),
    });
  }

  return commands;
}

async function runCheckCommands(commands: CheckCommand[], cwd: string, timeout: number): Promise<ToolPayload> {
  if (commands.length === 0) {
    return {
      ok: true,
      summary: "No matching checks are configured for this workspace.",
      items: [],
      content: "",
    };
  }

  const outputs: string[] = [];

  for (const command of commands) {
    const result = await runCommand(command.command, cwd, timeout);
    outputs.push(
      [`$ ${command.command}`, result.stdout || "", result.stderr || ""].filter(Boolean).join("\n"),
    );

    if (!result.ok) {
      return {
        ok: false,
        summary: `Check failed: ${command.label}`,
        exitCode: result.exitCode,
        content: outputs.join("\n\n"),
      };
    }
  }

  return {
    ok: true,
    summary: `Completed ${commands.length} check command(s) successfully.`,
    items: commands.map((command) => command.label),
    content: outputs.join("\n\n"),
  };
}

async function fallbackSearch(workspaceRoot: string, query: string, filePattern: string | undefined, limit: number): Promise<string[]> {
  const entries = await fg(filePattern ? [filePattern] : ["**/*"], {
    cwd: workspaceRoot,
    dot: true,
    ignore: SEARCH_IGNORE,
    onlyFiles: true,
  });

  const matches: string[] = [];

  for (const relativeFile of entries) {
    if (matches.length >= limit) {
      break;
    }

    const absoluteFile = path.join(workspaceRoot, relativeFile);
    let raw = "";

    try {
      raw = await readFile(absoluteFile, "utf8");
    } catch {
      continue;
    }

    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]?.includes(query)) {
        matches.push(`${relativeFile}:${index + 1}:${lines[index]}`);
        if (matches.length >= limit) {
          break;
        }
      }
    }
  }

  return matches;
}

async function runCommand(command: string, cwd: string, timeout: number): Promise<ToolPayload> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      shell: process.env.SHELL ?? "/bin/zsh",
    });

    return {
      ok: true,
      summary: "Command completed successfully.",
      exitCode: 0,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
    };
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: NodeJS.Signals;
    };

    return {
      ok: false,
      summary: typedError.killed ? "Command timed out." : "Command exited with a non-zero status.",
      exitCode: typeof typedError.code === "number" ? typedError.code : undefined,
      stdout: truncate(typedError.stdout ?? ""),
      stderr: truncate(typedError.stderr ?? String(error)),
    };
  }
}

const readFileTool: ToolDefinition<{
  path: string;
  offset?: number;
  limit?: number;
}> = {
  name: "read_file",
  description: "Read a text file from the workspace with optional line offset and limit.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    required: ["path"],
  },
  parse: (value) =>
    z
      .object({
        path: z.string().min(1),
        offset: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const targetPath = await resolveWorkspacePath(context.workspaceRoot, input.path);
    const raw = await readFile(targetPath, "utf8");
    const lines = raw.split(/\r?\n/);
    const startLine = Math.max(1, input.offset ?? 1);
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    const selected = lines.slice(startLine - 1, startLine - 1 + limit);
    const numbered = selected.map((line, index) => `${startLine + index} | ${line}`).join("\n");

    return {
      ok: true,
      summary: `Read ${selected.length} line(s) from ${relativeToWorkspace(context.workspaceRoot, targetPath)}.`,
      path: relativeToWorkspace(context.workspaceRoot, targetPath),
      content: truncate(numbered),
    };
  },
};

const writeFileTool: ToolDefinition<{
  path: string;
  content: string;
}> = {
  name: "write_file",
  description: "Create or overwrite a file in the workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  parse: (value) =>
    z
      .object({
        path: z.string().min(1),
        content: z.string(),
      })
      .parse(value),
  execute: async (input, context) => {
    const targetPath = await resolveWorkspacePath(context.workspaceRoot, input.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, input.content, "utf8");
    const fileStats = await stat(targetPath);

    return {
      ok: true,
      summary: `Wrote ${fileStats.size} byte(s) to ${relativeToWorkspace(context.workspaceRoot, targetPath)}.`,
      path: relativeToWorkspace(context.workspaceRoot, targetPath),
    };
  },
};

const editFileTool: ToolDefinition<{
  path: string;
  oldText: string;
  newText: string;
}> = {
  name: "edit_file",
  description: "Edit a file by replacing one exact text occurrence.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
    },
    required: ["path", "oldText", "newText"],
  },
  parse: (value) =>
    z
      .object({
        path: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
      })
      .parse(value),
  execute: async (input, context) => {
    const targetPath = await resolveWorkspacePath(context.workspaceRoot, input.path);
    const current = await readFile(targetPath, "utf8");
    const occurrences = current.split(input.oldText).length - 1;

    if (occurrences === 0) {
      throw new Error("oldText was not found in the target file.");
    }

    if (occurrences > 1) {
      throw new Error("oldText matched multiple locations. Use a more specific snippet.");
    }

    const updated = current.replace(input.oldText, input.newText);
    await writeFile(targetPath, updated, "utf8");

    return {
      ok: true,
      summary: `Updated ${relativeToWorkspace(context.workspaceRoot, targetPath)} with one exact replacement.`,
      path: relativeToWorkspace(context.workspaceRoot, targetPath),
    };
  },
};

const searchCodeTool: ToolDefinition<{
  query: string;
  filePattern?: string;
  limit?: number;
}> = {
  name: "search_code",
  description: "Search code using the indexed hybrid search, optionally constrained by a glob pattern.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string" },
      filePattern: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["query"],
  },
  parse: (value) =>
    z
      .object({
        query: z.string().min(1),
        filePattern: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const limit = input.limit ?? 20;
    if (context.indexManager) {
      const results = await context.indexManager.search({
        query: input.query,
        filePattern: input.filePattern,
        limit,
      });

      const formatted = results.map(
        (result) =>
          `${result.chunk.filePath}:${result.chunk.startLine}-${result.chunk.endLine} score=${result.score.toFixed(4)}\n${result.chunk.text}`,
      );

      return {
        ok: true,
        summary: formatted.length > 0 ? `Found ${formatted.length} indexed match(es).` : "No indexed matches found.",
        items: formatted,
        content: formatted.join("\n\n"),
      };
    }

    let lines: string[] = [];

    try {
      const args = ["-n", "--no-heading", "--color", "never", "-F", input.query];
      if (input.filePattern) {
        args.push("-g", input.filePattern);
      }
      args.push(".");

      const { stdout } = await execFileAsync("rg", args, {
        cwd: context.workspaceRoot,
        maxBuffer: 1024 * 1024,
      });

      lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, limit);
    } catch (error) {
      const typedError = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string };
      const errorCode = typedError.code !== undefined ? String(typedError.code) : undefined;

      if (errorCode === "1") {
        lines = [];
      } else if (errorCode === "ENOENT") {
        lines = await fallbackSearch(context.workspaceRoot, input.query, input.filePattern, limit);
      } else {
        throw error;
      }
    }

    return {
      ok: true,
      summary: lines.length > 0 ? `Found ${lines.length} match(es).` : "No matches found.",
      items: lines,
      content: lines.join("\n"),
    };
  },
};

const listDirectoryTool: ToolDefinition<{
  path: string;
}> = {
  name: "list_directory",
  description: "List files and directories for a path inside the workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
  parse: (value) =>
    z
      .object({
        path: z.string().min(1),
      })
      .parse(value),
  execute: async (input, context) => {
    const items = await listWorkspaceDirectory(context.workspaceRoot, input.path);
    const targetPath = await resolveWorkspacePath(context.workspaceRoot, input.path);

    return {
      ok: true,
      summary: `Listed ${items.length} item(s) from ${relativeToWorkspace(context.workspaceRoot, targetPath)}.`,
      items,
      path: relativeToWorkspace(context.workspaceRoot, targetPath),
      content: items.join("\n"),
    };
  },
};

const globTool: ToolDefinition<{
  pattern: string;
  root?: string;
}> = {
  name: "glob",
  description: "Find files or directories by glob pattern inside the workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: { type: "string" },
      root: { type: "string" },
    },
    required: ["pattern"],
  },
  parse: (value) =>
    z
      .object({
        pattern: z.string().min(1),
        root: z.string().optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const searchRoot = input.root
      ? await resolveWorkspacePath(context.workspaceRoot, input.root)
      : context.workspaceRoot;

    const matches = await fg([input.pattern], {
      cwd: searchRoot,
      dot: true,
      ignore: SEARCH_IGNORE,
      onlyFiles: false,
    });

    const normalized = matches
      .slice(0, MAX_GLOB_RESULTS)
      .map((match) => relativeToWorkspace(context.workspaceRoot, path.join(searchRoot, match)));

    return {
      ok: true,
      summary: normalized.length > 0 ? `Found ${normalized.length} path(s).` : "No matches found.",
      items: normalized,
      content: normalized.join("\n"),
    };
  },
};

const gitStatusTool: ToolDefinition<Record<string, never>> = {
  name: "git_status",
  description: "Inspect the current git branch and working tree status.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  parse: (value) => z.object({}).parse(value),
  execute: async (_input, context) => {
    const [baseline, current] = await Promise.all([context.gitBaselinePromise, captureGitSnapshot(context.workspaceRoot)]);

    if (!current) {
      return {
        ok: false,
        summary: "This workspace is not inside a git repository.",
      };
    }

    const baselineNote =
      baseline && !baseline.clean
        ? "Repository was already dirty when this agent run started; avoid automatic commits unless the user explicitly wants that."
        : "Repository was clean when this agent run started.";

    return {
      ok: true,
      summary: current.clean ? `Git branch ${current.branch} is clean.` : `Git branch ${current.branch} has ${current.entries.length} change(s).`,
      items: summarizeGitEntries(current.entries),
      content: [baselineNote, "", current.raw.trim() || "Working tree clean."].join("\n"),
    };
  },
};

const gitDiffTool: ToolDefinition<{
  path?: string;
  staged?: boolean;
  contextLines?: number;
}> = {
  name: "git_diff",
  description: "Show git diff output for the whole workspace or a single path.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      staged: { type: "boolean" },
      contextLines: { type: "integer", minimum: 0, maximum: 20 },
    },
  },
  parse: (value) =>
    z
      .object({
        path: z.string().min(1).optional(),
        staged: z.boolean().optional(),
        contextLines: z.number().int().min(0).max(20).optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const snapshot = await captureGitSnapshot(context.workspaceRoot);

    if (!snapshot) {
      return {
        ok: false,
        summary: "This workspace is not inside a git repository.",
      };
    }

    const args = ["diff"];
    if (input.staged) {
      args.push("--cached");
    }
    if (input.contextLines !== undefined) {
      args.push(`--unified=${input.contextLines}`);
    }
    if (input.path) {
      const targetPath = await resolveWorkspacePath(context.workspaceRoot, input.path);
      args.push("--", relativeToWorkspace(context.workspaceRoot, targetPath));
    }

    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: context.workspaceRoot,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });

      return {
        ok: true,
        summary: stdout.trim() ? "Generated git diff output." : "No diff output for the requested scope.",
        content: stdout ? truncate(stdout) : "",
      };
    } catch (error) {
      return {
        ok: false,
        summary: "git diff failed.",
        content: String(error),
      };
    }
  },
};

const runChecksTool: ToolDefinition<{
  profile?: CheckProfile;
  timeout?: number;
}> = {
  name: "run_checks",
  description: "Run safety/build/test/typecheck checks detected from the current workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      profile: {
        type: "string",
        enum: ["auto", "safety", "build", "test", "lint", "typecheck"],
      },
      timeout: { type: "integer", minimum: 1000, maximum: MAX_CHECK_TIMEOUT_MS },
    },
  },
  parse: (value) =>
    z
      .object({
        profile: z.enum(["auto", "safety", "build", "test", "lint", "typecheck"]).optional(),
        timeout: z.number().int().min(1000).max(MAX_CHECK_TIMEOUT_MS).optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const [gitSnapshot, packageMetadata] = await Promise.all([
      captureGitSnapshot(context.workspaceRoot),
      context.packageMetadataPromise,
    ]);

    const commands = resolveCheckCommands(input.profile ?? "auto", packageMetadata, gitSnapshot);
    return runCheckCommands(commands, context.workspaceRoot, input.timeout ?? DEFAULT_CHECK_TIMEOUT_MS);
  },
};

const gitCommitTool: ToolDefinition<{
  message: string;
  stageAll?: boolean;
}> = {
  name: "git_commit",
  description: "Stage changes and create a git commit, refusing when the repository was already dirty at the start of the agent run.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: { type: "string" },
      stageAll: { type: "boolean" },
    },
    required: ["message"],
  },
  parse: (value) =>
    z
      .object({
        message: z.string().min(1),
        stageAll: z.boolean().optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const baseline = await context.gitBaselinePromise;

    if (!baseline) {
      return {
        ok: false,
        summary: "This workspace is not inside a git repository.",
      };
    }

    if (!baseline.clean) {
      return {
        ok: false,
        summary: "Repository was not clean at the start of this agent run. Refusing automatic commit to avoid capturing unrelated changes.",
        items: summarizeGitEntries(baseline.entries),
        content: baseline.raw,
      };
    }

    if (input.stageAll ?? true) {
      await execFileAsync("git", ["add", "-A"], {
        cwd: context.workspaceRoot,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    }

    const { stdout: stagedNames } = await execFileAsync("git", ["diff", "--cached", "--name-only"], {
      cwd: context.workspaceRoot,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });

    const stagedFiles = stagedNames.split(/\r?\n/).filter(Boolean);
    if (stagedFiles.length === 0) {
      return {
        ok: false,
        summary: "No staged changes to commit.",
      };
    }

    try {
      await execFileAsync("git", ["diff", "--cached", "--check"], {
        cwd: context.workspaceRoot,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const typedError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      return {
        ok: false,
        summary: "Staged changes failed git diff --check.",
        stdout: truncate(typedError.stdout ?? ""),
        stderr: truncate(typedError.stderr ?? String(error)),
      };
    }

    try {
      const { stdout } = await execFileAsync("git", ["commit", "-m", input.message], {
        cwd: context.workspaceRoot,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      const { stdout: commitHash } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: context.workspaceRoot,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });

      return {
        ok: true,
        summary: `Created commit ${commitHash.trim()} with ${stagedFiles.length} staged file(s).`,
        items: stagedFiles,
        stdout: truncate(stdout),
      };
    } catch (error) {
      const typedError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      return {
        ok: false,
        summary: "git commit failed.",
        stdout: truncate(typedError.stdout ?? ""),
        stderr: truncate(typedError.stderr ?? String(error)),
      };
    }
  },
};

const executeCommandTool: ToolDefinition<{
  command: string;
  cwd?: string;
  timeout?: number;
}> = {
  name: "execute_command",
  description: "Run a shell command inside the workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeout: { type: "integer", minimum: 100, maximum: 120000 },
    },
    required: ["command"],
  },
  parse: (value) =>
    z
      .object({
        command: z.string().min(1),
        cwd: z.string().optional(),
        timeout: z.number().int().min(100).max(120_000).optional(),
      })
      .parse(value),
  execute: async (input, context) => {
    const cwd = input.cwd
      ? await resolveWorkspacePath(context.workspaceRoot, input.cwd)
      : context.workspaceRoot;

    return runCommand(input.command, cwd, input.timeout ?? 30_000);
  },
};

const definitions: ToolDefinition<unknown>[] = [
  readFileTool as ToolDefinition<unknown>,
  writeFileTool as ToolDefinition<unknown>,
  editFileTool as ToolDefinition<unknown>,
  searchCodeTool as ToolDefinition<unknown>,
  listDirectoryTool as ToolDefinition<unknown>,
  globTool as ToolDefinition<unknown>,
  gitStatusTool as ToolDefinition<unknown>,
  gitDiffTool as ToolDefinition<unknown>,
  runChecksTool as ToolDefinition<unknown>,
  gitCommitTool as ToolDefinition<unknown>,
  executeCommandTool as ToolDefinition<unknown>,
];

export function createToolRegistry(workspaceRoot: string, indexManager?: IndexManager): ToolRegistry {
  const context: ToolContext = {
    workspaceRoot,
    indexManager,
    gitBaselinePromise: Promise.resolve(captureGitSnapshotSync(workspaceRoot)),
    packageMetadataPromise: readPackageMetadata(workspaceRoot),
  };
  const definitionMap = new Map(definitions.map((definition) => [definition.name, definition]));

  return {
    specs: definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
    async execute(toolCall) {
      const definition = definitionMap.get(toolCall.name);

      if (!definition) {
        return serialize({
          ok: false,
          summary: `Unknown tool: ${toolCall.name}`,
        });
      }

      try {
        const args = JSON.parse(toolCall.arguments);
        const input = definition.parse(args);
        const result = await definition.execute(input, context);
        return serialize(result);
      } catch (error) {
        return serialize({
          ok: false,
          summary: `Tool ${toolCall.name} failed.`,
          content: String(error),
        });
      }
    },
  };
}
