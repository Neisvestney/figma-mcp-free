import type { BridgeResponse, RPCRequest, RPCResponse } from "./types.js";
import http from "node:http";
import https from "node:https";

/**
 * Follower proxies MCP tool calls to the leader via HTTP /rpc.
 */
export class Follower {
  constructor(private leaderUrl: string) {}

  send(
    requestType: string,
    nodeIds?: string[]
  ): Promise<BridgeResponse> {
    return this.sendWithParams(requestType, nodeIds);
  }

  async sendWithParams(
    requestType: string,
    nodeIds?: string[],
    params?: Record<string, unknown>
  ): Promise<BridgeResponse> {
    const rpcReq: RPCRequest = { tool: requestType };
    if (nodeIds && nodeIds.length > 0) rpcReq.nodeIds = nodeIds;
    if (params && Object.keys(params).length > 0) rpcReq.params = params;

    const response = requestType === "request_script_execution" ? null : await fetch(`${this.leaderUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcReq),
      signal: AbortSignal.timeout(35_000),
    });

    if (response && !response.ok) {
      throw new Error(`Leader returned status ${response.status}`);
    }

    const rpcResp = response ? (await response.json()) as RPCResponse : await this.sendScript(rpcReq);

    if (rpcResp.error) {
      throw new Error(rpcResp.error);
    }

    return {
      type: requestType,
      requestId: "",
      data: rpcResp.data,
    };
  }

  private sendScript(rpcReq: RPCRequest): Promise<RPCResponse> {
    // Native HTTP has no fetch/undici headers or body timeout while approval is pending.
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.leaderUrl}/rpc`);
      const request = (url.protocol === "https:" ? https : http).request(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, timeout: 0,
      }, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => {
          body += chunk;
          if (body.length > 4_000_000) response.destroy(new Error("Leader response too large"));
        });
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Leader connection lost; execution state unknown")));
        response.on("end", () => {
          try {
            if (response.statusCode !== 200) throw new Error(`Leader returned status ${response.statusCode}`);
            resolve(JSON.parse(body) as RPCResponse);
          } catch (error) { reject(error); }
        });
      });
      request.on("error", reject);
      request.end(JSON.stringify(rpcReq));
    });
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.leaderUrl}/ping`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
