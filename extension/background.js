let socket = null;
let pingInterval = null;

function connect() {
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
            if (!id || !action) return;

            const respond = (ok, result) => {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(
                        JSON.stringify(ok ? { id, ok: true, data: result } : { id, ok: false, error: result })
                    );
                }
            };

            // Buscar pestaña de Gemini (da prioridad a la activa)
            const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
            const tab = tabs.find((t) => t.active) || tabs[0];

            if (!tab) {
                respond(false, "No hay pestaña de Gemini abierta.");
                return;
            }

            // Reenviar la acción a content.js
            chrome.tabs.sendMessage(tab.id, { type: "GEMINI_MCP", action, payload }, (response) => {
                if (chrome.runtime.lastError) {
                    respond(false, "Recarga la pestaña de gemini.google.com (" + chrome.runtime.lastError.message + ")");
                    return;
                }
                if (response && response.ok) {
                    respond(true, response.data);
                } else {
                    respond(false, (response && response.error) || "Sin respuesta de la pestaña.");
                }
            });
        } catch (err) {
            console.error("[Bridge SW] Error procesando mensaje:", err);
        }
    };

    socket.onclose = () => {
        clearInterval(pingInterval);
        console.log("[Bridge SW] Conexión perdida. Reintentando en 3s...");
        setTimeout(connect, 3000);
    };

    socket.onerror = () => {
        socket.close();
    };
}

connect();