# Plan de endurecimiento: Gemini MCP Bridge

Documento vivo para llevar el proyecto desde una prueba funcional hasta un puente robusto y mantenible.

## Estado actual

- El puente MCP funciona en una prueba real.
- `bridge_status`: `listening: true`, `extensionConnected: true`.
- `ask_gemini`, `new_chat`, `get_title` y `read_thread` respondieron correctamente.
- La prueba de memoria entre dos mensajes fue exitosa.
- Repositorio privado: `https://github.com/ESlalo149/gemini-mcp`.
- GitNexus actualizado: `144 nodes`, `179 edges`, `7 clusters`, `5 flows`.
- Primer commit publicado: `19c79aa`.

## Plan activo de cierre

El puente ya tiene un flujo funcional real. Este plan reemplaza la lista extensa de investigación inicial por cuatro líneas de trabajo concretas. Los adjuntos permanecen fuera de alcance.

### 1. Robustez del DOM

- [x] Normalizar texto extraído para eliminar controles, etiquetas accesibles, elementos ocultos y duplicación de nodos anidados.
- [ ] Detectar errores visibles de sesión, cuota, red, contenido bloqueado y generación detenida, devolviendo mensajes accionables.
- [ ] Confirmar scroll controlado al último bloque antes de leer o esperar una respuesta.
- [ ] Registrar en la matriz de selectores únicamente los selectores actualmente usados, su fallback, evidencia y fecha.

**Salida:** `ask_gemini` y `read_thread` devuelven contenido limpio y fallan de forma explicable ante cambios del DOM.

### 2. Puente y ciclo de vida de Chrome

- [x] Serializar acciones por pestaña.
- [x] Mantener una única conexión WebSocket y reconectar con heartbeat/alarm.
- [x] Validar mensajes entrantes y limitar acciones permitidas.
- [ ] Diferenciar timeout de servidor, extensión desconectada, pestaña ausente y DOM incompatible.
- [ ] Revisar el heartbeat para no mantener el Service Worker activo más tiempo del necesario.
- [ ] Añadir solo micro-delays necesarios entre eventos sintéticos.

**Salida:** las solicitudes concurrentes no mezclan respuestas y el puente se recupera de reinicios sin estado corrupto.

### 3. Pruebas repetibles

- [x] Validar sintaxis y formato (`npm test`, `git diff --check`).
- [x] Smoke test local de WebSocket y heartbeat (`npm run smoke`).
- [ ] Extender smoke test con `bridge_status` sin extensión y mensajes inválidos.
- [x] Validar round-trip real con `new_chat`, `ask_gemini`, `read_thread` y memoria.
- [x] Validar dos solicitudes concurrentes sin mezclar respuestas.
- [ ] Ejecutar 20 prompts consecutivos sin respuesta obsoleta.
- [x] Validar recuperación tras reinicio de extensión/pestaña/WebSocket.
- [ ] Validar suspensión y reactivación del Service Worker.

**Salida:** todas las pruebas automatizadas pasan y el checklist manual de Chrome queda registrado.

### 4. Documentación operativa

- [ ] Actualizar la tabla de bugs para reflejar únicamente problemas abiertos.
- [ ] Documentar instalación, recarga de extensión y procedimiento seguro de diagnóstico DOM.
- [ ] Documentar límites: cambios de UI de Google, login, rate limits, captcha, privacidad y términos de uso.
- [ ] Registrar cada cambio futuro del DOM con síntoma, selector anterior, selector nuevo y prueba.
- [x] Excluir y documentar la superficie de archivos locales.

**Salida:** otra persona puede instalar, probar y diagnosticar el puente sin conocimiento informal.

### Orden de ejecución

1. Cerrar normalización y errores del DOM.
2. Cerrar timeouts, ciclo de vida y micro-delays del puente.
3. Completar smoke tests y pruebas manuales de recuperación.
4. Sincronizar README, matriz de selectores y registro de cambios.
5. Ejecutar `npx gitnexus analyze` y `gitnexus_detect_changes` como verificación final.

La investigación histórica y los patrones de implementaciones externas que aparecen más abajo se conservan como referencia, no como tareas pendientes obligatorias.

## Arquitectura conocida

```text
OpenCode
  -> MCP stdio: server.js
  -> WebSocket 127.0.0.1:8765
  -> extension/background.js
  -> chrome.tabs.sendMessage
  -> extension/content.js
  -> DOM de gemini.google.com
```

GitNexus modela correctamente los flujos internos de `content.js`, pero no puede representar como llamadas directas el salto por WebSocket entre `server.js` y la extensión.

## Resumen de fases

| Fase | Nombre | Resultado | Estado |
|---|---|---|---|
| 0 | Línea base y observabilidad | Estado reproducible y diagnóstico del DOM | En progreso |
| 1 | DOM y extracción | Lectura fiable de entrada, respuestas e hilo | En progreso |
| 2 | Adjuntos | Fuera de alcance por seguridad y fragilidad DOM | No se implementará |
| 3 | Puente y concurrencia | Comunicación resistente y acciones serializadas | En progreso |
| 4 | Pruebas | Smoke tests, pruebas de regresión y recuperación | En progreso |
| 5 | Cierre y mantenimiento | Documentación, release y proceso ante cambios de Gemini | Pendiente |

Cada fase debe terminar con su criterio de salida antes de iniciar la siguiente. Los cambios que afecten funciones o métodos requieren primero un análisis `gitnexus_impact`; antes de committear se debe ejecutar `gitnexus_detect_changes`.

## Hallazgos de GitNexus

Los cuatro procesos detectados parten de `handleAction` en `extension/content.js`:

1. `handleAction -> getInputElement`
2. `handleAction -> waitForResponse`
3. `handleAction -> waitForAttachment`
4. `handleAction -> base64ToFile`

Impacto previo de las funciones previstas: **LOW**.

- `waitForResponse`: caller directo `ask`.
- `attachFile`: caller directo `attachAndAsk`.
- `handleAction`: solo impacta el propio content script según el grafo.
- `connect`: aislada en el service worker según el grafo.

Limitación observada: `gitnexus_tool_map` no detecta las tools registradas mediante `server.tool(...)`.

## Investigación del DOM

### Fuentes consultadas

- [Gemini Web Automater](https://github.com/itxprashant/gemini-web-automater)
- [Gemini Worker](https://github.com/Syysean/web-ai-skills/blob/main/gemini-worker/SKILL.md)
- [Gemini DOM Structure](https://deepwiki.com/sotayamashita/gemini-chat-exporter/7.1-gemini-dom-structure)
- [Gemini DOM Discovery](https://deepwiki.com/sotayamashita/gemini-chat-exporter/3.1-dom-discovery)
- [Chrome: WebSockets in extension service workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Chrome: service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [MDN: `aria-label`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-label)

### Prácticas recomendadas

- Preferir atributos semánticos y orientados al usuario: `role`, `aria-label`, `aria-current`, texto visible y elementos semánticos.
- Usar `data-*`/`data-test-id` como respaldo, no depender de clases de estilo.
- Evitar XPath absoluto, `nth-child`, cadenas largas de ancestros y clases generadas.
- Buscar bloques por contenido y marcadores semánticos, no por profundidad fija del DOM.
- Ordenar elementos con `compareDocumentPosition()` para conservar el orden de la conversación.
- Usar `MutationObserver` o polling con timeout para contenido dinámico; no depender de sleeps fijos.
- Esperar una condición verificable: nuevo bloque, cambio de identidad o texto estable.
- Limpiar texto de controles, etiquetas de accesibilidad y elementos ocultos antes de extraerlo.
- Mantener selectores agrupados, versionados y diagnosticables.
- Tener fallback explícito y errores accionables cuando Gemini cambie su DOM.

### Patrones encontrados en implementaciones externas

Entrada:

```text
[aria-label="Enter a prompt for Gemini"]
[contenteditable="true"][role="textbox"]
div.ql-editor
rich-textarea
textarea
```

Respuesta:

```text
model-response
.model-response-text
[data-response-id]
.response-content
```

Marcadores de conversación:

- Botón `Copy prompt` para localizar bloques de usuario.
- Botones `Show thinking`, `Good response` y `Bad response` para localizar bloques de Gemini.
- Encabezado `h2` o `[role="heading"][aria-level="2"]` asociado a bloques de usuario.
- Contenido `p`, `ul`, `ol`, `pre`, `code` y `table` asociado a respuestas.

Adjuntos:

- Abrir el menú de subida mediante el botón con nombre accesible `Open upload file menu`.
- Elegir el elemento `Upload files`.
- Esperar el `input[type="file"]` nativo o el chip visual de archivo.
- Usar drag-and-drop solo como fallback.

Estos patrones no son contratos de Google. Deben verificarse contra la pestaña real antes de convertirlos en lógica principal.

## Referencia histórica de fases

### Fase 0: línea base y observabilidad

**Objetivo:** saber exactamente qué DOM tiene la pestaña real y poder diagnosticar fallos sin adivinar selectores.

- [x] Añadir una tool `debug_dom` que devuelva conteos de selectores y nombres accesibles sanitizados.
- [ ] Incluir un resumen del árbol de accesibilidad: `role`, nombre accesible, `aria-*` relevante y visibilidad.
- [ ] Capturar una muestra mínima del DOM real de una conversación con un mensaje de usuario y una respuesta.
- [ ] Capturar el DOM durante una respuesta en generación y al finalizar.
- [ ] Capturar el DOM después de abrir el menú de adjuntos y después de seleccionar un archivo.
- [ ] No capturar cookies, tokens, contenido privado innecesario ni el HTML completo de toda la página.

**Entregable:** matriz de selectores con prioridad, evidencia y fecha de verificación.

**Criterio de salida:** conocemos los elementos reales de entrada, envío, usuario, modelo y adjuntos en la sesión del usuario.

### Fase 1: DOM y extracción

**Objetivo:** hacer fiable el envío de prompts y la lectura de conversaciones, incluso con respuestas progresivas.

- [x] Corregir la carrera de `waitForResponse`: exigir un bloque nuevo respecto al snapshot anterior.
- [x] Usar una condición de finalización basada en identidad del bloque, estabilidad del texto y estado del control Stop.
- [x] Actualizar `readThread` para detectar roles mediante marcadores semánticos y conservar el orden del DOM.
- [x] Ampliar los selectores de entrada, envío y respuesta usando una prioridad semántica.
- [ ] Mantener el texto extraído libre de controles, marcadores de accesibilidad y elementos ocultos.
- [ ] Detectar estados de sesión expirada, cuota agotada, error de red, bloqueo de contenido y generación detenida.
- [ ] Hacer scroll controlado al final del contenedor cuando se espera una respuesta o se lee el hilo virtualizado.

**Entregable:** `ask_gemini`, `read_thread`, `new_chat` y `get_title` operando con selectores semánticos y fallbacks documentados.

**Criterio de salida:** 20 prompts consecutivos devuelven la respuesta nueva y `read_thread` conserva usuario y modelo en orden.

### Fase 2: adjuntos (fuera de alcance)

**Objetivo:** no implementar subida de archivos locales desde el MCP.

- [x] Excluir `send_file`, `attach_ask` y la lectura de rutas locales del contrato MCP.

**Entregable:** ningún tool del MCP lee ni transmite archivos locales.

**Criterio de salida:** la superficie de archivos permanece eliminada y documentada.

### Fase 3: robustez del puente y concurrencia

**Objetivo:** evitar estados corruptos cuando OpenCode, Chrome o la red local cambien de estado.

- [x] Serializar acciones que usan la misma pestaña para evitar dos prompts simultáneos sobre el mismo DOM.
- [x] Mantener una sola conexión WebSocket activa y limpiar correctamente sockets sustituidos.
- [x] Validar mensajes WebSocket entrantes antes de resolver requests pendientes.
- [ ] Conservar timeouts y errores diferenciados para servidor no escuchando, extensión desconectada, pestaña ausente y DOM incompatible.
- [x] Mantener el heartbeat de 20 segundos, respaldado por `chrome.alarms` para despertar el Service Worker y reconectar después de una suspensión.
- [x] Declarar `minimum_chrome_version: 116` para el comportamiento de WebSockets de service workers documentado por Chrome.
- [ ] Evitar mantener el service worker vivo indefinidamente sin una necesidad comprobada.
- [ ] Añadir micro-delays controlados entre eventos sintéticos, sin simular errores humanos ni introducir esperas arbitrarias.

**Entregable:** cola de acciones, reconexión controlada, timeouts y estados de salud observables.

**Criterio de salida:** dos solicitudes simultáneas se procesan en orden sin mezclar respuestas; recargar la extensión, pestaña o service worker permite recuperar la conexión.

### Fase 4: pruebas automatizadas y manuales

**Objetivo:** convertir el comportamiento esperado en verificaciones repetibles.

- [x] Sustituir el `npm test` placeholder por validaciones útiles.
- [x] Añadir `npm run check` para validar los tres archivos JavaScript.
- [x] Añadir `npm run start` para iniciar el servidor MCP.
- [x] Crear un smoke test con extensión WebSocket simulada.
- [ ] Probar `bridge_status` sin Chrome.
- [x] Probar round-trip real con `new_chat`, `ask_gemini`, `read_thread` y memoria.
- [x] No probar upload: la funcionalidad fue retirada por decisión de seguridad.
- [x] Probar dos solicitudes concurrentes y confirmar que no se mezclen.
- [x] Probar recarga de extensión, recarga de pestaña y reconexión del WebSocket.
- [ ] Probar suspensión/reinicio del service worker.
- [x] Ejecutar `npx gitnexus analyze` después de cambios relevantes.
- [x] Ejecutar `gitnexus_detect_changes()` antes de cualquier commit (si se solicita).

**Entregable:** scripts `check`, `test`, `smoke` y checklist manual de Chrome.

**Criterio de salida:** todas las pruebas automatizadas pasan y el checklist manual cubre las seis tools y los escenarios de recuperación.

### Fase 5: documentación y mantenimiento

**Objetivo:** que el proyecto siga siendo reparable cuando Gemini cambie su interfaz.

- [ ] Actualizar la tabla de bugs del README con el estado real.
- [ ] Documentar selectores por prioridad y fecha de última verificación.
- [ ] Documentar cómo tomar una nueva muestra DOM sin exponer información privada.
- [ ] Documentar límites: cambios de UI de Google, login, rate limits, captcha y términos de uso.
- [ ] Registrar cada cambio de DOM con síntoma, selector anterior, selector nuevo y prueba realizada.

**Entregable:** README y `plan.md` actualizados, con historial de cambios del DOM y procedimiento de diagnóstico.

**Criterio de salida:** otra persona puede instalar, probar, diagnosticar y actualizar el puente sin depender de conocimiento informal.

## Información que necesito de la página

Para arreglar con precisión `read_thread`, necesito muestras de tu DOM actual. Puedes enviarme solo fragmentos, no la página completa.

### Muestra A: entrada y botón enviar

En DevTools, inspecciona la caja de texto y el botón de enviar. Copia:

- `Copy outerHTML` de la caja de texto.
- `Copy outerHTML` del botón enviar.
- Si existe, el `aria-label` o `role` de cada uno.

### Muestra B: una pregunta y una respuesta

En una conversación con al menos un turno de cada tipo, copia el `outerHTML` del ancestro más pequeño que contenga:

- Una pregunta del usuario.
- Una respuesta de Gemini.

Antes de enviarlo, elimina texto privado, nombres, URLs, IDs de conversación y cualquier token.

### Muestra C: adjuntos

Con DevTools abierto:

1. Abre el menú para adjuntar un archivo.
2. Copia el `outerHTML` del botón que abrió el menú.
3. Copia el `outerHTML` del elemento `Upload files`.
4. Selecciona un archivo pequeño y copia el `outerHTML` del `input[type="file"]` y del chip/indicador que aparezca.

Si prefieres no copiar HTML, envía únicamente una lista de:

- etiquetas;
- atributos `aria-*`;
- atributos `data-*`;
- clases relevantes;
- texto visible de botones y menús.

## Criterio histórico de finalización

Consideraremos el puente listo cuando:

- Las seis tools respondan correctamente en una sesión real.
- `ask_gemini` no devuelva respuestas obsoletas en 20 pruebas consecutivas.
- `read_thread` preserve usuario y modelo en orden.
- La superficie de archivos permanezca fuera del MCP.
- Las solicitudes concurrentes se serialicen sin mezclar respuestas.
- El puente se recupere de recarga de pestaña, extensión y service worker.
- El smoke test automatizado pase sin Chrome.
- La documentación refleje las limitaciones restantes y GitNexus no detecte cambios inesperados.

## Registro de decisiones

- 2026-09-16: se confirmó round-trip real MCP → WebSocket → extensión → Gemini → MCP.
- 2026-09-16: se decidió investigar el DOM antes de cambiar selectores.
- 2026-09-16: se identificó que clases CSS y profundidad DOM no deben ser selectores primarios.
- 2026-09-16: se identificó que el flujo de adjuntos de implementaciones externas usa el menú nativo de subida antes que drag-and-drop.
