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
    socket.on("message", onMessage);
};

function onOpen() {
    socket.once("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "pong") return fail(new Error("Heartbeat response invalid"));
        clearTimeout(timer);
        socket.close();
        server.kill();
        console.log("Smoke test passed");
    });
    socket.send(JSON.stringify({ type: "ping" }));
}

function onMessage(raw) {
    const message = JSON.parse(raw.toString());
    if (message.type !== "pong") return;
}

server.on("error", fail);
connect();
