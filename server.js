const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { WebSocketServer } = require("ws");
const { z } = require("zod");
const fs = require("fs/promises");
const path = require("path");
const http = require("http");

const WSS_PORT = Number(process.env.GEMINI_WSS_PORT) || 8765;
const REQUEST_TIMEOUT = 120000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const BIND_RETRY_MS = 2000;
const BIND_MAX_RETRIES = 60;

let activeExtensionSocket = null;
const pendingRequests = new Map();

let isListening = false;
let bindRetries = 0;
let lastBindError = null;

const httpServer = http.createServer((req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required");
});

const wss = new WebSocketServer({ server: httpServer });

httpServer.on("listening", () => {
    isListening = true;
    bindRetries = 0;
    lastBindError = null;
    console.error(`[Puente] WebSocket escuchando en 127.0.0.1:${WSS_PORT}.`);
});

httpServer.on("error", (err) => {
    isListening = false;
    lastBindError = err.message;
    console.error(`[Puente] No se pudo enlazar 127.0.0.1:${WSS_PORT}: ${err.message}`);
    if (err.code === "EADDRINUSE" && bindRetries < BIND_MAX_RETRIES) {
        bindRetries++;
        console.error(`[Puente] Reintentando bind en ${BIND_RETRY_MS}ms (intento ${bindRetries}/${BIND_MAX_RETRIES})...`);
        setTimeout(() => {
            try {
                httpServer.close();
            } catch (closeErr) {
                console.error("[Puente] Error al cerrar el servidor antes del reintento:", closeErr.message);
            }
            httpServer.listen(WSS_PORT, "127.0.0.1");
        }, BIND_RETRY_MS);
    } else {
        console.error("[Puente] El transporte MCP sigue activo; use la tool bridge_status para ver el estado.");
    }
});

wss.on("connection", (ws) => {
    activeExtensionSocket = ws;
    console.error("[Puente] Extensión de Chrome conectada vía WebSocket.");

    ws.on("message", (raw) => {
        try {
            const data = JSON.parse(raw.toString());

            // Responder a los pings de la extensión
            if (data.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
                return;
            }

            // Resolver la respuesta que esperaba OpenCode
            if (data.id && pendingRequests.has(data.id)) {
                const { resolve } = pendingRequests.get(data.id);
                pendingRequests.delete(data.id);
                resolve(data);
            }
        } catch (err) {
            console.error("[Puente] Error al parsear mensaje:", err);
        }
    });

    ws.on("close", () => {
        if (activeExtensionSocket === ws) {
            activeExtensionSocket = null;
        }
        for (const { reject } of pendingRequests.values()) {
            reject(new Error("La extensión de Chrome se desconectó."));
        }
        pendingRequests.clear();
        console.error("[Puente] Extensión desconectada.");
    });
});

httpServer.listen(WSS_PORT, "127.0.0.1");

const server = new McpServer({
    name: "gemini-browser-bridge",
    version: "2.0.0",
});

/**
 * Envía una acción a la extensión y resuelve con el mensaje de respuesta.
 * @param {string} action
 * @param {object} [payload]
 */
function requestExtension(action, payload = {}) {
    return new Promise((resolve, reject) => {
        if (!activeExtensionSocket || activeExtensionSocket.readyState !== 1) {
            if (!isListening) {
                reject(new Error(`El puente no está escuchando en 127.0.0.1:${WSS_PORT}${lastBindError ? ` (último error: ${lastBindError})` : ""}.`));
                return;
            }
            reject(new Error("La extensión de Chrome no está conectada."));
            return;
        }

        const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new Error("Tiempo de espera agotado esperando a Gemini."));
        }, REQUEST_TIMEOUT);

        pendingRequests.set(requestId, {
            resolve: (message) => {
                clearTimeout(timer);
                resolve(message);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            },
        });

        activeExtensionSocket.send(JSON.stringify({ id: requestId, action, payload }));
    });
}

function describeResult(message) {
    if (!message || message.ok !== true) {
        const error = message?.error || "Sin respuesta de la extensión.";
        return { content: [{ type: "text", text: `Error: ${error}` }] };
    }
    const data = message.data;
    if (typeof data === "string") {
        return { content: [{ type: "text", text: data }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".html": "text/html",
    ".css": "text/css",
};

function mimeFor(filePath) {
    return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

server.tool(
    "ask_gemini",
    "Envía una consulta a la pestaña de Gemini y devuelve la respuesta generada.",
    {
        prompt: z.string().describe("La pregunta o texto para Gemini"),
    },
    async ({ prompt }) => {
        try {
            return describeResult(await requestExtension("ask", { prompt }));
        } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }] };
        }
    }
);

server.tool("read_thread", "Lee la conversación actual de la pestaña de Gemini y devuelve los turnos usuario/modelo en orden.", async () => {
    try {
        return describeResult(await requestExtension("read_thread"));
    } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
});

server.tool("new_chat", "Inicia una nueva conversación en la pestaña activa de Gemini.", async () => {
    try {
        return describeResult(await requestExtension("new_chat"));
    } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
});

server.tool("get_title", "Devuelve el título de la conversación actual de Gemini.", async () => {
    try {
        return describeResult(await requestExtension("get_title"));
    } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
});

server.tool("debug_dom", "Devuelve metadatos sanitizados del DOM de Gemini para diagnosticar selectores, sin incluir el contenido de la conversación.", async () => {
    try {
        return describeResult(await requestExtension("debug_dom"));
    } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
});

server.tool(
    "send_file",
    "Envía un archivo local como adjunto a Gemini junto con un prompt, y devuelve la respuesta.",
    {
        prompt: z.string().describe("La pregunta o texto para Gemini"),
        path: z.string().describe("Ruta absoluta del archivo local a adjuntar"),
    },
    async ({ prompt, path: filePath }) => {
        try {
            let stat;
            try {
                stat = await fs.stat(filePath);
            } catch {
                return { content: [{ type: "text", text: `Error: No se encontró el archivo: ${filePath}` }] };
            }
            if (!stat.isFile()) {
                return { content: [{ type: "text", text: "Error: La ruta no es un archivo." }] };
            }
            if (stat.size > MAX_ATTACHMENT_BYTES) {
                return { content: [{ type: "text", text: "Error: El archivo excede el límite de 10 MB." }] };
            }
            const data = await fs.readFile(filePath);
            const file = {
                filename: path.basename(filePath),
                mime: mimeFor(filePath),
                data: data.toString("base64"),
            };
            return describeResult(await requestExtension("attach_ask", { prompt, file }));
        } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }] };
        }
    }
);

server.tool("bridge_status", "Reporta el estado del puente: si el WebSocket está escuchando, si la extensión está conectada y el puerto.", async () => {
    const status = {
        listening: isListening,
        port: WSS_PORT,
        extensionConnected: Boolean(activeExtensionSocket && activeExtensionSocket.readyState === 1),
        bindRetries,
        lastBindError,
    };
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[Puente] Servidor MCP corriendo sobre stdio.");
}

main().catch((err) => console.error(err));
