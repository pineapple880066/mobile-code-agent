import { config as loadEnv } from "dotenv";
import os from "node:os";

import { createApp } from "./api/app.js";
import { resolveChatConfig, resolveEmbeddingConfig, resolveServerConfig } from "./config.js";
import { IndexManager } from "./rag/index-manager.js";

loadEnv();

const serverConfig = resolveServerConfig();
const chatConfig = resolveChatConfig();
const indexManager = new IndexManager(serverConfig.workspaceRoot, resolveEmbeddingConfig());

await indexManager.initialize();
indexManager.startWatching();

const app = createApp({
  serverConfig,
  chatConfig,
  indexManager,
});

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function listNetworkUrls(port: number): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && entry.family === "IPv4" && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}`);
}

const server = app.listen(serverConfig.port, serverConfig.host, () => {
  const bindLabel = serverConfig.host === "0.0.0.0" ? "all interfaces" : serverConfig.host;
  process.stdout.write(
    `Code Agent server running on ${bindLabel}:${serverConfig.port} for ${serverConfig.workspaceRoot}\n`,
  );

  if (serverConfig.host === "0.0.0.0") {
    for (const url of listNetworkUrls(serverConfig.port)) {
      process.stdout.write(`Public URL candidate: ${url}\n`);
    }
  }

  if (!isLoopbackHost(serverConfig.host) && !serverConfig.authToken) {
    process.stderr.write(
      "Warning: server is listening beyond localhost without CODE_AGENT_AUTH_TOKEN. Put it behind auth/TLS before exposing it publicly.\n",
    );
  }
});

const shutdown = async () => {
  server.close();
  await indexManager.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
