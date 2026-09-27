import { currencies, insertInvoice, migrate, parseInvoice, sql, type Currency, type Status } from "./db.ts";

const accounts = [
  { email: "owner@acme.test", password: "acme-owner-pass", displayName: "Avery Stone", team: "Acme", role: "owner" },
  { email: "editor@acme.test", password: "acme-editor-pass", displayName: "Eli Park", team: "Acme", role: "editor" },
  { email: "viewer@acme.test", password: "acme-viewer-pass", displayName: "Vera Lind", team: "Acme", role: "viewer" },
  { email: "owner@globex.test", password: "globex-owner-pass", displayName: "Gus Moreno", team: "Globex", role: "owner" },
];

const acmeCustomers = [
  "Northwind Traders",
  "Blue Harbor Bakery 🥐 Co",
  "Initech",
  "مؤسسة الأفق للتجارة",
  "Umbrella Health Partners",
  "Kim & Lee Design Studio",
  "Müller Logistik GmbH",
  "한빛 커피 로스터스",
  "Wayne Enterprises",
  "Stark Industries",
];

const services: [string, number][] = [
  ["Website maintenance, hours", 9500],
  ["Logo design", 120000],
  ["Hosting, monthly", 4900],
  ["Copywriting, pages", 18000],
  ["Consulting, hours", 15000],
  ["Photography session", 65000],
  ["Print run, 500 flyers", 21000],
];

const statusCycle: Status[] = ["paid", "sent", "draft", "paid", "sent"];
const taxRates = [0, 10, 8.25, 20];

function addDays(date: string, days: number) {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}

function price(usdCents: number, currency: Currency) {
  if (currency === "KRW") return Math.round((usdCents * 13) / 100) * 100;
  if (currency === "EUR") return Math.round((usdCents * 0.92) / 100) * 100;
  return usdCents;
}

async function addInvoice(teamId: number, customer: string, index: number, currency: Currency, status: Status) {
  const issueDate = addDays("2026-06-01", index * 4);
  const lines = Array.from({ length: 1 + (index % 4) }, (_, k) => {
    const [description, usdCents] = services[(index + k * 2) % services.length]!;
    return { description, quantity: 1 + ((index * 3 + k) % 5), unitPrice: price(usdCents, currency) };
  });
  const input = parseInvoice({
    customer,
    issueDate,
    dueDate: addDays(issueDate, [14, 30, 45][index % 3]!),
    currency,
    taxRate: taxRates[index % taxRates.length],
    lines,
  });
  if (typeof input === "string") throw new Error(`Seed invoice ${index} is invalid: ${input}`);
  return insertInvoice(teamId, input, status);
}

await migrate();
await sql`truncate sessions, line_items, invoices, memberships, users, teams restart identity cascade`;

const teamIds: Record<string, number> = {};
for (const name of ["Acme", "Globex"]) {
  const [team] = await sql`insert into teams (name) values (${name}) returning id`;
  teamIds[name] = team.id;
}

for (const account of accounts) {
  const teamId = teamIds[account.team]!;
  const hash = await Bun.password.hash(account.password);
  const [user] = await sql`
    insert into users (email, display_name, password_hash, current_team_id)
    values (${account.email}, ${account.displayName}, ${hash}, ${teamId})
    returning id`;
  await sql`insert into memberships (team_id, user_id, role) values (${teamId}, ${user.id}, ${account.role})`;
}

for (let index = 0; index < 23; index++) {
  await addInvoice(teamIds.Acme!, acmeCustomers[index % acmeCustomers.length]!, index, currencies[index % 3]!, statusCycle[index % 5]!);
}

const globexInvoiceIds = [];
for (const [index, customer] of ["Soylent Corp", "Hooli", "Vandelay Industries"].entries()) {
  globexInvoiceIds.push(await addInvoice(teamIds.Globex!, customer, index, "USD", (["draft", "sent", "paid"] as Status[])[index]!));
}

console.log(
  JSON.stringify(
    {
      accounts,
      data: {
        summary:
          "Acme has 23 invoices across the draft, sent, and paid statuses and the USD, EUR, and KRW currencies, with varied customers, due dates, and line items. Customer names include an emoji and right-to-left Arabic text. Globex has 3 invoices.",
        acmeInvoiceCount: 23,
        globexInvoiceCount: 3,
        globexInvoiceId: globexInvoiceIds[0],
      },
    },
    null,
    2,
  ),
);

await sql.close();
