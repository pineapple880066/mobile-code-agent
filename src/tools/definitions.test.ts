import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createToolRegistry } from "./definitions.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(workspaceRoot: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.name", "Code Agent Test"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.email", "code-agent@example.com"], { cwd: workspaceRoot });
}

test("edit_file updates exactly one match", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-agent-"));
  const filePath = path.join(workspaceRoot, "example.ts");
  await writeFile(filePath, "const value = 1;\n", "utf8");

  const tools = createToolRegistry(workspaceRoot);
  const result = await tools.execute({
    id: "tool-1",
    name: "edit_file",
    arguments: JSON.stringify({
      path: "example.ts",
      oldText: "value = 1",
      newText: "value = 2",
    }),
  });

  assert.match(result, /"ok": true/);
  assert.equal(await readFile(filePath, "utf8"), "const value = 2;\n");
});

test("edit_file rejects ambiguous matches", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-agent-"));
  await writeFile(path.join(workspaceRoot, "example.ts"), "foo\nfoo\n", "utf8");

  const tools = createToolRegistry(workspaceRoot);
  const result = await tools.execute({
    id: "tool-2",
    name: "edit_file",
    arguments: JSON.stringify({
      path: "example.ts",
      oldText: "foo",
      newText: "bar",
    }),
  });

  assert.match(result, /multiple locations/);
});

test("write_file stays inside the workspace boundary", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-agent-"));
  const tools = createToolRegistry(workspaceRoot);

  const result = await tools.execute({
    id: "tool-3",
    name: "write_file",
    arguments: JSON.stringify({
      path: "../escape.txt",
      content: "nope",
    }),
  });

  assert.match(result, /escapes workspace/);
});

test("run_checks auto runs available package scripts", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-agent-"));
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "check-fixture",
        private: true,
        scripts: {
          build: "node -e \"console.log('build ok')\"",
          test: "node -e \"console.log('test ok')\"",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const tools = createToolRegistry(workspaceRoot);
  const result = await tools.execute({
    id: "tool-4",
    name: "run_checks",
    arguments: JSON.stringify({
      profile: "auto",
      timeout: 10_000,
    }),
  });

  assert.match(result, /Completed 2 check command/);
  assert.match(result, /build ok/);
  assert.match(result, /test ok/);
});

test("git_commit creates a commit when the baseline was clean", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-agent-"));
  await initGitRepo(workspaceRoot);

  const tools = createToolRegistry(workspaceRoot);
  await writeFile(path.join(workspaceRoot, "hello.ts"), "export const hello = 'world';\n", "utf8");

  const result = await tools.execute({
    id: "tool-5",
    name: "git_commit",
    arguments: JSON.stringify({
      message: "Add hello module",
    }),
  });

  assert.match(result, /"ok": true/);
  const log = await execFileAsync("git", ["log", "--oneline", "-1"], { cwd: workspaceRoot });
  assert.match(log.stdout, /Add hello module/);
});

test("git_commit refuses when the repository was already dirty at tool creation time", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-agent-"));
  await initGitRepo(workspaceRoot);
  await writeFile(path.join(workspaceRoot, "dirty.ts"), "export const dirty = true;\n", "utf8");

  const tools = createToolRegistry(workspaceRoot);
  const result = await tools.execute({
    id: "tool-6",
    name: "git_commit",
    arguments: JSON.stringify({
      message: "Should not commit",
    }),
  });

  assert.match(result, /not clean at the start of this agent run/);
});
