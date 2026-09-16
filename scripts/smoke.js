const { spawn } = require("child_process");
const WebSocket = require("ws");

const port = 18765;
const server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, GEMINI_WSS_PORT: String(port) },
    stdio: ["pipe", "ignore", "pipe"],
});

const fail = (error) => {
    console.error(error.message || error);
    server.kill();
    process.exit(1);
};

const timer = setTimeout(() => fail(new Error("Smoke test timeout")), 5000);
let socket;

const connect = () => {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.on("error", (error) => {
        if (error.code === "ECONNREFUSED") return setTimeout(connect, 100);
        fail(error);
    });
    socket.on("open", onOpen);
};

function onOpen() {
    let phase = 0;
    socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "pong") return fail(new Error("Heartbeat response invalid"));
        if (phase++ === 0) {
            socket.send(JSON.stringify({ id: 42, ok: "invalid" }));
            socket.send(JSON.stringify({ type: "ping" }));
            return;
        }
        clearTimeout(timer);
        socket.close();
        server.kill();
        console.log("Smoke test passed");
    });
    socket.send(JSON.stringify({ type: "ping" }));
}

server.on("error", fail);
connect();
