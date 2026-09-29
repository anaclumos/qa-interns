import { connect, createServer } from "node:net";

const allow = (process.env.QA_RELAY_ALLOW ?? "").split(",");
if (allow.includes("")) {
  console.error(`QA_RELAY_ALLOW must be a comma list of hosts, got ${JSON.stringify(process.env.QA_RELAY_ALLOW ?? null)}`);
  process.exit(1);
}

let count = 0;

function record(host, outcome, error) {
  count += 1;
  console.log(JSON.stringify({ n: count, host, outcome, error }));
}

function serverName(data) {
  const record = data.subarray(0, 5 + data.readUInt16BE(3));
  if (record[0] !== 22 || record[5] !== 1) return null;
  let at = 43;
  at += 1 + record[at];
  at += 2 + record.readUInt16BE(at);
  at += 1 + record[at];
  const end = at + 2 + record.readUInt16BE(at);
  for (at += 2; at + 4 <= end; at += 4 + record.readUInt16BE(at + 2)) {
    if (record.readUInt16BE(at) !== 0) continue;
    const length = record.readUInt16BE(at + 7);
    if (record[at + 6] !== 0 || at + 9 + length > record.length) return null;
    return record.toString("latin1", at + 9, at + 9 + length).toLowerCase();
  }
  return null;
}

function parse(data) {
  try {
    return serverName(data);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

const server = createServer((socket) => {
  if (socket.localAddress === "127.0.0.1") {
    socket.destroy();
    return;
  }
  let data = Buffer.alloc(0);
  let host = null;
  let upstream = null;
  let recorded = false;
  const settle = (outcome, error) => {
    if (recorded) return;
    recorded = true;
    record(host, outcome, error);
  };
  const end = (error) => settle(upstream === null ? "incomplete" : "failed", error);
  socket.setTimeout(10_000, () => {
    end("timeout");
    socket.destroy();
  });
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    upstream?.destroy();
    end(null);
  });
  const read = (chunk) => {
    data = Buffer.concat([data, chunk]);
    if (data[0] === 22 && (data.length < 5 || data.length < 5 + data.readUInt16BE(3))) return;
    socket.off("data", read);
    socket.pause();
    host = parse(data);
    if (host === null || !allow.includes(host)) {
      settle("denied", null);
      socket.destroy();
      return;
    }
    upstream = connect(443, host, () => {
      settle("connected", null);
      socket.setTimeout(0);
      upstream.write(data);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", (error) => {
      settle("failed", error.code ?? error.message);
      socket.destroy();
    });
  };
  socket.on("data", read);
});

server.listen(443, "0.0.0.0");
