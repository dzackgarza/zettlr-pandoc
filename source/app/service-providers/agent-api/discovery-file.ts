/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The endpoint-discovery file of the Agent API
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Agent API writes this file into userData once its
 *                  listener is bound. The first line is the bound port, the
 *                  second line the id of the instance that `/v1/ping`
 *                  answers: the shape of Chromium's DevToolsActivePort, whose
 *                  second line names the browser target. A client reads the
 *                  port, and takes the listener on it for this instance only
 *                  when its ping names the same id. A killed instance leaves
 *                  its file, and another instance can bind its port.
 *
 * END HEADER
 */

/** The name of the file in the user-data directory. */
export const AGENT_API_PORT_FILE = "agent-api.port";

/** What the file names: the listener and the instance behind it. */
export interface AgentApiDiscovery {
  port: number;
  instanceId: string;
}

/** A file whose text is not a port line and an instance line. */
export class MalformedAgentApiDiscoveryError extends Error {
  constructor(text: string) {
    super(`The Agent API discovery file holds no port and instance: ${JSON.stringify(text)}`);
    this.name = "MalformedAgentApiDiscoveryError";
  }
}

export function formatAgentApiDiscovery(discovery: AgentApiDiscovery): string {
  return `${discovery.port}\n${discovery.instanceId}\n`;
}

export function parseAgentApiDiscovery(text: string): AgentApiDiscovery {
  const lines = text.split("\n");
  if (lines.length !== 3 || lines[2] !== "" || lines[1] === "") {
    throw new MalformedAgentApiDiscoveryError(text);
  }
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== lines[0]) {
    throw new MalformedAgentApiDiscoveryError(text);
  }
  return { port, instanceId: lines[1] };
}
