import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { app } from "electron";
import { z } from "zod";

const outcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }),
  z.object({ status: z.literal("retry") }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type LaunchOutcome = z.infer<typeof outcomeSchema>;
export const launchRequestSchema = z.object({
  files: z.array(z.string()),
  mode: z.enum(["launch", "existing"]),
  reply: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === ""
    );
  }),
});
export type LaunchRequest = z.infer<typeof launchRequestSchema>;

/** Electron's singleton message has no application acknowledgement. A private,
 * kernel-assigned loopback endpoint keeps the invoking process alive until the
 * owner has handled its request. HTTP framing and connection cleanup are owned
 * by node:http: https://nodejs.org/api/http.html#class-httpserver.
 */
async function replyChannel() {
  const token = `/${randomUUID()}`;
  let resolve!: (outcome: LaunchOutcome) => void;
  const outcome = new Promise<LaunchOutcome>((accept) => {
    resolve = accept;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== token) {
      response.writeHead(404).end();
      return;
    }
    const parsed = outcomeSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      response.writeHead(400).end();
      resolve({
        status: "error",
        message: `Invalid launch response: ${parsed.error.message}`,
      });
      return;
    }
    response.writeHead(204).end();
    resolve(parsed.data);
  });
  await new Promise<void>((accept, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", accept);
  });
  server.on("error", (error) => resolve({ status: "error", message: error.message }));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Launch response server has no TCP address");
  const timer = setTimeout(
    () =>
      resolve({
        status: "error",
        message: "The application did not answer the launch request within 300 seconds",
      }),
    300_000,
  );
  return {
    url: `http://127.0.0.1:${address.port}${token}`,
    outcome,
    async close(): Promise<void> {
      clearTimeout(timer);
      server.closeIdleConnections();
      await new Promise<void>((accept, fail) =>
        server.close((error) => (error ? fail(error) : accept())),
      );
    },
  };
}

export async function replyToLaunch(request: LaunchRequest, outcome: LaunchOutcome): Promise<void> {
  const url = new URL(request.reply);
  for (const [key, value] of Object.entries(outcome)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 204)
    throw new Error(`Launch response was refused: HTTP ${response.status}`);
}

/** Re-election is allowed only on an explicit response from the owner after
 * cleanup and lock release. Errors and timeouts never imply permission to boot.
 */
export async function acquireLaunch(
  files: string[],
  mode: LaunchRequest["mode"],
): Promise<"primary" | "delivered"> {
  // A hand-off exists to open files in the running app. Without one, the
  // running app would answer "ready" for an open that did not happen.
  if (mode === "existing" && files.length === 0) {
    throw new Error("The request names no file to open");
  }
  for (;;) {
    const channel = await replyChannel();
    try {
      if (app.requestSingleInstanceLock({ files, mode, reply: channel.url })) {
        if (mode === "existing") throw new Error("No running Zettlr instance accepted the request");
        return "primary";
      }
      const outcome = await channel.outcome;
      switch (outcome.status) {
        case "ready":
          return "delivered";
        case "error":
          throw new Error(outcome.message);
        case "retry":
          break;
      }
    } finally {
      await channel.close();
    }
  }
}
