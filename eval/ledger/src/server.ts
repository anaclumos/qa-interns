import type { BunRequest, CookieMap } from "bun";
import {
  createTeam,
  insertInvoice,
  invoiceColumns,
  loadInvoice,
  migrate,
  parseInvoice,
  sql,
  statuses,
  toInvoice,
  updateInvoice,
} from "./db.ts";
import {
  invoiceDetailPage,
  invoiceFormPage,
  invoiceListPage,
  messagePage,
  plainAmount,
  profilePage,
  signInPage,
  signUpPage,
  teamPage,
  type Ctx,
} from "./html.ts";

await migrate();

const cookieName = "ledger_session";
const pageSize = 10;

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "x-content-type-options": "nosniff" },
  });
}

function redirect(location: string) {
  return new Response(null, { status: 303, headers: { location } });
}

function apiError(status: number, error: string) {
  return Response.json({ error }, { status });
}

function notFound(ctx: Ctx) {
  return html(messagePage("Not found", "This invoice does not exist or you do not have access to it.", ctx), 404);
}

function forbidden(ctx: Ctx, message: string) {
  return html(messagePage("Not allowed", message, ctx), 403);
}

function idParam(value: string | undefined) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 && String(id) === value ? id : undefined;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

async function readForm(req: Request) {
  try {
    return await req.formData();
  } catch (err) {
    if (err instanceof TypeError) return new FormData();
    throw err;
  }
}

type Form = { get(name: string): unknown };

function field(form: Form, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function password(form: Form) {
  const value = form.get("password");
  return typeof value === "string" ? value : "";
}

function isEmail(email: string) {
  const at = email.indexOf("@");
  return (
    email.length <= 254 &&
    at > 0 &&
    at === email.lastIndexOf("@") &&
    email.indexOf(".", at) > at + 1 &&
    !email.endsWith(".") &&
    !email.includes(" ")
  );
}

async function startSession(req: { cookies: CookieMap }, userId: number) {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  await sql`insert into sessions (token, user_id) values (${token}, ${userId})`;
  req.cookies.set(cookieName, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
}

const teamsOf = (userId: number) =>
  sql`select t.id, t.name, m.role from memberships m join teams t on t.id = m.team_id where m.user_id = ${userId} order by t.id`;

async function loadContext(req: { cookies: CookieMap }): Promise<Ctx | undefined> {
  const token = req.cookies.get(cookieName);
  if (!token) return undefined;
  const [user] = await sql`
    select u.id, u.email, u.display_name, u.current_team_id
    from sessions s join users u on u.id = s.user_id
    where s.token = ${token} and s.created_at > now() - interval '30 days'`;
  if (!user) return undefined;
  let teams = await teamsOf(user.id);
  if (teams.length === 0) {
    await sql.begin(async (tx) => {
      const [locked] = await tx`select display_name from users where id = ${user.id} for update`;
      const [member] = await tx`select 1 from memberships where user_id = ${user.id} limit 1`;
      if (!member) await createTeam(tx, user.id, `${locked.display_name}'s team`);
    });
    teams = await teamsOf(user.id);
  }
  const team = teams.find((row: any) => row.id === user.current_team_id) ?? teams[0];
  if (team.id !== user.current_team_id) await sql`update users set current_team_id = ${team.id} where id = ${user.id}`;
  return {
    user: { id: user.id, email: user.email, displayName: user.display_name },
    team: { id: team.id, name: team.name },
    role: team.role,
    teams: teams.map((row: any) => ({ id: row.id, name: row.name })),
  };
}

type Handler<T extends string> = (req: BunRequest<T>, ctx: Ctx) => Response | Promise<Response>;

function page<T extends string>(handler: Handler<T>) {
  return async (req: BunRequest<T>) => {
    try {
      const ctx = await loadContext(req);
      if (!ctx) return redirect("/signin");
      return await handler(req, ctx);
    } catch (err) {
      console.error(err);
      return html(messagePage("Something went wrong", "The server could not complete the request. Try again.", null), 500);
    }
  };
}

function api<T extends string>(handler: Handler<T>) {
  return async (req: BunRequest<T>) => {
    try {
      const ctx = await loadContext(req);
      if (!ctx) return apiError(401, "Sign in required");
      return await handler(req, ctx);
    } catch (err) {
      console.error(err);
      return apiError(500, "Internal server error");
    }
  };
}

async function teamInvoice(idText: string | undefined, ctx: Ctx) {
  const id = idParam(idText);
  const invoice = id ? await loadInvoice(id) : undefined;
  return invoice?.teamId === ctx.team.id ? invoice : undefined;
}

const members = (teamId: number) => sql`
  select u.id, u.email, u.display_name, m.role
  from memberships m join users u on u.id = m.user_id
  where m.team_id = ${teamId}
  order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, lower(u.display_name)`;

function csvCell(value: string) {
  return value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

function csvText(value: string) {
  return csvCell(value.length > 0 && "=+-@\t\r".includes(value.charAt(0)) ? "'" + value : value);
}

const server = Bun.serve({
  port: 3000,
  hostname: "0.0.0.0",
  development: false,
  routes: {
    "/health": {
      GET: async () => {
        await sql`select 1`;
        return new Response("ok");
      },
    },
    "/": { GET: () => redirect("/invoices") },
    "/signin": {
      GET: async (req) => ((await loadContext(req)) ? redirect("/invoices") : html(signInPage("", ""))),
      POST: async (req) => {
        const form = await readForm(req);
        const email = field(form, "email").toLowerCase();
        const [user] = await sql`select id, password_hash from users where email = ${email}`;
        const valid = user ? await Bun.password.verify(password(form), user.password_hash) : false;
        if (!valid) return html(signInPage("Email or password is incorrect.", email), 400);
        await startSession(req, user.id);
        return redirect("/invoices");
      },
    },
    "/signup": {
      GET: async (req) => ((await loadContext(req)) ? redirect("/invoices") : html(signUpPage("", "", ""))),
      POST: async (req) => {
        const form = await readForm(req);
        const email = field(form, "email").toLowerCase();
        const displayName = field(form, "display_name");
        const secret = password(form);
        const error = !isEmail(email)
          ? "Enter a valid email address."
          : !displayName || displayName.length > 80
            ? "Display name must be 1 to 80 characters."
            : secret.length < 8 || secret.length > 200
              ? "Password must be 8 to 200 characters."
              : "";
        if (error) return html(signUpPage(error, email, displayName), 400);
        const hash = await Bun.password.hash(secret);
        const userId = await sql.begin(async (tx) => {
          const [user] = await tx`
            insert into users (email, display_name, password_hash) values (${email}, ${displayName}, ${hash})
            on conflict (email) do nothing returning id`;
          if (!user) return undefined;
          await createTeam(tx, user.id, `${displayName}'s team`);
          return user.id as number;
        });
        if (!userId) return html(signUpPage("An account with this email already exists.", email, displayName), 400);
        await startSession(req, userId);
        return redirect("/invoices");
      },
    },
    "/signout": {
      POST: async (req) => {
        const token = req.cookies.get(cookieName);
        if (token) await sql`delete from sessions where token = ${token}`;
        req.cookies.delete(cookieName);
        return redirect("/signin");
      },
    },
    "/invoices": {
      GET: page(async (req, ctx) => {
        const params = new URL(req.url).searchParams;
        const q = (params.get("q") ?? "").trim();
        const status = statuses.find((value) => value === params.get("status")) ?? "";
        const sort = ["due", "total", "customer"].find((value) => value === params.get("sort")) ?? "";
        const order =
          sort === "due"
            ? sql`due_date, id`
            : sort === "total"
              ? sql`currency, total desc, id`
              : sort === "customer"
                ? sql`lower(customer), id`
                : sql`id desc`;
        const requested = Number(params.get("page") ?? "1");
        const filters = () => sql`
          team_id = ${ctx.team.id}
          ${q ? sql`and strpos(lower(customer), lower(${q}::text)) > 0` : sql``}
          ${status ? sql`and status = ${status}` : sql``}`;
        const [{ count }] = await sql`select count(*)::int as count from invoices where ${filters()}`;
        const pages = Math.max(1, Math.ceil(count / pageSize));
        const pageNumber = Number.isSafeInteger(requested) && requested >= 1 ? Math.min(requested, pages) : 1;
        const rows = await sql`
          select ${invoiceColumns()} from invoices
          where ${filters()} and deleted_at is null
          order by ${order}
          limit ${pageSize} offset ${(pageNumber - 1) * (pageSize - 1)}`;
        return html(invoiceListPage(ctx, rows.map(toInvoice), count, { q, status, sort, page: pageNumber, pages }));
      }),
    },
    "/invoices/new": {
      GET: page((req, ctx) =>
        ctx.role === "viewer" ? forbidden(ctx, "Viewers cannot create invoices.") : html(invoiceFormPage(ctx, null)),
      ),
    },
    "/invoices/export.csv": {
      GET: page(async (req, ctx) => {
        const rows = await sql`
          select ${invoiceColumns()} from invoices
          where team_id = ${ctx.team.id} and deleted_at is null order by id`;
        const lines = [
          ["Number", "Customer", "Issue date", "Due date", "Currency", "Status", "Total"].join(","),
          ...rows.map(toInvoice).map((invoice: ReturnType<typeof toInvoice>) =>
            [
              csvText(invoice.number),
              csvText(invoice.customer),
              invoice.issueDate,
              invoice.dueDate,
              invoice.currency,
              invoice.status,
              plainAmount(invoice.subtotal, invoice.currency),
            ].join(","),
          ),
        ];
        return new Response(lines.join("\r\n") + "\r\n", {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="invoices.csv"',
          },
        });
      }),
    },
    "/invoices/:id": {
      GET: page(async (req, ctx) => {
        const invoice = await teamInvoice(req.params.id, ctx);
        return invoice ? html(invoiceDetailPage(ctx, invoice)) : notFound(ctx);
      }),
    },
    "/invoices/:id/edit": {
      GET: page(async (req, ctx) => {
        if (ctx.role === "viewer") return forbidden(ctx, "Viewers cannot edit invoices.");
        const invoice = await teamInvoice(req.params.id, ctx);
        if (!invoice) return notFound(ctx);
        if (invoice.status === "paid") return html(messagePage("Invoice is paid", "Paid invoices cannot be edited.", ctx), 409);
        return html(invoiceFormPage(ctx, invoice));
      }),
    },
    "/invoices/:id/status": {
      POST: page(async (req, ctx) => {
        if (ctx.role === "viewer") return forbidden(ctx, "Viewers cannot change invoice status.");
        const invoice = await teamInvoice(req.params.id, ctx);
        if (!invoice) return notFound(ctx);
        const status = field(await readForm(req), "status");
        const from = status === "sent" ? ["draft"] : status === "paid" ? ["draft", "sent"] : [];
        if (from.length === 0) return html(messagePage("Invalid status", "Choose sent or paid.", ctx), 400);
        await sql`update invoices set status = ${status} where id = ${invoice.id} and status in ${sql(from)}`;
        return redirect(`/invoices/${invoice.id}`);
      }),
    },
    "/team": {
      GET: page(async (req, ctx) => html(teamPage(ctx, await members(ctx.team.id), ""))),
    },
    "/team/invite": {
      POST: page(async (req, ctx) => {
        if (ctx.role !== "owner") return forbidden(ctx, "Only team owners can invite members.");
        const form = await readForm(req);
        const email = field(form, "email").toLowerCase();
        const role = field(form, "role");
        const fail = async (message: string) => html(teamPage(ctx, await members(ctx.team.id), message), 400);
        if (role !== "editor" && role !== "viewer") return fail("Choose the editor or viewer role.");
        const [user] = await sql`select id from users where email = ${email}`;
        if (!user) return fail("No Ledger account uses that email. Ask them to sign up first.");
        const added = await sql`
          insert into memberships (team_id, user_id, role) values (${ctx.team.id}, ${user.id}, ${role})
          on conflict do nothing returning user_id`;
        if (added.length === 0) return fail("That person is already a member of this team.");
        return redirect("/team");
      }),
    },
    "/team/remove": {
      POST: page(async (req, ctx) => {
        if (ctx.role !== "owner") return forbidden(ctx, "Only team owners can remove members.");
        const userId = idParam(field(await readForm(req), "user_id"));
        if (userId) await sql`delete from memberships where team_id = ${ctx.team.id} and user_id = ${userId} and role <> 'owner'`;
        return redirect("/team");
      }),
    },
    "/team/switch": {
      POST: page(async (req, ctx) => {
        const teamId = idParam(field(await readForm(req), "team_id"));
        if (ctx.teams.some((team) => team.id === teamId)) await sql`update users set current_team_id = ${teamId} where id = ${ctx.user.id}`;
        return redirect("/invoices");
      }),
    },
    "/profile": {
      GET: page((req, ctx) => html(profilePage(ctx, "", new URL(req.url).searchParams.has("saved")))),
      POST: page(async (req, ctx) => {
        const displayName = field(await readForm(req), "display_name");
        if (!displayName || displayName.length > 80) return html(profilePage(ctx, "Display name must be 1 to 80 characters.", false), 400);
        await sql`update users set display_name = ${displayName} where id = ${ctx.user.id}`;
        return redirect("/profile?saved=1");
      }),
    },
    "/api/me": {
      GET: api((req, ctx) =>
        Response.json({ id: ctx.user.id, email: ctx.user.email, displayName: ctx.user.displayName, team: ctx.team, role: ctx.role }),
      ),
    },
    "/api/invoices": {
      GET: api(async (req, ctx) => {
        const rows = await sql`
          select ${invoiceColumns()} from invoices
          where team_id = ${ctx.team.id} and deleted_at is null order by id`;
        return Response.json({ invoices: rows.map(toInvoice) });
      }),
      POST: api(async (req, ctx) => {
        if (ctx.role === "viewer") return apiError(403, "Viewers cannot create invoices");
        const body = await readJson(req);
        if (body === undefined) return apiError(400, "Request body must be valid JSON");
        let input;
        try {
          input = parseInvoice(body);
        } catch (err) {
          return new Response(String((err as Error).stack), { status: 500 });
        }
        if (typeof input === "string") return apiError(400, input);
        const id = await insertInvoice(ctx.team.id, input);
        return Response.json(await loadInvoice(id), { status: 201 });
      }),
    },
    "/api/invoices/bulk-paid": {
      POST: api(async (req, ctx) => {
        if (ctx.role === "viewer") return apiError(403, "Viewers cannot change invoice status");
        const body: any = await readJson(req);
        if (body === undefined) return apiError(400, "Request body must be valid JSON");
        const ids = body?.ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((id) => idParam(String(id)) === id)) {
          return apiError(400, "ids must be a list of 1 to 100 invoice ids");
        }
        const rows = await sql`
          update invoices set status = 'paid'
          where team_id = ${ctx.team.id} and deleted_at is null and id in ${sql(ids)}
          returning id`;
        return Response.json({ updated: rows.length });
      }),
    },
    "/api/invoices/:id": {
      GET: api(async (req) => {
        const id = idParam(req.params.id);
        const invoice = id ? await loadInvoice(id) : undefined;
        return invoice ? Response.json(invoice) : apiError(404, "Invoice not found");
      }),
      PUT: api(async (req, ctx) => {
        if (ctx.role === "viewer") return apiError(403, "Viewers cannot edit invoices");
        const invoice = await teamInvoice(req.params.id, ctx);
        if (!invoice) return apiError(404, "Invoice not found");
        const body = await readJson(req);
        if (body === undefined) return apiError(400, "Request body must be valid JSON");
        let input;
        try {
          input = parseInvoice(body);
        } catch (err) {
          if (err instanceof SyntaxError) return apiError(400, "Quantity and unit price must be whole numbers");
          throw err;
        }
        if (typeof input === "string") return apiError(400, input);
        if (!(await updateInvoice(invoice.id, input))) return apiError(409, "Paid invoices cannot be edited");
        return Response.json(await loadInvoice(invoice.id));
      }),
      DELETE: api(async (req, ctx) => {
        const id = idParam(req.params.id);
        const [row] = id
          ? await sql`
              update invoices set deleted_at = now()
              where id = ${id} and team_id = ${ctx.team.id} and deleted_at is null
              returning id`
          : [];
        return row ? new Response(null, { status: 204 }) : apiError(404, "Invoice not found");
      }),
    },
  },
  fetch(req) {
    return new URL(req.url).pathname.startsWith("/api/")
      ? apiError(404, "Not found")
      : html(messagePage("Page not found", "There is no page at this address.", null), 404);
  },
  error(err) {
    console.error(err);
    return new Response("Internal server error", { status: 500 });
  },
});

console.log(`Ledger listening on port ${server.port}`);
