import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ScriptCard } from "../../../server/src/script-types";
import type { BridgeRequest as ServerRequest } from "../../../server/src/types";

type PluginStatus = {
  fileName: string;
  selectionCount: number;
};
const getSafeLocalStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.warn("localStorage is not accessible:", e);
    return null;
  }
};

const setSafeLocalStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn("localStorage is not accessible:", e);
  }
};

export default function App() {
  const [capability, setCapability] = useState<{ supported: boolean; reason: string | null; editorType: string; mode: string } | null>(null);
  const [cards, setCards] = useState<ScriptCard[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<PluginStatus>({
    fileName: "Unknown file",
    selectionCount: 0
  });
  const [useWss, setUseWss] = useState<boolean>(() => {
    return getSafeLocalStorage("figma-bridge-use-wss") === "true";
  });
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  const statusLabel = useMemo(
    () => (connected ? "Connected" : "Disconnected"),
    [connected]
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "script-capability") {
        setCapability(msg);
        return;
      }

      if (msg.type === "script-card") {
        const card = msg.card as ScriptCard;
        setCards(previous => [...previous.filter(item => item.requestId !== card.requestId), card].slice(-25));
        setDeciding(null);
        return;
      }

      if (msg.sessionId && msg.sessionId !== sessionRef.current) return;

      if (msg.type === "plugin-status") {
        setStatus(msg.payload);
        return;
      }

      if (!("requestId" in msg)) {
        return;
      }

      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        return;
      }
      socketRef.current.send(JSON.stringify(msg));
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      if (socketRef.current) {
        socketRef.current.close();
      }

      const wsUrl = useWss ? "wss://localhost:1994/ws" : "ws://localhost:1994/ws";
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        if (stopped || socketRef.current !== ws) return;
        sessionRef.current = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
        parent.postMessage({ pluginMessage: { type: "script-transport", sessionId: sessionRef.current } }, "*");
        setConnected(true);
        parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");
      };

      ws.onclose = () => {
        if (stopped || socketRef.current !== ws) return;
        sessionRef.current = null;
        parent.postMessage({ pluginMessage: { type: "script-transport", sessionId: null } }, "*");
        setConnected(false);
        if (reconnectTimer.current === null) {
          reconnectTimer.current = window.setTimeout(() => {
            reconnectTimer.current = null;
            connect();
          }, 1500);
        }
      };

      ws.onerror = () => {
        if (stopped || socketRef.current !== ws) return;
        setConnected(false);
        ws.close();
      };

      ws.onmessage = (event) => {
        if (stopped || socketRef.current !== ws) return;
        try {
          const payload = JSON.parse(event.data) as ServerRequest;
          parent.postMessage({ pluginMessage: { type: "server-request", payload, sessionId: sessionRef.current } }, "*");
        } catch (error) { console.error("Invalid bridge request", error); }
      };
    };

    connect();

    return () => {
      stopped = true;
      sessionRef.current = null;
      parent.postMessage({ pluginMessage: { type: "script-transport", sessionId: null } }, "*");
      if (reconnectTimer.current !== null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, [useWss]);

  const decide = (card: ScriptCard, approve: boolean) => {
    if (!connected || sessionRef.current !== card.sessionId || deciding) return;
    setDeciding(card.requestId);
    parent.postMessage({ pluginMessage: {
      type: "script-decision", requestId: card.requestId, token: card.token,
      sessionId: card.sessionId, code: card.code, approve,
    } }, "*");
  };

  return (
    <div className="container">
      <div className="status">
        <div>WebSocket</div>
        <span
          className={`status-badge ${
            connected ? "connected" : "disconnected"
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <div className="settings">
        <label className="toggle-container">
          <input
            type="checkbox"
            checked={useWss}
            onChange={(e) => {
              const checked = e.target.checked;
              setUseWss(checked);
              setSafeLocalStorage("figma-bridge-use-wss", String(checked));
            }}
          />
          <span className="toggle-label">Use Secure Connection (WSS)</span>
        </label>
      </div>

      <div className="meta">File: {status.fileName}</div>
      <div className="meta">Selection: {status.selectionCount} node(s)</div>
      {capability && <div className="meta">JavaScript: {capability.supported ? "готов к подтверждаемым запускам" : "недоступен"} ({capability.editorType}/{capability.mode}){capability.reason ? ` — ${capability.reason}` : ""}</div>}
      {cards.map(card => (
        <section className="script-card" key={card.requestId}>
          <p>{card.description}</p>
          <div className="meta">Запрос: {card.requestId}</div>
          <details>
            <summary>JavaScript — показать код</summary>
            <pre>{card.code}</pre>
          </details>
          {card.phase === "approval" && (
            <div className="script-actions">
              <button disabled={!connected || deciding === card.requestId || sessionRef.current !== card.sessionId} onClick={() => decide(card, true)}>Запустить</button>
              <button disabled={!connected || deciding === card.requestId || sessionRef.current !== card.sessionId} onClick={() => decide(card, false)}>Отклонить</button>
            </div>
          )}
          {card.phase === "running" && <p role="status">Выполняется… При потере связи изменения могут продолжиться.</p>}
          {card.outcome && <div role="status">
            <p>Статус: {card.outcome.status}</p>
            {card.outcome.error && <pre>{card.outcome.error.message}{card.outcome.error.stack ? `\n${card.outcome.error.stack}` : ""}</pre>}
            {card.outcome.status === "success" && <pre>{JSON.stringify(card.outcome.result, null, 2)}</pre>}
          </div>}
          {card.outcome && ["success", "error", "timeout"].includes(card.outcome.status) && <>
            <button disabled aria-describedby={`undo-${card.requestId}`}>Отменить изменения</button>
            <p className="meta" id={`undo-${card.requestId}`}>Безопасный откат недоступен: Figma не позволяет проверить вершину общей истории. Кнопка заблокирована, чтобы не отменить ручные правки или другой запуск. Проверьте документ и используйте обычный Undo при необходимости. Ошибка может оставить частичные изменения.</p>
          </>}
        </section>
      ))}
    </div>
  );
}
