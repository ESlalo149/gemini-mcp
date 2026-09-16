let socket = null;
let pingInterval = null;
let reconnectTimer = null;
let actionQueue = Promise.resolve();
const allowedActions = new Set(["ask", "read_thread", "new_chat", "get_title", "debug_dom"]);

chrome.alarms.create("gemini-mcp-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "gemini-mcp-reconnect" && (!socket || socket.readyState > WebSocket.OPEN)) connect();
});

function connect() {
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    socket = new WebSocket("ws://127.0.0.1:8765");

    socket.onopen = () => {
        console.log("[Bridge SW] Conectado al servidor MCP local");

        // Heartbeat cada 20s para que Chrome no mate el Service Worker
        clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "ping" }));
            }
        }, 20000);
    };

    socket.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === "pong") return; // Respuesta al ping

            const { id, action, payload = {} } = data;
            if (typeof id !== "string" || !allowedActions.has(action) || !payload || typeof payload !== "object") return;

            const respond = (ok, result) => {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(
                        JSON.stringify(ok ? { id, ok: true, data: result } : { id, ok: false, error: result })
                    );
                }
            };

            actionQueue = actionQueue.then(async () => {
                const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
                const tab = tabs.find((t) => t.active) || tabs[0];
                if (!tab) return respond(false, "No hay pestaña de Gemini abierta.");
                await new Promise((resolve) => {
                    chrome.tabs.sendMessage(tab.id, { type: "GEMINI_MCP", action, payload }, (response) => {
                        if (chrome.runtime.lastError) {
                            respond(false, "Recarga la pestaña de gemini.google.com (" + chrome.runtime.lastError.message + ")");
                        } else if (response && response.ok) {
                            respond(true, response.data);
                        } else {
                            respond(false, (response && response.error) || "Sin respuesta de la pestaña.");
                        }
                        resolve();
                    });
                });
            }).catch((err) => respond(false, err.message));
        } catch (err) {
            console.error("[Bridge SW] Error procesando mensaje:", err);
        }
    };

    socket.onclose = () => {
        clearInterval(pingInterval);
        console.log("[Bridge SW] Conexión perdida. Reintentando en 3s...");
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 3000);
    };

    socket.onerror = () => {
        socket.close();
    };
}

connect();
