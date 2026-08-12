/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AgentEventDelivery
 * CVM-Role:        Service
 * Maintainer:     D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Owns the Server-Sent Events transport for the Agent API.
 *                  The HTTP adapter supplies event enrichment; this module
 *                  owns replay, clients, heartbeats, and wire envelopes.
 *
 * END HEADER
 */

import type { AgentEvent } from "@dts/common/agent-api";
import type http from "http";

export const EVENT_REPLAY_BUFFER_SIZE = 100;
const HEARTBEAT_MS = 15000;

type BufferedAgentEvent = AgentEvent & { id: string };

export default class AgentEventDelivery {
  private readonly clients = new Set<http.ServerResponse>();
  private readonly replayBuffer: BufferedAgentEvent[] = [];
  private sequence = 1;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly enrich: (event: AgentEvent) => AgentEvent) {}

  public subscribe(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const afterEventId = this.parseLastEventId(req.headers["last-event-id"]);
    const start = this.replayStartIndex(afterEventId);
    if (start < this.replayBuffer.length) {
      for (const event of this.replayBuffer.slice(start)) {
        this.writeEnvelope(res, event);
      }
    } else {
      res.write(": connected\n\n");
    }
    this.clients.add(res);
    this.startHeartbeat();
    res.on("close", () => {
      this.clients.delete(res);
      if (this.clients.size === 0) {
        this.stopHeartbeat();
      }
    });
  }

  public broadcast(event: AgentEvent): void {
    const enriched = this.enrich(event);
    const stamped: BufferedAgentEvent = { ...enriched, id: `${this.sequence}` };
    this.sequence += 1;
    this.replayBuffer.push(stamped);
    if (this.replayBuffer.length > EVENT_REPLAY_BUFFER_SIZE) {
      this.replayBuffer.shift();
    }
    for (const client of this.clients) {
      if (!client.writableEnded) {
        this.writeEnvelope(client, stamped);
      }
    }
  }

  public shutdown(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      return;
    }
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (!client.writableEnded) {
          client.write(": heartbeat\n\n");
        }
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === undefined) {
      return;
    }
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private parseLastEventId(header: string | string[] | undefined): number | undefined {
    if (header === undefined) {
      return undefined;
    }
    const candidate = Array.isArray(header) ? header[0] : header;
    const parsed = Number.parseInt(candidate, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  }

  private replayStartIndex(afterEventId: number | undefined): number {
    if (afterEventId === undefined || this.replayBuffer.length === 0) {
      return 0;
    }
    for (let index = 0; index < this.replayBuffer.length; index += 1) {
      if (Number.parseInt(this.replayBuffer[index].id, 10) > afterEventId) {
        return index;
      }
    }
    return this.replayBuffer.length;
  }

  private writeEnvelope(res: http.ServerResponse, event: BufferedAgentEvent): void {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.event}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
