import { currencies, minorDigits, type Currency, type Invoice, type Line, type Role } from "./db.ts";

export type Ctx = {
  user: { id: number; email: string; displayName: string };
  team: { id: number; name: string };
  role: Role;
  teams: { id: number; name: string }[];
};

export const esc = Bun.escapeHTML;

export function money(minor: number, currency: Currency) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 10 ** minorDigits[currency]);
}

export function plainAmount(minor: number, currency: Currency) {
  return (minor / 10 ** minorDigits[currency]).toFixed(minorDigits[currency]);
}

const statusLabels = { draft: "Draft", sent: "Sent", paid: "Paid" };

const css = `
body { font: 15px/1.5 system-ui, sans-serif; margin: 0; color: #1f2328; background: #f6f8fa; }
header { background: #fff; border-bottom: 1px solid #d0d7de; }
header nav { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; max-width: 1040px; margin: 0 auto; padding: 10px 20px; }
header nav .brand { font-weight: 700; margin-right: 8px; }
header nav .spacer { flex: 1; }
header nav form { margin: 0; display: flex; gap: 6px; align-items: center; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
main { max-width: 1040px; margin: 0 auto; padding: 20px; }
a { color: #0550ae; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; background: #fff; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #d0d7de; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
label { display: block; margin: 10px 0 4px; }
input, select, button { font: inherit; padding: 4px 8px; }
fieldset { border: 1px solid #d0d7de; background: #fff; margin: 16px 0; min-width: 0; }
.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin: 12px 0; }
.row label { margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.actions form { margin: 0; }
.error { color: #b3261e; }
.notice { color: #1a7f37; }
.card { background: #fff; border: 1px solid #d0d7de; padding: 20px; max-width: 420px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
dt { font-weight: 600; }
dd { margin: 0; }
`;

function nav(ctx: Ctx) {
  const teamControl =
    ctx.teams.length > 1
      ? `<form method="post" action="/team/switch"><label for="team-switch">Team</label><select id="team-switch" name="team_id">${ctx.teams
          .map((team) => `<option value="${team.id}"${team.id === ctx.team.id ? " selected" : ""}>${esc(team.name)}</option>`)
          .join("")}</select><button>Switch</button></form>`
      : `<span>Team: ${esc(ctx.team.name)}</span>`;
  return `<header><nav aria-label="Main">
<a class="brand" href="/invoices">Ledger</a>
<a href="/invoices">Invoices</a>
<a href="/team">Team</a>
<a href="/profile">Profile</a>
<span class="spacer"></span>
${teamControl}
<span>Signed in as <strong>${esc(ctx.user.displayName)}</strong></span>
<form method="post" action="/signout"><button>Sign out</button></form>
</nav></header>`;
}

export function layout(title: string, ctx: Ctx | null, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Ledger</title>
<style>${css}</style>
</head>
<body>
${ctx ? nav(ctx) : ""}
<main>
${body}
</main>
</body>
</html>`;
}

export function messagePage(title: string, message: string, ctx: Ctx | null) {
  return layout(title, ctx, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/invoices">Back to invoices</a></p>`);
}

export function signInPage(error: string, email: string) {
  return layout(
    "Sign in",
    null,
    `<div class="card">
<h1>Sign in to Ledger</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/signin">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<p><button>Sign in</button></p>
</form>
<p>No account yet? <a href="/signup">Sign up</a></p>
</div>`,
  );
}

export function signUpPage(error: string, email: string, displayName: string) {
  return layout(
    "Sign up",
    null,
    `<div class="card">
<h1>Create your account</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/signup">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
<label for="display_name">Display name</label><input id="display_name" name="display_name" autocomplete="name" required maxlength="80" value="${esc(displayName)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
<p><button>Sign up</button></p>
</form>
<p>Already have an account? <a href="/signin">Sign in</a></p>
</div>`,
  );
}

type ListOptions = { q: string; status: string; sort: string; page: number; pages: number };

export function invoiceListPage(ctx: Ctx, invoices: Invoice[], count: number, options: ListOptions) {
  const canEdit = ctx.role !== "viewer";
  const link = (page: number) => {
    const params = new URLSearchParams();
    if (options.q) params.set("q", options.q);
    if (options.status) params.set("status", options.status);
    if (options.sort) params.set("sort", options.sort);
    params.set("page", String(page));
    return "/invoices?" + params.toString();
  };
  const option = (value: string, label: string, current: string) =>
    `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`;
  const rows = invoices
    .map((invoice) => {
      const name = invoice.customer.length > 20 ? invoice.customer.slice(0, 20) + "…" : invoice.customer;
      return `<tr>
${canEdit ? `<td><input type="checkbox" name="invoice" value="${invoice.id}" aria-label="Select ${esc(invoice.number)}"></td>` : ""}
<td><a href="/invoices/${invoice.id}">${esc(invoice.number)}</a></td>
<td><bdi>${esc(name)}</bdi></td>
<td>${invoice.issueDate}</td>
<td>${invoice.dueDate}</td>
<td class="num">${money(invoice.total, invoice.currency)}</td>
<td>${statusLabels[invoice.status]}</td>
</tr>`;
    })
    .join("");
  return layout(
    "Invoices",
    ctx,
    `<h1>Invoices</h1>
<div class="actions">
${canEdit ? `<a href="/invoices/new">New invoice</a>` : ""}
<a href="/invoices/export.csv">Export all invoices as CSV</a>
</div>
<form method="get" action="/invoices" class="row" role="search">
<div><label for="q">Customer</label><input id="q" name="q" type="search" value="${esc(options.q)}"></div>
<div><label for="status">Status</label><select id="status" name="status">
${option("", "All statuses", options.status)}${option("draft", "Draft", options.status)}${option("sent", "Sent", options.status)}${option("paid", "Paid", options.status)}
</select></div>
<div><label for="sort">Sort by</label><select id="sort" name="sort">
${option("", "Newest first", options.sort)}${option("due", "Due date, earliest first", options.sort)}${option("total", "Currency A to Z, then total, highest first", options.sort)}${option("customer", "Customer, A to Z", options.sort)}
</select></div>
<div><button>Apply</button></div>
</form>
<p>${count} ${count === 1 ? "invoice" : "invoices"}</p>
<div class="scroll" role="region" aria-label="Invoices" tabindex="0"><table>
<thead><tr>${canEdit ? `<th><span class="visually-hidden">Select</span></th>` : ""}<th>Number</th><th>Customer</th><th>Issue date</th><th>Due date</th><th class="num">Total</th><th>Status</th></tr></thead>
<tbody>${rows || `<tr><td colspan="${canEdit ? 7 : 6}">No invoices on this page.</td></tr>`}</tbody>
</table></div>
${
  canEdit
    ? `<div class="actions"><button type="button" id="bulk-paid">Mark selected as paid</button><span id="bulk-message" role="status"></span></div>
<script>
document.getElementById("bulk-paid").addEventListener("click", async () => {
  const message = document.getElementById("bulk-message");
  const ids = [...document.querySelectorAll("input[name=invoice]:checked")].map((box) => Number(box.value));
  if (ids.length === 0) {
    message.textContent = "Select at least one invoice.";
    return;
  }
  const response = await fetch("/api/invoices/bulk-paid", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (response.ok) {
    location.reload();
  } else {
    const data = await response.json().catch(() => ({}));
    message.textContent = data.error || "Could not update the selected invoices.";
  }
});
</script>`
    : ""
}
<nav aria-label="Pagination" class="actions">
${options.page > 1 ? `<a href="${esc(link(options.page - 1))}">Previous</a>` : ""}
<span>Page ${options.page} of ${options.pages}</span>
${options.page < options.pages ? `<a href="${esc(link(options.page + 1))}">Next</a>` : ""}
</nav>`,
  );
}

export function invoiceDetailPage(ctx: Ctx, invoice: Invoice & { lines: Line[] }) {
  const canEdit = ctx.role !== "viewer";
  const lines = invoice.lines
    .map(
      (line) => `<tr><td>${esc(line.description)}</td><td class="num">${line.quantity}</td><td class="num">${money(line.unitPrice, invoice.currency)}</td><td class="num">${money(line.amount, invoice.currency)}</td></tr>`,
    )
    .join("");
  const statusButton = (status: string, label: string) =>
    `<form method="post" action="/invoices/${invoice.id}/status"><input type="hidden" name="status" value="${status}"><button>${label}</button></form>`;
  return layout(
    `Invoice ${invoice.number}`,
    ctx,
    `<p><a href="/invoices">Back to invoices</a></p>
<h1>Invoice ${esc(invoice.number)}</h1>
<dl>
<dt>Customer</dt><dd><bdi>${esc(invoice.customer)}</bdi></dd>
<dt>Status</dt><dd>${statusLabels[invoice.status]}</dd>
<dt>Issue date</dt><dd>${invoice.issueDate}</dd>
<dt>Due date</dt><dd><time id="due-date" datetime="${invoice.dueDate}">${invoice.dueDate}</time></dd>
<dt>Currency</dt><dd>${invoice.currency}</dd>
<dt>Tax rate</dt><dd>${invoice.taxRate}%</dd>
</dl>
<div class="scroll" role="region" aria-label="Line items" tabindex="0"><table>
<thead><tr><th>Description</th><th class="num">Quantity</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
<tbody>${lines}</tbody>
<tfoot>
<tr><td colspan="3">Subtotal</td><td class="num">${money(invoice.subtotal, invoice.currency)}</td></tr>
<tr><td colspan="3">Tax (${invoice.taxRate}%)</td><td class="num">${money(invoice.tax, invoice.currency)}</td></tr>
<tr><th scope="row" colspan="3">Total</th><td class="num"><strong>${money(invoice.total, invoice.currency)}</strong></td></tr>
</tfoot>
</table></div>
<script>
const due = document.getElementById("due-date");
due.textContent = new Date(due.dateTime).toLocaleDateString();
</script>
${
  canEdit
    ? `<div class="actions">
${invoice.status !== "paid" ? `<a href="/invoices/${invoice.id}/edit">Edit</a>` : ""}
${invoice.status === "draft" ? statusButton("sent", "Mark as sent") : ""}
${invoice.status !== "paid" ? statusButton("paid", "Mark as paid") : ""}
<button type="button" id="delete-invoice">Delete</button>
</div>
<p id="delete-error" class="error" role="alert"></p>
<script>
document.getElementById("delete-invoice").addEventListener("click", async () => {
  if (!confirm("Delete this invoice?")) return;
  const response = await fetch("/api/invoices/${invoice.id}", { method: "DELETE" });
  if (response.ok) {
    location.href = "/invoices";
  } else {
    const data = await response.json().catch(() => ({}));
    document.getElementById("delete-error").textContent = data.error || "Could not delete the invoice.";
  }
});
</script>`
    : ""
}`,
  );
}

function lineRow(line: { description: string; quantity: number; unitPrice: string }) {
  return `<tr>
<td><input name="description" aria-label="Description" required maxlength="200" value="${esc(line.description)}"></td>
<td><input name="quantity" type="number" aria-label="Quantity" step="1" max="10000" required value="${line.quantity}"></td>
<td><input name="unitPrice" type="number" aria-label="Unit price" step="0.01" min="0" required value="${line.unitPrice}"></td>
<td><button type="button" class="remove-line">Remove</button></td>
</tr>`;
}

export function invoiceFormPage(ctx: Ctx, invoice: (Invoice & { lines: Line[] }) | null) {
  const today = new Date().toISOString().slice(0, 10);
  const currency = invoice?.currency ?? "USD";
  const lines = invoice
    ? invoice.lines.map((line) => lineRow({ description: line.description, quantity: line.quantity, unitPrice: plainAmount(line.unitPrice, invoice.currency) })).join("")
    : lineRow({ description: "", quantity: 1, unitPrice: "" });
  const title = invoice ? `Edit invoice ${invoice.number}` : "New invoice";
  return layout(
    title,
    ctx,
    `<h1>${esc(title)}</h1>
<form id="invoice-form" data-method="${invoice ? "PUT" : "POST"}" data-action="${invoice ? `/api/invoices/${invoice.id}` : "/api/invoices"}">
<p id="form-error" class="error" role="alert" hidden></p>
<p id="form-status" class="notice" role="status"></p>
<label for="customer">Customer</label><input id="customer" name="customer" required maxlength="120" dir="auto" value="${esc(invoice?.customer ?? "")}">
<div class="row">
<div><label for="issueDate">Issue date</label><input id="issueDate" name="issueDate" type="date" required value="${invoice?.issueDate ?? today}"></div>
<div><label for="dueDate">Due date</label><input id="dueDate" name="dueDate" type="date" required value="${invoice?.dueDate ?? ""}"></div>
<div><label for="currency">Currency</label><select id="currency" name="currency">${currencies
      .map((code) => `<option${code === currency ? " selected" : ""}>${code}</option>`)
      .join("")}</select></div>
<div><label for="taxRate">Tax rate (%)</label><input id="taxRate" name="taxRate" type="number" min="0" max="100" step="0.01" required value="${invoice?.taxRate ?? 0}"></div>
</div>
<fieldset>
<legend>Line items</legend>
<div class="scroll" role="region" aria-label="Line items" tabindex="0"><table>
<thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th><span class="visually-hidden">Remove</span></th></tr></thead>
<tbody id="lines">${lines}</tbody>
</table></div>
<p><button type="button" id="add-line">Add line</button></p>
</fieldset>
<p><button type="submit">${invoice ? "Save changes" : "Create invoice"}</button> <a href="${invoice ? `/invoices/${invoice.id}` : "/invoices"}">Cancel</a></p>
</form>
<template id="line-template">${lineRow({ description: "", quantity: 1, unitPrice: "" })}</template>
<script>
const form = document.getElementById("invoice-form");
const lines = document.getElementById("lines");
const errorBox = document.getElementById("form-error");
const digits = { USD: 2, EUR: 2, KRW: 0 };
function setPriceSteps() {
  const step = digits[form.currency.value] ? "0.01" : "1";
  for (const input of form.querySelectorAll("input[name=unitPrice]")) input.step = step;
}
document.getElementById("add-line").addEventListener("click", () => {
  lines.append(document.getElementById("line-template").content.cloneNode(true));
  setPriceSteps();
});
lines.addEventListener("click", (event) => {
  if (event.target.classList.contains("remove-line") && lines.rows.length > 1) event.target.closest("tr").remove();
});
form.currency.addEventListener("change", setPriceSteps);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const factor = 10 ** digits[form.currency.value];
  const body = {
    customer: form.customer.value,
    issueDate: form.issueDate.value,
    dueDate: form.dueDate.value,
    currency: form.currency.value,
    taxRate: Number(form.taxRate.value),
    lines: [...lines.rows].map((row) => ({
      description: row.querySelector("[name=description]").value,
      quantity: Number(row.querySelector("[name=quantity]").value),
      unitPrice: Math.round(Number(row.querySelector("[name=unitPrice]").value) * factor),
    })),
  };
  try {
    const response = await fetch(form.dataset.action, {
      method: form.dataset.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    document.getElementById("form-status").textContent = "Saved invoice " + data.number + ". Opening it now.";
    setTimeout(() => {
      location.href = "/invoices/" + data.id;
    }, 1000);
  } catch (error) {
    errorBox.textContent = error.message || "Could not save the invoice.";
    errorBox.hidden = false;
  }
});
setPriceSteps();
</script>`,
  );
}

type Member = { id: number; email: string; display_name: string; role: Role };

export function teamPage(ctx: Ctx, members: Member[], error: string) {
  const isOwner = ctx.role === "owner";
  const rows = members
    .map(
      (member) => `<tr><td>${esc(member.display_name)}</td><td>${esc(member.email)}</td><td>${member.role}</td>${
        isOwner
          ? `<td>${
              member.role === "owner"
                ? ""
                : `<form method="post" action="/team/remove"><input type="hidden" name="user_id" value="${member.id}"><button>Remove</button></form>`
            }</td>`
          : ""
      }</tr>`,
    )
    .join("");
  return layout(
    "Team",
    ctx,
    `<h1>${esc(ctx.team.name)}</h1>
<p>Your role: ${ctx.role}</p>
<div class="scroll" role="region" aria-label="Team members" tabindex="0"><table>
<thead><tr><th>Name</th><th>Email</th><th>Role</th>${isOwner ? `<th><span class="visually-hidden">Remove</span></th>` : ""}</tr></thead>
<tbody>${rows}</tbody>
</table></div>
${
  isOwner
    ? `<h2>Invite a member</h2>
<p>The person needs a Ledger account. They join the team right away.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/team/invite" class="row">
<div><label for="invite-email">Email</label><input id="invite-email" name="email" type="email" required></div>
<div><label for="invite-role">Role</label><select id="invite-role" name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select></div>
<div><button>Invite</button></div>
</form>`
    : ""
}`,
  );
}

export function profilePage(ctx: Ctx, error: string, saved: boolean) {
  return layout(
    "Profile",
    ctx,
    `<h1>Profile</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
${saved ? `<p class="notice" role="status">Your display name is saved.</p>` : ""}
<form method="post" action="/profile" class="card">
<p>Email: ${esc(ctx.user.email)}</p>
<label for="display_name">Display name</label><input id="display_name" name="display_name" required maxlength="80" value="${esc(ctx.user.displayName)}">
<p><button>Save</button></p>
</form>`,
  );
}
