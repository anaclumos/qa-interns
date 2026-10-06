import { createServer } from "node:http";
import { connect } from "node:net";

const allow = (process.env.QA_PROXY_ALLOW ?? "").split(",");
if (allow.some((entry) => entry === "" || entry === "*.")) {
  console.error(`QA_PROXY_ALLOW must be a comma list of hosts, got ${JSON.stringify(process.env.QA_PROXY_ALLOW ?? null)}`);
  process.exit(1);
}

function allowed(host) {
  return allow.some((entry) => (entry.startsWith("*.") ? host === entry.slice(2) || host.endsWith(entry.slice(1)) : host === entry));
}

const server = createServer((req, res) => {
  console.log(`deny ${req.url}`);
  res.writeHead(403).end();
});

server.on("connect", (req, socket, head) => {
  const [rawHost = "", port, rest] = req.url.split(":");
  const host = rawHost.toLowerCase();
  let upstream = null;
  socket.on("error", () => upstream?.destroy());
  if (rest !== undefined || port !== "443" || !allowed(host)) {
    console.log(`deny ${req.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  console.log(`allow ${req.url}`);
  upstream = connect(443, `${host}.`, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
});

server.listen(3128);
