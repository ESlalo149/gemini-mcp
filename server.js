const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { WebSocketServer } = require("ws");
const { z } = require("zod");
const http = require("http");

const WSS_PORT = Number(process.env.GEMINI_WSS_PORT) || 8765;
const REQUEST_TIMEOUT = 120000;
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
            if (typeof data.id === "string" && typeof data.ok === "boolean" && pendingRequests.has(data.id)) {
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
            reject(new Error("La extensión de Chrome no está conectada (extensión desconectada)."));
            return;
        }

        const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new Error(`Tiempo de espera agotado esperando a Gemini (DOM incompatible o generación detenida; acción: ${action}).`));
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

function structuredPrompt(prompt, schema, requestId) {
    return [
        "Responde en modo estructurado. Mantén cualquier explicación breve fuera del bloque.",
        "Dentro de <bridge_payload> escribe únicamente JSON válido, sin markdown ni fences.",
        `El JSON debe cumplir este schema descriptivo: ${JSON.stringify(schema || { type: "object" })}`,
        `Usa exactamente este requestId: ${requestId}`,
        "Formato obligatorio: <bridge_payload>{\"v\":1,\"requestId\":\"...\",\"status\":\"success\",\"mode\":\"json\",\"payload\":{...}}</bridge_payload>",
        "Si no puedes completar la tarea, usa status=error y payload=null.",
        "Solicitud:",
        prompt,
    ].join("\n");
}

function validatePayload(payload, schema) {
    if (!schema || !schema.properties) return null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "payload debe ser un objeto.";
    for (const field of schema.required || []) {
        if (!(field in payload)) return `Falta el campo requerido: ${field}`;
    }
    for (const [field, definition] of Object.entries(schema.properties)) {
        if (!(field in payload) || !definition?.type) continue;
        const value = payload[field];
        const valid = definition.type === "array" ? Array.isArray(value) :
            definition.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) :
            typeof value === definition.type;
        if (!valid) return `Tipo inválido para ${field}: se esperaba ${definition.type}.`;
    }
    return null;
}

function parseStructuredResponse(text, expectedRequestId, schema) {
    const match = String(text || "").match(/<bridge_payload>\s*([\s\S]*?)\s*<\/bridge_payload>/i);
    if (!match) {
        return { v: 1, requestId: expectedRequestId, status: "partial", mode: "text", payload: { raw_text: String(text || "") }, error: { code: "MISSING_PAYLOAD", retryable: true } };
    }
    try {
        const value = JSON.parse(match[1].replace(/^```json\s*|```$/gi, "").trim());
        if (!value || value.v !== 1 || value.requestId !== expectedRequestId || !["success", "error", "partial"].includes(value.status) || !["json", "error"].includes(value.mode)) {
            throw new Error("Envelope incompleto o incompatible.");
        }
        const payloadError = value.status === "success" ? validatePayload(value.payload, schema) : null;
        if (payloadError) throw new Error(payloadError);
        return value;
    } catch (error) {
        return { v: 1, requestId: expectedRequestId, status: "partial", mode: "text", payload: { raw_text: String(text || "") }, error: { code: "INVALID_PAYLOAD", message: error.message, retryable: true } };
    }
}

function structuredError(requestId, code, message, retryable = true) {
    return {
        v: 1,
        requestId,
        status: "error",
        mode: "error",
        payload: null,
        error: { code, message, retryable },
    };
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

server.tool(
    "ask_gemini_json",
    "Envía una consulta estructurada a Gemini y devuelve un envelope JSON validado; degrada a texto si Gemini no produce un payload válido.",
    {
        prompt: z.string().describe("La solicitud para Gemini"),
        schema: z.record(z.any()).optional().describe("Schema descriptivo esperado para payload"),
    },
    async ({ prompt, schema }) => {
        const requestId = `json_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
            const message = await requestExtension("ask", { prompt: structuredPrompt(prompt, schema, requestId) });
            if (!message || message.ok !== true) {
                return { content: [{ type: "text", text: JSON.stringify(structuredError(requestId, "EXTENSION_ERROR", message?.error || "Sin respuesta de la extensión."), null, 2) }] };
            }
            return { content: [{ type: "text", text: JSON.stringify(parseStructuredResponse(message.data, requestId, schema), null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: JSON.stringify(structuredError(undefined, "BRIDGE_ERROR", error.message), null, 2) }] };
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
