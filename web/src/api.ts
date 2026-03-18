import type {
  AgentStreamEvent,
  AppConfig,
  DirectoryEntry,
  FileResponse,
  IndexStatus,
  SearchResult,
  SessionMessage,
} from "./types";

const AUTH_STORAGE_KEY = "code-agent-auth-token";

function persistAuthTokenFromUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const url = new URL(window.location.href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const token = url.searchParams.get("token")?.trim() || hashParams.get("token")?.trim() || "";

  if (!token) {
    return window.localStorage.getItem(AUTH_STORAGE_KEY);
  }

  window.localStorage.setItem(AUTH_STORAGE_KEY, token);

  if (url.searchParams.has("token")) {
    url.searchParams.delete("token");
  }
  if (hashParams.has("token")) {
    hashParams.delete("token");
    url.hash = hashParams.toString();
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash ? `#${url.hash.replace(/^#/, "")}` : ""}`;
  window.history.replaceState(null, "", nextUrl);
  return token;
}

function resolveAuthToken(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return persistAuthTokenFromUrl() ?? "";
}

function withAuthHeaders(init?: RequestInit): RequestInit {
  const token = resolveAuthToken();
  const headers = new Headers(init?.headers);

  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  return {
    ...init,
    headers,
  };
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, withAuthHeaders(init));
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}

export function getConfig(): Promise<AppConfig> {
  return fetchJson<AppConfig>("/api/config");
}

export async function getDirectory(path = "."): Promise<{ path: string; entries: DirectoryEntry[] }> {
  return fetchJson(`/api/files/list?path=${encodeURIComponent(path)}`);
}

export function getFile(path: string): Promise<FileResponse> {
  return fetchJson(`/api/files/content?path=${encodeURIComponent(path)}`);
}

export function saveFile(path: string, content: string): Promise<{ path: string }> {
  return fetchJson("/api/files/content", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ path, content }),
  });
}

export async function getSearchResults(query: string, limit = 8): Promise<SearchResult[]> {
  const payload = await fetchJson<{ results: SearchResult[] }>(
    `/api/search?query=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return payload.results;
}

export function rebuildIndex(): Promise<IndexStatus> {
  return fetchJson("/api/index/rebuild", {
    method: "POST",
  });
}

export function getIndexStatus(): Promise<IndexStatus> {
  return fetchJson("/api/index/status");
}

export async function getSession(sessionId: string): Promise<{ id: string; messages: SessionMessage[] }> {
  return fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export async function streamAgent(
  payload: {
    message: string;
    sessionId: string;
    maxSteps?: number;
    reset?: boolean;
  },
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const response = await fetch("/api/agent/stream", {
    ...withAuthHeaders({
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
    method: "POST",
  });

  if (!response.ok || !response.body) {
    throw new Error(await response.text());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const eventName = rawEvent
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.replace("event:", "")
        .trim();
      const dataLine = rawEvent
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.replace("data:", "")
        .trim();

      if (!eventName || !dataLine) {
        continue;
      }

      onEvent({
        event: eventName as AgentStreamEvent["event"],
        data: JSON.parse(dataLine) as AgentStreamEvent["data"],
      } as AgentStreamEvent);
    }
  }
}
