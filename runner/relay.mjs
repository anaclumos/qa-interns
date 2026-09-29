import { connect, createServer } from "node:net";

const allow = (process.env.QA_RELAY_ALLOW ?? "").split(",");
if (allow.includes("")) {
  console.error(`QA_RELAY_ALLOW must be a comma list of hosts, got ${JSON.stringify(process.env.QA_RELAY_ALLOW ?? null)}`);
  process.exit(1);
}
const limits = JSON.parse(process.env.QA_RELAY_LIMITS ?? "null");
if (limits === null || typeof limits !== "object" || Array.isArray(limits) || Object.keys(limits).some((host) => !allow.includes(host))) {
  console.error(`QA_RELAY_LIMITS must be a JSON object keyed by hosts of QA_RELAY_ALLOW, got ${JSON.stringify(process.env.QA_RELAY_LIMITS ?? null)}`);
  process.exit(1);
}
const budgets = new Map(Object.entries(limits).map(([host, limit]) => [host, { limit, open: 0, opened: [], total: 0, refused: 0 }]));

function exceeded(budget, now) {
  while (budget.opened.length > 0 && budget.opened[0] <= now - 60_000) budget.opened.shift();
  if (budget.limit.total !== undefined && budget.total >= budget.limit.total) return "total";
  if (budget.limit.concurrent !== undefined && budget.open >= budget.limit.concurrent) return "concurrent";
  if (budget.limit.perMinute !== undefined && budget.opened.length >= budget.limit.perMinute) return "perMinute";
  return null;
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
  socket.setTimeout(10_000, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.on("close", () => upstream?.destroy());
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
    const budget = budgets.get(name);
    if (budget !== undefined) {
      const now = Date.now();
      const limit = exceeded(budget, now);
      if (limit !== null) {
        budget.refused += 1;
        console.log(`refuse ${name} ${limit}`);
        socket.destroy();
        return;
      }
      budget.open += 1;
      budget.total += 1;
      budget.opened.push(now);
      socket.on("close", () => {
        budget.open -= 1;
      });
    }
    console.log(`allow ${name}`);
    upstream = connect(443, name, () => {
      socket.setTimeout(0);
      upstream.write(data);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  };
  socket.on("data", read);
});

process.on("SIGTERM", () => {
  console.log(`refused ${JSON.stringify(Object.fromEntries([...budgets].map(([host, budget]) => [host, budget.refused])))}`);
  process.exit(0);
});

server.listen(443);
