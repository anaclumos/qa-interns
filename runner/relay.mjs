import { connect, createServer } from "node:net";

const allow = (process.env.QA_RELAY_ALLOW ?? "").split(",");
if (allow.includes("")) {
  console.error(`QA_RELAY_ALLOW must be a comma list of hosts, got ${JSON.stringify(process.env.QA_RELAY_ALLOW ?? null)}`);
  process.exit(1);
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
  let data = Buffer.alloc(0);
  let upstream = null;
  socket.on("error", () => upstream?.destroy());
  const read = (chunk) => {
    data = Buffer.concat([data, chunk]);
    if (data[0] === 22 && (data.length < 5 || data.length < 5 + data.readUInt16BE(3))) return;
    socket.off("data", read);
    socket.pause();
    const name = parse(data);
    if (name === null || !allow.includes(name)) {
      console.log(`deny ${JSON.stringify(name)}`);
      socket.destroy();
      return;
    }
    console.log(`allow ${name}`);
    upstream = connect(443, name, () => {
      upstream.write(data);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  };
  socket.on("data", read);
});

server.listen(443);
