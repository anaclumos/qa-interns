import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Point it at a Postgres database, for example postgres://user:pass@db:5432/ledger.");

export const sql = new SQL(url);

export type Role = "owner" | "editor" | "viewer";
export type Status = "draft" | "sent" | "paid";
export type Currency = "USD" | "EUR" | "KRW";

export const currencies: Currency[] = ["USD", "EUR", "KRW"];
export const statuses: Status[] = ["draft", "sent", "paid"];
export const minorDigits: Record<Currency, number> = { USD: 2, EUR: 2, KRW: 0 };

export type LineInput = { description: string; quantity: number; unitPrice: number };
export type InvoiceInput = {
  customer: string;
  issueDate: string;
  dueDate: string;
  currency: Currency;
  taxRateBp: number;
  lines: LineInput[];
  subtotal: number;
  tax: number;
  total: number;
};

export async function migrate() {
  await sql`
    create table if not exists teams (
      id serial primary key,
      name text not null,
      next_number integer not null default 1
    );
    create table if not exists users (
      id serial primary key,
      email text not null unique,
      display_name text not null,
      password_hash text not null,
      current_team_id integer references teams(id) on delete set null
    );
    create table if not exists memberships (
      team_id integer not null references teams(id) on delete cascade,
      user_id integer not null references users(id) on delete cascade,
      role text not null check (role in ('owner', 'editor', 'viewer')),
      primary key (team_id, user_id)
    );
    create table if not exists sessions (
      token text primary key,
      user_id integer not null references users(id) on delete cascade,
      created_at timestamptz not null default now()
    );
    create table if not exists invoices (
      id serial primary key,
      team_id integer not null references teams(id) on delete cascade,
      number text not null,
      customer text not null,
      issue_date date not null,
      due_date date not null,
      currency text not null check (currency in ('USD', 'EUR', 'KRW')),
      tax_rate_bp integer not null,
      status text not null default 'draft' check (status in ('draft', 'sent', 'paid')),
      subtotal bigint not null,
      tax bigint not null,
      total bigint not null,
      created_at timestamptz not null default now(),
      deleted_at timestamptz
    );
    create table if not exists line_items (
      id serial primary key,
      invoice_id integer not null references invoices(id) on delete cascade,
      position integer not null,
      description text not null,
      quantity integer not null,
      unit_price bigint not null
    );
  `.simple();
}

export async function createTeam(db: SQL, userId: number, name: string) {
  const [team] = await db`insert into teams (name) values (${name}) returning id`;
  await db`insert into memberships (team_id, user_id, role) values (${team.id}, ${userId}, 'owner')`;
  await db`update users set current_team_id = ${team.id} where id = ${userId}`;
  return team.id as number;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 10 || value < "1900-01-01" || value > "9999-12-31") return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function wholeNumber(value: unknown) {
  const number = typeof value === "string" ? Number(BigInt(value)) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
}

export function parseInvoice(body: any): InvoiceInput | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Request body must be a JSON object";
  const customer = typeof body.customer === "string" ? body.customer.trim() : "";
  if (!customer) return "Customer is required";
  if (customer.length > 120) return "Customer must be at most 120 characters";
  if (!isDate(body.issueDate)) return "Issue date must be a valid date in YYYY-MM-DD format";
  if (!isDate(body.dueDate)) return "Due date must be a valid date in YYYY-MM-DD format";
  if (body.dueDate < body.issueDate) return "Due date cannot be before the issue date";
  if (!currencies.includes(body.currency)) return "Currency must be USD, EUR, or KRW";
  const taxRate = body.taxRate;
  if (typeof taxRate !== "number" || !(taxRate >= 0 && taxRate <= 100)) return "Tax rate must be a number from 0 to 100";
  const taxRateBp = Math.round(taxRate * 100);
  if (Math.abs(taxRateBp - taxRate * 100) > 1e-6) return "Tax rate can have at most two decimal places";
  if (!Array.isArray(body.lines) || body.lines.length === 0) return "Add at least one line item";
  if (body.lines.length > 50) return "An invoice can have at most 50 line items";
  const lines: LineInput[] = [];
  for (const line of body.lines) {
    const description = typeof line?.description === "string" ? line.description.trim() : "";
    if (!description) return "Each line item needs a description";
    if (description.length > 200) return "Line item descriptions must be at most 200 characters";
    const quantity = wholeNumber(line.quantity);
    if (quantity === undefined || quantity > 10000) return "Quantity must be a whole number up to 10,000";
    const unitPrice = wholeNumber(line.unitPrice);
    if (unitPrice === undefined || unitPrice < 0 || unitPrice > 1e9) {
      return "Unit price must be a whole number of minor units from 0 to 1,000,000,000";
    }
    lines.push({ description, quantity, unitPrice });
  }
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  if (!(Math.abs(subtotal) <= 1e12)) return "The invoice subtotal is too large";
  const tax = Math.round((subtotal * taxRateBp) / 10000);
  return { customer, issueDate: body.issueDate, dueDate: body.dueDate, currency: body.currency, taxRateBp, lines, subtotal, tax, total: subtotal + tax };
}

async function insertLines(db: SQL, invoiceId: number, lines: LineInput[]) {
  const rows = lines.map((line, position) => ({
    invoice_id: invoiceId,
    position,
    description: line.description,
    quantity: line.quantity,
    unit_price: line.unitPrice,
  }));
  await db`insert into line_items ${db(rows)}`;
}

export async function insertInvoice(teamId: number, input: InvoiceInput, status: Status = "draft") {
  return sql.begin(async (tx) => {
    const [team] = await tx`update teams set next_number = next_number + 1 where id = ${teamId} returning next_number - 1 as n`;
    const number = "INV-" + String(team.n).padStart(4, "0");
    const [invoice] = await tx`
      insert into invoices (team_id, number, customer, issue_date, due_date, currency, tax_rate_bp, status, subtotal, tax, total)
      values (${teamId}, ${number}, ${input.customer}, ${input.issueDate}, ${input.dueDate}, ${input.currency},
        ${input.taxRateBp}, ${status}, ${input.subtotal}, ${input.tax}, ${input.total})
      returning id`;
    await insertLines(tx, invoice.id, input.lines);
    return invoice.id as number;
  });
}

export async function updateInvoice(id: number, input: InvoiceInput) {
  await sql.begin(async (tx) => {
    await tx`
      update invoices set customer = ${input.customer}, issue_date = ${input.issueDate}, due_date = ${input.dueDate},
        currency = ${input.currency}, tax_rate_bp = ${input.taxRateBp}, subtotal = ${input.subtotal}, tax = ${input.tax}, total = ${input.total}
      where id = ${id}`;
    await tx`delete from line_items where invoice_id = ${id}`;
    await insertLines(tx, id, input.lines);
  });
}

export type Invoice = {
  id: number;
  teamId: number;
  number: string;
  customer: string;
  issueDate: string;
  dueDate: string;
  currency: Currency;
  taxRate: number;
  status: Status;
  subtotal: number;
  tax: number;
  total: number;
};

export type Line = { description: string; quantity: number; unitPrice: number; amount: number };

export function toInvoice(row: any): Invoice {
  return {
    id: row.id,
    teamId: row.team_id,
    number: row.number,
    customer: row.customer,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    currency: row.currency,
    taxRate: row.tax_rate_bp / 100,
    status: row.status,
    subtotal: Number(row.subtotal),
    tax: Number(row.tax),
    total: Number(row.total),
  };
}

export const invoiceColumns = () => sql`
  id, team_id, number, customer, issue_date::text as issue_date, due_date::text as due_date,
  currency, tax_rate_bp, status, subtotal, tax, total`;

export async function loadInvoice(id: number) {
  const [row] = await sql`select ${invoiceColumns()} from invoices where id = ${id} and deleted_at is null`;
  if (!row) return undefined;
  const lineRows = await sql`select description, quantity, unit_price from line_items where invoice_id = ${id} order by position`;
  const lines: Line[] = lineRows.map((line: any) => ({
    description: line.description,
    quantity: line.quantity,
    unitPrice: Number(line.unit_price),
    amount: line.quantity * Number(line.unit_price),
  }));
  return { ...toInvoice(row), lines };
}
