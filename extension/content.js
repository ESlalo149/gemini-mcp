chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type !== "GEMINI_MCP") return;

    handleAction(request.action, request.payload || {})
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true; // Mantiene el canal abierto para respuesta asíncrona
});

async function handleAction(action, payload) {
    switch (action) {
        case "ask":
            return ask(payload.prompt);
        case "attach_ask":
            return attachAndAsk(payload.prompt, payload.file);
        case "read_thread":
            return readThread();
        case "new_chat":
            return startNewChat();
        case "get_title":
            return getTitle();
        default:
            throw new Error("Acción desconocida: " + action);
    }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function getInputElement() {
    return document.querySelector('div[contenteditable="true"]') || document.querySelector("textarea");
}

function fillPrompt(promptText) {
    const inputEl = getInputElement();
    if (!inputEl) throw new Error("No se encontró la caja de entrada de Gemini.");
    inputEl.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, promptText);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickSend() {
    const sendBtn = document.querySelector(
        'button[aria-label*="Enviar"], button[aria-label*="Send"], button.send-button'
    );
    if (sendBtn) {
        sendBtn.click();
        return;
    }
    const inputEl = getInputElement();
    if (inputEl) {
        inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    }
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------

function ask(promptText) {
    fillPrompt(promptText);
    return new Promise((resolve) => setTimeout(resolve, 400)).then(() => {
        clickSend();
        return waitForResponse();
    });
}

function waitForResponse() {
    return new Promise((resolve) => {
        let lastText = "";
        let stableCount = 0;
        let totalMs = 0;

        const interval = setInterval(() => {
            totalMs += 500;

            const responses = document.querySelectorAll(
                ".model-response-text, message-content, [data-test-id='model-response']"
            );
            const lastResponse = responses[responses.length - 1];

            if (lastResponse) {
                const currentText = lastResponse.innerText.trim();

                // Verifica si el texto dejó de cambiar (indicador de que terminó la generación)
                if (currentText.length > 0 && currentText === lastText) {
                    stableCount++;
                    if (stableCount >= 5) { // ~2.5 segundos estable
                        clearInterval(interval);
                        resolve(currentText);
                    }
                } else {
                    stableCount = 0;
                    lastText = currentText;
                }
            }

            if (totalMs >= 120000) {
                clearInterval(interval);
                resolve(lastText.length > 0 ? lastText : "Error: Tiempo de espera agotado esperando la respuesta.");
            }
        }, 500);
    });
}

function readThread() {
    const turns = [];
    const containers = document.querySelectorAll(".conversation-container");

    if (containers.length > 0) {
        for (const container of containers) {
            const query = container.querySelector(".user-query");
            if (query && query.innerText.trim()) {
                turns.push({ role: "user", text: query.innerText.trim() });
            }
            const response =
                container.querySelector(".model-response-text") || container.querySelector(".model-response");
            if (response && response.innerText.trim()) {
                turns.push({ role: "model", text: response.innerText.trim() });
            }
        }
    } else {
        const nodes = document.querySelectorAll(".user-query, .model-response-text");
        for (const node of nodes) {
            turns.push({
                role: node.matches(".user-query") ? "user" : "model",
                text: node.innerText.trim(),
            });
        }
    }

    return turns;
}

function startNewChat() {
    const buttons = Array.from(document.querySelectorAll('[aria-label="New chat"]'));
    const button = buttons[buttons.length - 1];
    if (!button) throw new Error("No se encontró el botón 'New chat'.");
    button.click();
    return "Nueva conversación iniciada.";
}

function getTitle() {
    for (const el of document.querySelectorAll('h1, [data-test-id="chat-title"], .chat-title')) {
        const text = (el.innerText || el.textContent || "").trim();
        if (text && text !== "Gemini") return text;
    }

    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) {
        const text = og.content.trim();
        if (text && text !== "Gemini") return text;
    }

    const active = Array.from(document.querySelectorAll('[data-test-id="conversation"]')).find(
        (el) => el.getAttribute("aria-current") === "true" || el.getAttribute("aria-selected") === "true"
    );
    if (active) {
        const text = (active.innerText || "").trim();
        if (text) return text.split("\n")[0];
    }

    return "Untitled";
}

// ---------------------------------------------------------------------------
// Adjuntos
// ---------------------------------------------------------------------------

function base64ToFile(file) {
    const binary = atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], file.filename, { type: file.mime || "application/octet-stream" });
}

function attachFile(file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(base64ToFile(file));

    const inputArea = document.querySelector(".initial-input-area") || document.body;

    // Opción 1: simular drag & drop sobre el área de entrada (Gemini lo soporta).
    for (const type of ["dragover", "drop"]) {
        inputArea.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }

    // Opción 2: inyectar un input file temporal y emitir change.
    let input = document.querySelector('input[type="file"]');
    if (!input) {
        input = document.createElement("input");
        input.type = "file";
        input.style.position = "fixed";
        input.style.left = "-9999px";
        input.style.opacity = "0";
        document.body.appendChild(input);
    }
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

function waitForAttachment(maxMs) {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
            const indicators = document.querySelectorAll(
                '[data-test-id="uploaded-file"], [data-test-id="uploaded-img"], .attachment-container'
            );
            if (indicators.length > 0) {
                clearInterval(interval);
                resolve();
            } else if (Date.now() - startTime > maxMs) {
                clearInterval(interval);
                reject(new Error("El adjunto no apareció en la pestaña de Gemini."));
            }
        }, 500);
    });
}

async function attachAndAsk(promptText, file) {
    if (!file || !file.data) throw new Error("No se recibió el archivo.");
    attachFile(file);
    await waitForAttachment(15000);
    return ask(promptText);
}