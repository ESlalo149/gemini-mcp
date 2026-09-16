# Gemini MCP Bridge

Puente entre la **pestaña de [Gemini](https://gemini.google.com)** y **opencode**, usando una extensión de Chrome (MV3) y un servidor MCP local. Permite invocar a Gemini como *tools* desde el agente, con tu sesión autenticada y sin salir del terminal.

> Estado actual: **operativo para las tools de conversación y diagnóstico**. La subida de archivos locales está deliberadamente fuera de alcance.

---

## Arquitectura

```
                        MCP (stdio)                     WebSocket :8765                    chrome.tabs
 opencode (Cliente MCP) ──────▶ server.js ──────▶ background.js (SW) ──────▶ content.js ──────▶ Gemini (DOM)
        (tools)                  McpServer             extensión MV3          scripting UI
                                 requestExtension (promise <-> id)           respuestas
```

| Componente | Archivo | Función |
|---|---|---|
| Servidor MCP | `server.js` | Registra las tools, transporta por stdio, abre WS en `127.0.0.1:8765`, hace *request/response* con la extensión |
| Config | `opencode.json` (`mcp.gemini-browser`) | Lanza `node server.js` como MCP local al arrancar opencode |
| Service Worker | `extension/background.js` | Conecta el WS, heartbeat (ping/20s), reenvía acciones a `content.js` |
| Content script | `extension/content.js` | Manipula el DOM de Gemini: escribir prompt, enviar, leer hilo, título, adjuntos |
| Manifiesto | `extension/manifest.json` | MV3, `host_permissions` para `https://gemini.google.com/*` |

**Flujo de una llamada** (`ask_gemini` por ejemplo):

1. opencode llama a la tool `ask_gemini` por MCP/stdio.
2. `server.js` genera un `requestId`, lo guarda en `pendingRequests` y emite por el WS `{ id, action: "ask", payload }`.
3. `background.js` localiza la pestaña de Gemini (prioriza la activa) y envía `GEMINI_MCP` a `content.js`.
4. `content.js` inyecta el prompt, pulsa enviar y espera la respuesta.
5. La respuesta viaja de vuelta por el mismo canal y `server.js` resuelve la promesa original.

---

## Requisitos

- Node.js (probado con v24)
- Chrome con las extensiones MV3 habilitadas
- opencode

**Dependencias npm** (`package.json`): `@modelcontextprotocol/sdk`, `ws`. `zod` se usa en `server.js` y llega como dependencia transitiva.

---

## Instalación y configuración

```powershell
cd C:\Users\llozano\Documents\typescript-projects\gemini-mcp
npm install
```

**1. Configurar opencode** (`~/.config/opencode/opencode.json`):

```json
"gemini-browser": {
  "type": "local",
  "command": ["node", "C:\\Users\\llozano\\Documents\\typescript-projects\\gemini-mcp\\server.js"],
  "enabled": true,
  "timeout": 120000
}
```

**2. Cargar la extensión** en `chrome://extensions` → **Modo desarrollador** → **Cargar descomprimida** → seleccionar `extension/`.

**3. Aplicar los cambios de la extensión** (tras editar `content.js` / `background.js`): pulsar el botón de **recargar** (⟳) de la extensión y dar **F5** en la pestaña de `gemini.google.com` para reinyectar el content script.

> Las pestañas abiertas antes de cargar/recargar la extensión **no** reciben el content script; hay que recargarlas para que `background.js` pueda "comunicarse" con ellas.

---

## Tools disponibles

| Tool | Parámetros | Descripción | Estado |
|---|---|---|---|
| `ask_gemini` | `prompt` | Envía una consulta y espera la respuesta | ✅ |
| `read_thread` | — | Lee la conversación actual (turnos visibles) | ✅ |
| `new_chat` | — | Inicia una conversación nueva | ✅ |
| `get_title` | — | Devuelve el título de la conversación | ✅ |
| `send_file` | — | No disponible: subida local fuera de alcance | Retirado |
| `bridge_status` | — | Estado del puente: `listening`, `extensionConnected`, `bindRetries`, `lastBindError` | ✅ |
| `debug_dom` | — | Metadatos sanitizados del DOM para diagnóstico | ✅ |

> `send_file` fue retirado: el puente no lee rutas locales ni transmite archivos a Gemini.

---

## Uso de ejemplo

```text
# Puente sano
bridge_status            → { listening: true, extensionConnected: true, bindRetries: 0 }

# Conversación con memoria
new_chat                 → cobra una conversación limpia
ask_gemini("Escribe una función chunk<T>(array, size)...")
ask_gemini("¿Qué hacía la función que escribiste justo antes?")

# Lectura y título
read_thread              → turnos de la conversación
get_title                → título del hilo
```

---

## Bitácora de bugs (incidentes)

| # | Síntoma | Causa raíz | Solución aplicada | Estado |
|---|---|---|---|---|
| 1 | El WebSocket `:8765` nunca escuchaba; tools registradas pero todas fallaban con "extensión no conectada"; Chrome en `SYN_SENT` para siempre | `wss.on("error")` **capturaba y descartaba el `EADDRINUSE`** silenciosamente; el server viejo tenía el puerto, el nuevo abortaba el bind pero seguía vivo en stdio | `server.js` reescrito: `http.createServer` + `WebSocketServer({ server })`, bind explícito a `127.0.0.1:8765`, **reintento con backoff** ante `EADDRINUSE` (60 × 2 s), erros distinguen "no escucha" de "extensión no conectada", tool `bridge_status` | ✅ Resuelto |
| 2 | Las tools de `gemini-browser` no aparecían en la sesión de opencode | La sesión arrancó cuando el MCP estaba en estado `failed`; el registro quedó sin ejecutarse | Reiniciar opencode con el puente sano desde el arranque | ✅ Resuelto |
| 3 | `send_file` falla con `-32602: Invalid arguments` | Desajuste de nombre de parámetro: el servidor anuncia `path`, opencode expone `filePath` | Usar `path` en la llamada (workaround) | ⚠️ Workaround |
| 4 | `send_file` no deja el adjunto en la UI de Gemini: tras 15 s aborta con "El adjunto no apareció" | `attachFile` (drag&drop + input file falso) no es aceptado por Gemini, o los selectores de `waitForAttachment` (`[data-test-id="uploaded-file"]`, `.attachment-container`) no coinciden con el DOM actual | Sin arreglo (requiere auditoría del DOM real con `chrome-devtools`, puerto `9222`) | ❌ Abierto |
| 5 | `read_thread` omitía los turnos **usuario** | Los selectores antiguos no coincidían con el DOM actual de Gemini | Marcador `Copy prompt`, limpieza semántica y orden por posición DOM | ✅ Resuelto |
| 6 | `ask_gemini` podía devolver una **respuesta obsoleta** | La respuesta anterior seguía visible durante la generación nueva | Snapshot de nodos, bloque nuevo, estabilidad y estado del botón Stop | ✅ Resuelto |

---

## Diagnóstico rápido

| Síntoma | Causa probable | Solución |
|---|---|---|
| `bridge_status` → `listening: false` | Puerto `8765` ocupado por otra instancia en el arranque | `netstat -ano \| findstr 8765`; matar la instancia vieja y reiniciar opencode. El retry auto-recupera hasta 120 s |
| `bridge_status` → `extensionConnected: false` | Service Worker de Chrome dormido o extensión no recargada | Recargar la extensión en `chrome://extensions` o reabrir una pestaña de Gemini |
| Error de tool: `Recarga la pestaña de gemini.google.com` | Content script no inyectado (pestaña anterior a la carga/recarga) | **F5** en la pestaña de Gemini |
| Tools `gemini-browser.*` ausentes del toolset | La sesión de opencode arrancó con el MCP en `failed` | Reiniciar opencode |
| `ask_gemini` devuelve la respuesta anterior | Race de `waitForResponse` (bug n.º 6) | Reintentar o leer el hilo con `read_thread` |

## Modo estructurado

`ask_gemini` conserva el modo texto para conversación, diseño y debugging. Para respuestas que otra herramienta deba consumir, usa `ask_gemini_json`:

```json
{
  "prompt": "Revisa este diseño y enumera sus riesgos",
  "schema": {
    "type": "object",
    "required": ["risks", "recommendation"]
  }
}
```

La herramienta solicita un bloque `<bridge_payload>` versionado, con `requestId` para correlación, y devuelve JSON. Valida el envelope y los campos `required`/tipos básicos declarados en `schema`. Si Gemini responde con prosa, markdown o JSON inválido, devuelve `status: "partial"`, el texto crudo y un código de diagnóstico en lugar de romper el flujo. No intenta reparar JSON corrupto automáticamente.

## Diagnóstico seguro del DOM

Usa `debug_dom` antes de cambiar selectores. Devuelve únicamente la ruta, título, conteos de selectores y nombres accesibles de botones. No devuelve HTML completo, cookies, tokens ni el contenido de la conversación.

1. Reproduce el fallo en una pestaña de Gemini.
2. Ejecuta `debug_dom` y guarda la salida con fecha.
3. Compara los conteos y nombres accesibles con la matriz de selectores.
4. Si necesitas inspección manual, copia solo etiquetas, `role`, `aria-*`, `data-*` y clases relevantes; elimina nombres, URLs, IDs, prompts y tokens.
5. Prueba primero un fallback semántico y valida con `ask_gemini`, `read_thread` y `debug_dom`.

### Matriz de selectores

| Elemento | Selector principal | Fallback | Evidencia | Última verificación |
|---|---|---|---|---|
| Entrada | `[aria-label="Enter a prompt for Gemini"]` | `[contenteditable="true"][role="textbox"]`, `rich-textarea`, `textarea` | `debug_dom` y round-trip real | 2026-09-16 |
| Envío | Botón `Send`/`Enviar` | Evento `Enter` sobre la entrada | round-trip real; Gemini mostró 0 botones Send | 2026-09-16 |
| Respuesta | `model-response`, `.model-response-text`, `message-content` | `[data-response-id]`, `.response-content` | `debug_dom` y 20 prompts | 2026-09-16 |
| Usuario | Marcador `Copy prompt` | `[data-test-id='user-query']`, `.user-query` | `read_thread` real | 2026-09-16 |
| Adjuntos | No usado | No usado | fuera de alcance | 2026-09-16 |

## Límites y mantenimiento

- La interfaz y el DOM de Google Gemini pueden cambiar sin aviso; los selectores no son un contrato público.
- La pestaña debe tener una sesión válida de Gemini; login, captcha, cuota agotada y rate limits dependen de la cuenta.
- El puente usa la sesión visible del usuario y no debe utilizarse para extraer contenido privado innecesario.
- El WebSocket solo enlaza a `127.0.0.1`; no expone el puente a la red local.
- El proyecto no lee rutas locales ni transmite archivos.
- El uso debe respetar los términos de Google, las políticas de la cuenta y las condiciones de opencode.

### Registro de cambios del DOM

Para cada cambio registrar: fecha, síntoma, selector anterior, selector nuevo o fallback, salida de `debug_dom`, prueba ejecutada y resultado. No adjuntar HTML completo ni datos privados.

---

## Endurecimiento aplicado (`server.js`)

- Bind limitado a `127.0.0.1:8765` (no expone interfaz de red).
- Reintento de bind con backoff ante `EADDRINUSE` (evita el fallo silencioso del incidente n.º 1).
- `bridge_status` para diagnóstico en vivo de `listening` / `extensionConnected`.
- Mensajes de error precisos, distinguiendo fallo de bind y extensión ausente.

---

## Demo forense documentada

Como ejemplo de uso agéntico, se validó un ciclo completo "detective + despliegue" usando únicamente el puente:

1. **Siembra** de un servidor HTTP "sospechoso" en `127.0.0.1:9999` (header `x-crypto-token: 1`, script en `Temp`).
2. **Expediente** con evidencia real (`netstat`, `Get-CimInstance`, probe HTTP).
3. **Detección**: `ask_gemini` identificó proceso, puerto, archivo y contextualizó IoCs correctamente.
4. **Mitigación** con el procedimiento propuesto por Gemini: hash → `Stop-Process` → verificación de puerto libre.
5. **Cierre**: la confirmación de "sistema limpio" quedó registrada en el hilo.

> El paso 5 evidenció el bug n.º 6 (la tool devolvió la respuesta previa), pero `read_thread` confirmó que Gemini sí respondió el cierre. El puerto quedó libre y el artefacto fue eliminado.

---

## Pendientes / roadmap

1. Pruebas manuales de recarga de extensión, pestaña y Service Worker.
2. Mantener selectores y diagnóstico cuando Gemini cambie su DOM.

---

## Notas

- `chrome-devtools` MCP requiere Chrome con `--remote-debugging-port=9222`; está fuera de este puente.
- El hilo de toques de dados de Gemini (créditos `Extras`/IA Pro) aplican según tu cuenta porque la demo usa tu sesión autenticada.
