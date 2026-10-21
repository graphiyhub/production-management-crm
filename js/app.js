import { supabase } from "./config.js";
import { authService } from "./auth.js";
import { clearWorkspace, state } from "./state.js";
import { MODULES, recordService, relationshipService, workspaceService } from "./data.js";

const root = document.querySelector("#app");
const notices = document.querySelector("#notices");
const PAGE_SIZE = 20;
let workspaceRows = [];
let pageIndex = 0;
let searchText = "";
let realtimeChannel = null;
let realtimeWorkspaceId = null;
let activeCurrency = "USD";
let activeTimezone = "UTC";
let sortState = {};
let authNotice = "";
let refreshTimer = null;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function workspaceToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: activeTimezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function notify(message, isError = false) {
  const notice = el("div", message, `notice${isError ? " error" : ""}`);
  notices.append(notice);
  window.setTimeout(() => notice.remove(), 5000);
}

function friendlyError(error) {
  const message = error?.message || "An unexpected error occurred.";
  if (error?.status === 401 || /invalid login credentials/i.test(message)) return "Email or password is incorrect.";
  if (error?.status === 429 || /rate limit|too many requests/i.test(message)) {
    return "Too many authentication requests. Wait a few minutes before trying again.";
  }
  if (error?.status === 403 || error?.code === "42501") return "You do not have permission to perform that action.";
  if (error?.code === "23505") return "This record already exists or has already been converted.";
  if (error?.code === "23503") return "This record is still connected to other workspace data.";
  if (/failed to fetch|network/i.test(message)) return "Network error. Check your connection and try again.";
  if (/email not confirmed/i.test(message)) return "Verify your email before signing in.";
  if (/outstanding invoice balance/i.test(message)) return "That payment is greater than the invoice balance.";
  return message;
}

function currentRoute() {
  const queryParams = new URLSearchParams(window.location.search);
  if (queryParams.get("auth") === "reset") return { page: "reset-password", params: queryParams };
  const hash = window.location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = hash.split("?");
  return { page: path || "dashboard", params: new URLSearchParams(query) };
}

function setRoute(route) {
  window.location.hash = `#/${route}`;
}

function closeRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  realtimeWorkspaceId = null;
}

function connectRealtime(workspaceId) {
  if (realtimeChannel && realtimeWorkspaceId === workspaceId) return;
  closeRealtime();
  const tables = [
    "leads", "clients", "projects", "tasks", "invoices", "payments",
    "deliverables", "revisions", "client_notes", "payment_adjustments", "activities"
  ];
  const channel = supabase.channel(`workspace:${workspaceId}`);
  for (const table of tables) {
    channel.on("postgres_changes", {
      event: "*", schema: "public", table, filter: `workspace_id=eq.${workspaceId}`
    }, () => scheduleCurrentPageRefresh());
  }
  realtimeChannel = channel.subscribe((status) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      notify("Live updates are unavailable. Changes will appear after refreshing the view.", true);
    }
  });
  realtimeWorkspaceId = workspaceId;
}

function scheduleCurrentPageRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    const route = currentRoute();
    if (route.page === "reset-password" || !state.session || !state.workspace) return;
    loadPage(route.page, route.params).catch((error) => notify(friendlyError(error), true));
  }, 120);
}

function pageTitle(page) {
  return MODULES[page]?.title || ({
    dashboard: "Dashboard", reports: "Reports", whatsapp: "WhatsApp", settings: "Workspace settings"
  })[page] || "Dashboard";
}

async function render() {
  if (currentRoute().page === "reset-password") {
    renderAuth();
    return;
  }
  if (!state.session) {
    closeRealtime();
    renderAuth("", authNotice);
    authNotice = "";
    return;
  }
  if (authNotice) {
    notify(authNotice);
    authNotice = "";
  }
  const result = await workspaceService.list();
  workspaceRows = result;
  const rememberedId = sessionStorage.getItem("graphiyy-active-workspace");
  const active = result.find((item) => item.workspace_id === rememberedId);
  if (!active) {
    clearWorkspace();
    closeRealtime();
    renderWorkspacePicker();
    return;
  }

  const workspace = active.workspace;
  if (!workspace?.id) {
    clearWorkspace();
    renderWorkspacePicker();
    return;
  }
  state.workspace = workspace;
  state.membershipRole = active.role;
  activeCurrency = "USD";
  activeTimezone = "UTC";
  try {
    const settings = await workspaceService.getSettings(workspace.id);
    activeCurrency = settings.currency_code || "USD";
    activeTimezone = settings.timezone || "UTC";
  } catch (error) {
    notify(friendlyError(error), true);
  }
  connectRealtime(workspace.id);
  await renderWorkspaceApp();
}

function renderAuth(errorMessage = "", infoMessage = authNotice) {
  const route = currentRoute().page;
  const reset = route === "reset-password";
  const signUp = route === "signup";
  root.innerHTML = `
    <main class="auth-screen">
      <section class="auth-card" aria-labelledby="auth-heading">
        <div class="brand">Graphiyy<span> CRM</span></div>
        <p class="eyebrow">Agency work, connected.</p>
        <h1 id="auth-heading">${reset ? "Choose a new password" : signUp ? "Create your account" : "Welcome back"}</h1>
        ${infoMessage ? `<p class="muted" role="status">${escapeHtml(infoMessage)}</p>` : ""}
        <form id="auth-form">
          ${signUp ? `<div class="field"><label for="display-name">Your name</label><input id="display-name" name="displayName" autocomplete="name" required maxlength="120"></div>` : ""}
          ${!reset ? `<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>` : ""}
          ${reset ? `<div class="field"><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required></div>` : ""}
          ${!reset && !currentRoute().params.has("recover") ? `<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${signUp ? "new-password" : "current-password"}" minlength="${signUp ? "8" : "1"}" required></div>` : ""}
          ${errorMessage ? `<p class="form-error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
          <button class="button full" type="submit">${reset ? "Update password" : signUp ? "Create account" : currentRoute().params.has("recover") ? "Send reset link" : "Sign in"}</button>
        </form>
        <div class="inline" style="justify-content:space-between;margin-top:.8rem">
          ${!reset && !currentRoute().params.has("recover") ? `<button class="text-button" id="mode-toggle" type="button">${signUp ? "Already have an account? Sign in" : "Create an account"}</button>` : ""}
          ${!reset && !signUp && !currentRoute().params.has("recover") ? `<button class="text-button" id="recover" type="button">Forgot password?</button>` : ""}
          ${currentRoute().params.has("recover") ? `<button class="text-button" id="back-to-login" type="button">Back to sign in</button>` : ""}
        </div>
        <p class="muted" style="font-size:.8rem;margin:1rem 0 0">Your workspace data is protected by Supabase Row Level Security.</p>
      </section>
    </main>`;

  root.querySelector("#mode-toggle")?.addEventListener("click", () => setRoute(signUp ? "auth" : "signup"));
  root.querySelector("#recover")?.addEventListener("click", () => { window.location.hash = "#/auth?recover=1"; });
  root.querySelector("#back-to-login")?.addEventListener("click", () => setRoute("auth"));
  root.querySelector("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      let response;
      if (reset) {
        response = await authService.updatePassword(String(form.get("password")));
        if (!response.error) {
          const { error } = await authService.signOut();
          if (error) throw error;
        }
      }
      else if (currentRoute().params.has("recover")) response = await authService.resetPassword(String(form.get("email")));
      else if (signUp) response = await authService.signUp(String(form.get("email")), String(form.get("password")), String(form.get("displayName")));
      else response = await authService.signIn(String(form.get("email")), String(form.get("password")));
      if (response.error) throw response.error;
      if (signUp && !response.data.session) {
        renderAuth("", "Account created. Check your email to verify your address, then sign in.");
      } else if (reset) {
        window.history.replaceState(null, "", `${window.location.pathname}#/auth`);
        renderAuth("", "Password updated. Sign in with your new password.");
      } else if (currentRoute().params.has("recover")) {
        renderAuth("", "If the address is registered, a password-reset link has been sent.");
      } else {
        notify(signUp ? "Account created." : "Signed in.");
        await render();
      }
    } catch (error) {
      renderAuth(friendlyError(error));
    } finally {
      button.disabled = false;
    }
  });
}

async function renderWorkspacePicker(errorMessage = "") {
  root.innerHTML = `
    <main class="auth-screen">
      <section class="workspace-picker panel">
        <div class="brand">Graphiyy<span> CRM</span></div>
        <h1>Choose a workspace</h1>
        <p class="muted">Only workspaces where your account is a member are shown.</p>
        ${errorMessage ? `<p class="form-error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
        <div class="workspace-grid" id="workspace-list"></div>
        <h2>Create a workspace</h2>
        <form id="workspace-form" class="inline">
          <label class="field" style="flex:1;margin:0"><span class="muted">Workspace name</span><input name="name" required maxlength="120" placeholder="Your agency"></label>
          <button class="button" type="submit">Create workspace</button>
        </form>
        <button class="text-button" id="signout" type="button">Sign out</button>
      </section>
    </main>`;
  const list = root.querySelector("#workspace-list");
  try {
    workspaceRows = await workspaceService.list();
    if (!workspaceRows.length) list.append(el("p", "No workspaces yet. Create your first workspace below.", "muted"));
    for (const membership of workspaceRows) {
      const button = el("button", undefined, "workspace-card");
      button.type = "button";
      button.append(el("strong", membership.workspace?.name || "Workspace"));
      button.append(el("span", `Role: ${membership.role}`, "muted"));
      button.addEventListener("click", () => {
        sessionStorage.setItem("graphiyy-active-workspace", membership.workspace_id);
        if (currentRoute().page !== "dashboard") setRoute("dashboard");
        else render().catch((error) => notify(friendlyError(error), true));
      });
      list.append(button);
    }
  } catch (error) {
    list.append(el("p", friendlyError(error), "form-error"));
  }
  root.querySelector("#workspace-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const id = await workspaceService.create(String(form.get("name")).trim());
      sessionStorage.setItem("graphiyy-active-workspace", id);
      notify("Workspace created. You are its owner.");
      if (currentRoute().page !== "dashboard") setRoute("dashboard");
      else await render();
    } catch (error) {
      renderWorkspacePicker(friendlyError(error));
    } finally {
      button.disabled = false;
    }
  });
  root.querySelector("#signout").addEventListener("click", async () => {
    const { error } = await authService.signOut();
    if (error) notify(friendlyError(error), true);
  });
}

async function renderWorkspaceApp() {
  const route = currentRoute();
  const page = MODULES[route.page] ? route.page : ["dashboard", "reports", "whatsapp", "settings"].includes(route.page) ? route.page : "dashboard";
  const appLinks = [
    ["dashboard", "Dashboard"], ["leads", "Leads"], ["clients", "Clients"], ["projects", "Projects"],
    ["tasks", "Tasks"], ["deliverables", "Deliverables"], ["revisions", "Revisions"],
    ["invoices", "Invoices"], ["payments", "Payments"], ["reports", "Reports"],
    ["whatsapp", "WhatsApp"], ["settings", "Settings"]
  ];
  root.innerHTML = `
    <div class="app-layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">Graphiyy<span> CRM</span></div>
        <nav aria-label="Main navigation">
          ${appLinks.map(([id, label]) => `<a class="nav-link${id === page ? " active" : ""}" href="#/${id}" ${id === page ? 'aria-current="page"' : ""}>${label}</a>`).join("")}
        </nav>
        <div class="sidebar-footer">
          <small>${escapeHtml(state.session.user.email)}</small>
          <small>${escapeHtml(state.workspace.name)} · ${escapeHtml(state.membershipRole)}</small>
          <button class="button secondary full" id="switch-workspace" type="button">Switch workspace</button>
          <button class="button secondary full" id="signout" type="button">Sign out</button>
        </div>
      </aside>
      <main class="main-area">
        <header class="topbar">
          <button class="menu-button" id="menu-button" type="button" aria-label="Open navigation">☰</button>
          <span class="mobile-brand">Graphiyy CRM</span>
          <p>${escapeHtml(state.session.user.email)}</p>
        </header>
        <div id="page-content"><div class="startup"><span class="spinner"></span><p>Loading ${escapeHtml(pageTitle(page))}…</p></div></div>
      </main>
    </div>`;
  root.querySelector("#switch-workspace").addEventListener("click", () => {
    clearWorkspace();
    closeRealtime();
    renderWorkspacePicker();
  });
  root.querySelector("#signout").addEventListener("click", async () => {
    const { error } = await authService.signOut();
    if (error) notify(friendlyError(error), true);
  });
  root.querySelector("#menu-button").addEventListener("click", () => root.querySelector("#sidebar").classList.toggle("open"));
  root.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => root.querySelector("#sidebar").classList.remove("open"));
  });
  await loadPage(page, route.params);
}

async function loadPage(page, params = currentRoute().params) {
  const content = root.querySelector("#page-content");
  if (!content || !state.workspace) return;
  try {
    if (page === "dashboard") return await renderDashboard(content);
    if (MODULES[page]) return await renderModule(content, page, params);
    if (page === "reports") return await renderReports(content);
    if (page === "whatsapp") return renderWhatsApp(content);
    if (page === "settings") return renderSettings(content);
  } catch (error) {
    content.replaceChildren(el("section", friendlyError(error), "notice-panel"));
  }
}

function money(minor) {
  const currency = activeCurrency;
  try {
    const amount = BigInt(minor || 0);
    const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
    const digits = formatter.resolvedOptions().maximumFractionDigits;
    const scale = 10n ** BigInt(digits);
    const absolute = amount < 0n ? -amount : amount;
    const whole = absolute / scale;
    const fraction = digits ? String(absolute % scale).padStart(digits, "0") : "";
    const parts = formatter.formatToParts(whole);
    let insertedFraction = false;
    const formatted = parts.map((part) => {
      if (part.type === "fraction") {
        insertedFraction = true;
        return fraction;
      }
      if (part.type === "decimal" && !digits) return "";
      return part.value;
    }).join("");
    const withFraction = digits && !insertedFraction
      ? `${formatted}${new Intl.NumberFormat().formatToParts(1.1).find((part) => part.type === "decimal")?.value || "."}${fraction}`
      : formatted;
    return amount < 0n ? `-${withFraction}` : withFraction;
  } catch {
    return `${minor} ${currency} minor units`;
  }
}

function workspaceDateTimeInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: activeTimezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function workspaceDateTimeToIso(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Enter a valid date and time.");
  const [, year, month, day, hour, minute] = match.map((part) => Number(part));
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const normalized = new Date(desired);
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() + 1 !== month
    || normalized.getUTCDate() !== day || normalized.getUTCHours() !== hour
    || normalized.getUTCMinutes() !== minute) {
    throw new Error("Enter a valid date and time.");
  }
  let timestamp = desired;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: activeTimezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
      .map(({ type, value: part }) => [type, part]));
    const represented = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    const difference = desired - represented;
    if (difference === 0) return new Date(timestamp).toISOString();
    timestamp += difference;
  }
  throw new Error("That local time does not exist because of a daylight-saving transition. Choose another time.");
}

function formatWorkspaceDate(value, includeTime = false) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  const date = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    timeZone: dateOnly ? "UTC" : activeTimezone,
    ...(includeTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" })
  }).format(date);
}

async function renderDashboard(content) {
  const metrics = await recordService.dashboard(state.workspace.id);
  const recentActivities = await relationshipService.activities(state.workspace.id, null, null, 8);
  content.innerHTML = `
    <div class="page-heading"><div><h1>Dashboard</h1><p>${escapeHtml(state.workspace.name)} · live workspace metrics</p></div></div>
    <section class="metric-grid" aria-label="Business metrics">
      ${metric("Total leads", metrics.leads, "leads")}
      ${metric("Lead conversion", `${metrics.conversionRate.toFixed(1)}%`, "leads?converted=1")}
      ${metric("Active clients", metrics.clients, "clients?status=active")}
      ${metric("Active projects", metrics.activeProjects, "projects?status=active")}
      ${metric("Completed projects", metrics.completedProjects, "projects?status=completed")}
      ${metric("Tasks", metrics.openTasks, "tasks")}
      ${metric("Overdue tasks (current)", metrics.overdueTasks, "tasks?overdue=1")}
      ${metric("Upcoming tasks (7 days)", metrics.upcomingTasks, "tasks?upcoming=1")}
      ${metric("Invoiced", money(metrics.invoiced), "invoices")}
      ${metric("Outstanding receivables", money(metrics.outstanding), "invoices?outstanding=1")}
      ${metric("Recorded payments", money(metrics.collected), "payments")}
    </section>
    <section class="panel"><h2>Recent activity</h2>${activityList(recentActivities)}</section>
    <section class="panel"><h2>Financial definitions</h2><p class="muted">Invoiced is issued invoice value, excluding drafts and cancellations. Outstanding receivables subtract recorded partial payments. Recorded payments exclude reversals; they represent cash recorded in this CRM, not confirmation of settlement by a payment provider.</p></section>`;
}

function metric(label, value, route) {
  return `<a class="metric-card" href="#/${route}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></a>`;
}

function makeInput(field, initialValue, relationOptions = []) {
  const [name, label, type, required, values] = field;
  const wrapper = el("div", undefined, "field");
  const labelNode = el("label", label);
  labelNode.htmlFor = `field-${name}`;
  wrapper.append(labelNode);
  let input;
  if (type === "textarea") {
    input = el("textarea");
  } else if (type === "select" || type === "relation") {
    input = el("select");
    const empty = el("option", type === "relation" && required ? "Choose a record" : "—");
    empty.value = "";
    input.append(empty);
    const options = type === "select" ? values.map((value) => [value, value.replaceAll("_", " ")]) : relationOptions;
    for (const [value, text] of options) {
      const option = el("option", text);
      option.value = value;
      input.append(option);
    }
  } else {
    input = el("input");
    input.type = type === "relation" ? "text" : type;
    if (type === "number") {
      input.min = "0";
      input.step = "1";
    }
  }
  input.id = `field-${name}`;
  input.name = name;
  if (required) input.required = true;
  if (type === "datetime-local" && initialValue) input.value = workspaceDateTimeInput(initialValue);
  else if (initialValue !== undefined && initialValue !== null) input.value = String(initialValue);
  if (type === "relation") input.dataset.relation = values;
  wrapper.append(input);
  return wrapper;
}

async function relationOptionsFor(table) {
  if (table === "members") {
    const members = await relationshipService.members(state.workspace.id);
    return members.map((member) => [member.user_id, `${member.display_name} · ${member.role}`]);
  }
  const columns = {
    clients: ["id", "name"], projects: ["id", "title"], invoices: ["id", "invoice_number"],
    deliverables: ["id", "title"]
  };
  const selected = columns[table];
  if (!selected) throw new Error("Unsupported related record.");
  let query = supabase.from(table).select(`${selected[0]},${selected[1]}`)
    .eq("workspace_id", state.workspace.id).order(selected[1]).order(selected[0]);
  if (table === "invoices") query = query.in("status", ["issued", "partially_paid", "overdue"]);
  const records = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query.range(offset, offset + 999);
    if (error) throw error;
    records.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return records.map((record) => [record[selected[0]], record[selected[1]]]);
}

async function showRecordForm(moduleKey, record = null, initialValues = {}) {
  const definition = MODULES[moduleKey];
  const dialog = el("dialog");
  dialog.setAttribute("aria-labelledby", "form-title");
  const title = el("h2", record ? `Edit ${definition.title.slice(0, -1)}` : `New ${definition.title.slice(0, -1)}`);
  title.id = "form-title";
  const form = el("form");
  const submissionKey = moduleKey === "payments" && !record ? crypto.randomUUID() : null;
  const fieldNodes = [];
  for (const field of definition.fields) {
    const options = field[2] === "relation" ? await relationOptionsFor(field[4]) : [];
    const wrapper = makeInput(field, record?.[field[0]] ?? initialValues[field[0]], options);
    form.append(wrapper);
    fieldNodes.push(wrapper);
  }
  const actions = el("div", undefined, "dialog-actions");
  const cancel = el("button", "Cancel", "button secondary");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  const save = el("button", "Save", "button");
  save.type = "submit";
  actions.append(cancel, save);
  form.append(actions);
  dialog.append(title, form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    const formData = new FormData(form);
    const values = {};
    for (const field of definition.fields) {
      const [name, , type] = field;
      const raw = formData.get(name);
      if (field[3] && (raw === null || String(raw).trim() === "")) {
        notify(`${field[1]} is required.`, true);
        save.disabled = false;
        return;
      }
      if (raw === "" || raw === null) {
        if (["relation", "date", "datetime-local"].includes(type) && name !== "issue_date") values[name] = null;
      } else if (type === "number") {
        const number = Number(raw);
        if (!Number.isSafeInteger(number) || number < 0) {
          notify("Enter a valid non-negative whole number.", true);
          save.disabled = false;
          return;
        }
        values[name] = number;
      } else if (type === "datetime-local") {
        try {
          values[name] = workspaceDateTimeToIso(String(raw));
        } catch (error) {
          notify(error.message, true);
          save.disabled = false;
          return;
        }
      } else {
        values[name] = String(raw).trim();
      }
    }
    if (moduleKey === "tasks" && values.status) {
      values.completed_at = values.status === "done" ? (record?.completed_at || new Date().toISOString()) : null;
    }
    if (moduleKey === "tasks" && values.project_id) {
      const { data: project, error } = await supabase.from("projects").select("client_id")
        .eq("workspace_id", state.workspace.id).eq("id", values.project_id).single();
      if (error) {
        notify(friendlyError(error), true);
        save.disabled = false;
        return;
      }
      if (values.client_id && project.client_id !== values.client_id) {
        notify("The selected client does not match the selected project's client.", true);
        save.disabled = false;
        return;
      }
      values.client_id = project.client_id;
    }
    if (moduleKey === "payments" && (!Number.isSafeInteger(values.amount_minor) || values.amount_minor <= 0)) {
      notify("Payment amount must be a positive whole number of minor currency units.", true);
      save.disabled = false;
      return;
    }
    try {
      if (record) await recordService.update(moduleKey, state.workspace.id, record.id, values);
      else {
        if (submissionKey) {
          values.idempotency_key = submissionKey;
          values.created_by = state.session.user.id;
        }
        await recordService.create(moduleKey, state.workspace.id, values);
      }
      dialog.close();
      notify(`${definition.title.slice(0, -1)} saved.`);
      await loadPage(moduleKey, new URLSearchParams());
    } catch (error) {
      notify(friendlyError(error), true);
      save.disabled = false;
    }
  });
  dialog.showModal();
  fieldNodes[0]?.querySelector("input,select,textarea")?.focus();
}

async function addInvoiceLine(invoice) {
  const dialog = el("dialog");
  const heading = el("h2", `Add line to ${invoice.invoice_number}`);
  const form = el("form");
  const fields = [
    ["description", "Description", "text", true],
    ["quantity", "Quantity", "number", true],
    ["unit_price_minor", "Unit price (minor units)", "number", true]
  ];
  for (const field of fields) {
    const wrapper = makeInput(field);
    if (field[0] === "quantity") wrapper.querySelector("input").step = "0.001";
    form.append(wrapper);
  }
  const actions = el("div", undefined, "dialog-actions");
  const cancel = el("button", "Cancel", "button secondary");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  const save = el("button", "Add line", "button");
  save.type = "submit";
  actions.append(cancel, save);
  form.append(actions);
  dialog.append(heading, form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    const data = new FormData(form);
    const quantity = Number(data.get("quantity"));
    const unitPrice = Number(data.get("unit_price_minor"));
    if (!(quantity > 0) || !Number.isSafeInteger(unitPrice) || unitPrice < 0) {
      notify("Enter a positive quantity and a valid non-negative unit price.", true);
      save.disabled = false;
      return;
    }
    const description = String(data.get("description")).trim();
    if (!description) {
      notify("Enter a line item description.", true);
      save.disabled = false;
      return;
    }
    const { error } = await supabase.from("invoice_items").insert({
      workspace_id: state.workspace.id,
      invoice_id: invoice.id,
      description,
      quantity,
      unit_price_minor: unitPrice
    });
    if (error) {
      notify(friendlyError(error), true);
      save.disabled = false;
      return;
    }
    dialog.close();
    notify("Invoice line added; totals recalculated by the database.");
    await loadPage("invoices");
  });
  dialog.showModal();
}

async function refundPayment(payment) {
  const dialog = el("dialog");
  dialog.setAttribute("aria-labelledby", "refund-heading");
  const heading = el("h2", "Record a partial refund");
  heading.id = "refund-heading";
  const form = document.createElement("form");
  const fields = [
    ["amount_minor", "Refund amount (minor units)", "number", true],
    ["reason", "Reason", "textarea", true]
  ];
  for (const field of fields) form.append(makeInput(field));
  const amountInput = form.querySelector('[name="amount_minor"]');
  amountInput.min = "1";
  amountInput.step = "1";
  const reasonInput = form.querySelector('[name="reason"]');
  reasonInput.maxLength = 1000;
  const actions = el("div", undefined, "dialog-actions");
  const cancel = el("button", "Cancel", "button secondary");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  const submit = el("button", "Record refund", "button");
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(actions);
  dialog.append(heading, el("p", `Payment amount: ${money(payment.amount_minor)}. Existing refunds are validated by the database.`, "muted"), form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  const idempotencyKey = crypto.randomUUID();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const amount = Number(amountInput.value);
    const reason = reasonInput.value.trim();
    if (!Number.isSafeInteger(amount) || amount <= 0 || !reason) {
      notify("Enter a positive whole-unit refund and a reason.", true);
      return;
    }
    submit.disabled = true;
    try {
      await recordService.refundPayment(
        state.workspace.id, payment.id, amount, reason, idempotencyKey
      );
      dialog.close();
      notify("Refund recorded. Invoice balance and payment status were recalculated.");
      await loadPage("payments");
    } catch (error) {
      notify(friendlyError(error), true);
      submit.disabled = false;
    }
  });
  dialog.showModal();
}

function activityList(items) {
  if (!items.length) return el("p", "No activity has been recorded yet.", "empty-state");
  const list = document.createElement("ul");
  list.className = "activity-list";
  for (const item of items) {
    const detail = Array.isArray(item.details?.changed_fields)
      ? ` · ${item.details.changed_fields.join(", ").replaceAll("_", " ")}`
      : "";
    const when = formatWorkspaceDate(item.created_at, true);
    list.append(el("li", `${item.action} ${item.entity_type.replaceAll("_", " ")}${detail} · ${when}`));
  }
  return list;
}

function appendRelatedList(dialog, heading, records, label) {
  const section = el("section", undefined, "detail-section");
  section.append(el("h3", heading));
  if (!records.length) {
    section.append(el("p", "No related records.", "muted"));
  } else {
    const list = document.createElement("ul");
    for (const record of records) list.append(el("li", label(record)));
    section.append(list);
  }
  dialog.append(section);
}

async function showRecordDetails(moduleKey, record) {
  const dialog = el("dialog");
  const titleValue = record.title || record.contact_name || record.name || record.invoice_number;
  const heading = el("h2", titleValue);
  dialog.setAttribute("aria-labelledby", "details-title");
  heading.id = "details-title";
  const close = el("button", "Close", "button secondary");
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  dialog.append(heading);

  if (moduleKey === "clients") {
    const [projects, tasks, invoices, notes] = await Promise.all([
      relationshipService.related("projects", state.workspace.id, "client_id", record.id),
      relationshipService.related("tasks", state.workspace.id, "client_id", record.id),
      relationshipService.related("invoices", state.workspace.id, "client_id", record.id),
      relationshipService.related("client_notes", state.workspace.id, "client_id", record.id)
    ]);
    appendRelatedList(dialog, "Projects", projects, (item) => `${item.title} · ${item.status}`);
    appendRelatedList(dialog, "Tasks", tasks, (item) => `${item.title} · ${item.status}`);
    appendRelatedList(dialog, "Invoices", invoices, (item) => `${item.invoice_number} · ${item.status} · ${money(item.total_minor)}`);
    const notesSection = el("section", undefined, "detail-section");
    notesSection.append(el("h3", "Notes"));
    const noteForm = document.createElement("form");
    noteForm.className = "inline";
    const noteInput = el("input", undefined, "search-input");
    noteInput.name = "body";
    noteInput.required = true;
    noteInput.maxLength = 4000;
    noteInput.placeholder = "Add a client note";
    const noteButton = el("button", "Add note", "button");
    noteButton.type = "submit";
    noteForm.append(noteInput, noteButton);
    noteForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = noteInput.value.trim();
      if (!body) {
        notify("Enter a note before saving.", true);
        return;
      }
      noteButton.disabled = true;
      try {
        await relationshipService.addClientNote(state.workspace.id, record.id, body);
        notify("Client note saved.");
        dialog.close();
        await showRecordDetails("clients", record);
      } catch (error) {
        notify(friendlyError(error), true);
        noteButton.disabled = false;
      }
    });
    notesSection.append(noteForm);
    if (notes.length) {
      const noteList = document.createElement("ul");
      for (const note of notes) noteList.append(el("li", `${note.body} · ${formatWorkspaceDate(note.created_at, true)}`));
      notesSection.append(noteList);
    } else notesSection.append(el("p", "No notes yet.", "muted"));
    dialog.append(notesSection);
  } else if (moduleKey === "projects") {
    const [tasks, deliverables, invoices] = await Promise.all([
      relationshipService.related("tasks", state.workspace.id, "project_id", record.id),
      relationshipService.related("deliverables", state.workspace.id, "project_id", record.id),
      relationshipService.related("invoices", state.workspace.id, "project_id", record.id)
    ]);
    const finishedTasks = tasks.filter((task) => task.status === "done").length;
    const progress = tasks.length ? Math.round(finishedTasks / tasks.length * 100) : 0;
    dialog.append(el("p", `Task progress: ${progress}% (${finishedTasks}/${tasks.length} completed)`, "muted"));
    appendRelatedList(dialog, "Tasks", tasks, (item) => `${item.title} · ${item.status}`);
    appendRelatedList(dialog, "Deliverables", deliverables, (item) => `${item.title} · ${item.status}`);
    appendRelatedList(dialog, "Invoices", invoices, (item) => `${item.invoice_number} · ${item.status} · ${money(item.total_minor)}`);
  } else if (moduleKey === "invoices") {
    const [items, payments] = await Promise.all([
      relationshipService.related("invoice_items", state.workspace.id, "invoice_id", record.id),
      relationshipService.related("payments", state.workspace.id, "invoice_id", record.id)
    ]);
    const lineSection = el("section", undefined, "detail-section");
    lineSection.append(el("h3", "Line items"));
    if (!items.length) lineSection.append(el("p", "No line items. Add at least one before issuing.", "empty-state"));
    else {
      const lineTable = document.createElement("table");
      const lineHead = document.createElement("thead");
      const lineHeader = document.createElement("tr");
      for (const label of ["Description", "Quantity", "Unit price", "Line total", ...(record.status === "draft" ? ["Action"] : [])]) {
        lineHeader.append(el("th", label));
      }
      lineHead.append(lineHeader);
      lineTable.append(lineHead);
      const lineBody = document.createElement("tbody");
      for (const item of items) {
        const line = document.createElement("tr");
        line.append(
          el("td", item.description),
          el("td", item.quantity),
          el("td", money(item.unit_price_minor)),
          el("td", money(item.line_total_minor))
        );
        if (record.status === "draft") {
          const action = document.createElement("td");
          const removeLine = el("button", "Remove", "small-button");
          removeLine.type = "button";
          removeLine.addEventListener("click", async () => {
            if (!window.confirm(`Remove invoice line "${item.description}"?`)) return;
            removeLine.disabled = true;
            const { error } = await supabase.from("invoice_items").delete()
              .eq("workspace_id", state.workspace.id).eq("id", item.id);
            if (error) {
              notify(friendlyError(error), true);
              removeLine.disabled = false;
              return;
            }
            dialog.close();
            await loadPage("invoices");
            const { data: latestInvoice, error: invoiceError } = await supabase.from("invoices")
              .select("*").eq("workspace_id", state.workspace.id).eq("id", record.id).single();
            if (invoiceError) {
              notify(friendlyError(invoiceError), true);
              return;
            }
            await showRecordDetails("invoices", latestInvoice);
          });
          action.append(removeLine);
          line.append(action);
        }
        lineBody.append(line);
      }
      lineTable.append(lineBody);
      lineSection.append(lineTable);
    }
    dialog.append(lineSection);
    appendRelatedList(dialog, "Payments", payments, (item) =>
      `${money(item.amount_minor)} · ${item.method} · ${formatWorkspaceDate(item.paid_at)}${item.reversed_at ? " · reversed" : ""}`);
    dialog.append(el("p", `Invoice total: ${money(record.total_minor)}`, "invoice-total"));
    const printButton = el("button", "Print invoice", "button");
    printButton.type = "button";
    printButton.addEventListener("click", async () => {
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        notify("Allow pop-ups to print this invoice.", true);
        return;
      }
      try {
        const { data: client, error } = await supabase.from("clients")
          .select("name,company_name,email,phone").eq("workspace_id", state.workspace.id)
          .eq("id", record.client_id).single();
        if (error) throw error;
        printWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${escapeHtml(record.invoice_number)}</title><style>body{font:16px Arial,sans-serif;max-width:800px;margin:40px auto;color:#0a0a0a}h1{color:#061a40}table{width:100%;border-collapse:collapse;margin:24px 0}td,th{text-align:left;padding:10px;border-bottom:1px solid #ddd}.total{text-align:right;font-size:20px;font-weight:bold}@media print{button{display:none}}</style></head><body><h1>Graphiyy CRM</h1><h2>Invoice ${escapeHtml(record.invoice_number)}</h2><p>${escapeHtml(client.name)}${client.company_name ? ` · ${escapeHtml(client.company_name)}` : ""}</p><p>${escapeHtml(client.email || "")} ${escapeHtml(client.phone || "")}</p><p>Issued ${escapeHtml(record.issue_date || "")} · Due ${escapeHtml(record.due_date || "—")}</p><table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Total</th></tr></thead><tbody>${items.map((item) => `<tr><td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.quantity)}</td><td>${escapeHtml(money(item.unit_price_minor))}</td><td>${escapeHtml(money(item.line_total_minor))}</td></tr>`).join("")}</tbody></table><p class="total">Total: ${escapeHtml(money(record.total_minor))}</p><p>${escapeHtml(record.notes || "")}</p><script>window.addEventListener("load",()=>window.print())</script></body></html>`);
        printWindow.document.close();
      } catch (error) {
        printWindow.close();
        notify(friendlyError(error), true);
      }
    });
    dialog.append(printButton);
  } else if (moduleKey === "payments") {
    const [adjustments, invoice] = await Promise.all([
      relationshipService.related("payment_adjustments", state.workspace.id, "payment_id", record.id),
      (async () => {
        const { data, error } = await supabase.from("invoices")
          .select("invoice_number,status,total_minor").eq("workspace_id", state.workspace.id)
          .eq("id", record.invoice_id).single();
        if (error) throw error;
        return data;
      })()
    ]);
    dialog.append(el("p", `Payment ${money(record.amount_minor)} · ${record.method} · ${record.reversed_at ? "reversed" : "active"}`));
    dialog.append(el("p", `Invoice ${invoice.invoice_number} · ${invoice.status} · ${money(invoice.total_minor)}`));
    appendRelatedList(dialog, "Refund history", adjustments, (item) =>
      `${money(item.amount_minor)} · ${item.reason} · ${formatWorkspaceDate(item.created_at, true)}`);
  } else if (moduleKey === "leads") {
    const [activity, leadActivity] = await Promise.all([
      relationshipService.activities(state.workspace.id, "leads", record.id, 20),
      relationshipService.related("lead_activities", state.workspace.id, "lead_id", record.id)
    ]);
    appendRelatedList(dialog, "Lead activity history", leadActivity, (item) =>
      `${item.activity_type} · ${item.details?.note || ""} · ${formatWorkspaceDate(item.created_at, true)}`);
    const activityForm = document.createElement("form");
    activityForm.className = "inline";
    const activityType = document.createElement("select");
    activityType.name = "activity_type";
    activityType.setAttribute("aria-label", "Lead activity type");
    for (const [value, label] of [["call", "Call"], ["email", "Email"], ["meeting", "Meeting"], ["note", "Note"], ["other", "Other"]]) {
      const option = el("option", label);
      option.value = value;
      activityType.append(option);
    }
    const activityNote = el("input", undefined, "search-input");
    activityNote.name = "note";
    activityNote.required = true;
    activityNote.maxLength = 1000;
    activityNote.placeholder = "Add an interaction note";
    const activitySubmit = el("button", "Log activity", "button");
    activitySubmit.type = "submit";
    activityForm.append(activityType, activityNote, activitySubmit);
    activityForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const note = activityNote.value.trim();
      if (!note) {
        notify("Enter a note for this interaction.", true);
        return;
      }
      activitySubmit.disabled = true;
      try {
        await relationshipService.addLeadActivity(
          state.workspace.id, record.id, activityType.value, note
        );
        notify("Lead activity logged.");
        dialog.close();
        await showRecordDetails("leads", record);
      } catch (error) {
        notify(friendlyError(error), true);
        activitySubmit.disabled = false;
      }
    });
    const activityEntry = el("section", undefined, "detail-section");
    activityEntry.append(el("h3", "Log an interaction"), activityForm);
    dialog.append(activityEntry);
    const activitySection = el("section", undefined, "detail-section");
    activitySection.append(el("h3", "Record audit history"), activityList(activity));
    dialog.append(activitySection);
  } else if (moduleKey === "deliverables") {
    const revisions = await relationshipService.related("revisions", state.workspace.id, "deliverable_id", record.id);
    appendRelatedList(dialog, "Revisions", revisions, (item) =>
      `${item.description} · ${item.status} · ${formatWorkspaceDate(item.created_at)}`);
  }

  const audit = await relationshipService.activities(state.workspace.id, moduleKey, record.id, 10);
  if (audit.length && moduleKey !== "leads") {
    const section = el("section", undefined, "detail-section");
    section.append(el("h3", "Activity history"), activityList(audit));
    dialog.append(section);
  }
  dialog.append(close);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
}

function displayValue(moduleKey, column, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (column === "task_progress") return `${value}%`;
  if (column.endsWith("_minor") || column === "budget_minor" || column === "estimated_value_minor") return money(value);
  if (column.endsWith("_at") || column.endsWith("_date")) {
    return formatWorkspaceDate(value, column.endsWith("_at"));
  }
  if (column.endsWith("_id")) return String(value).slice(0, 8);
  return String(value).replaceAll("_", " ");
}

function moduleFilters(moduleKey, params) {
  const filters = [];
  const status = params.get("status");
  if (status && ["leads", "clients", "projects", "tasks", "invoices", "deliverables", "revisions"].includes(moduleKey)) {
    filters.push(["status", "eq", status]);
  }
  if (moduleKey === "invoices" && params.get("outstanding") === "1") {
    filters.push(["status", "notIn", "(paid,draft,cancelled)"]);
  }
  if (moduleKey === "tasks" && params.get("overdue") === "1") {
    filters.push(["status", "notIn", "(done,cancelled)"]);
    filters.push(["due_at", "lt", new Date().toISOString()]);
  }
  if (moduleKey === "tasks" && params.get("upcoming") === "1") {
    filters.push(["status", "notIn", "(done,cancelled)"]);
    filters.push(["due_at", "gte", new Date().toISOString()]);
    filters.push(["due_at", "lt", new Date(Date.now() + 7 * 86400000).toISOString()]);
  }
  if (moduleKey === "leads" && params.get("converted") === "1") {
    filters.push(["converted_client_id", "notIs", null]);
  }
  return filters;
}

async function relationLabelsFor(moduleKey, rows) {
  const relations = {
    projects: { client_id: ["clients", "name"] },
    tasks: { project_id: ["projects", "title"], client_id: ["clients", "name"] },
    invoices: { client_id: ["clients", "name"] },
    payments: { invoice_id: ["invoices", "invoice_number"] },
    deliverables: { project_id: ["projects", "title"] },
    revisions: { deliverable_id: ["deliverables", "title"] }
  }[moduleKey] || {};
  const labels = new Map();
  for (const [column, [table, labelColumn]] of Object.entries(relations)) {
    const ids = [...new Set(rows.map((row) => row[column]).filter(Boolean))];
    if (!ids.length) continue;
    const { data, error } = await supabase.from(table).select(`id,${labelColumn}`)
      .eq("workspace_id", state.workspace.id).in("id", ids);
    if (error) throw error;
    labels.set(column, new Map((data ?? []).map((row) => [row.id, row[labelColumn]])));
  }
  return labels;
}

async function renderModule(content, moduleKey, params = new URLSearchParams()) {
  const definition = MODULES[moduleKey];
  const requestedSearch = params.get("search") || searchText;
  const sort = sortState[moduleKey] || { column: "created_at", ascending: false };
  const { rows, count } = await recordService.list(moduleKey, state.workspace.id, {
    search: requestedSearch, page: pageIndex, pageSize: PAGE_SIZE,
    filters: moduleFilters(moduleKey, params), orderBy: sort.column, ascending: sort.ascending
  });
  const relationLabels = await relationLabelsFor(moduleKey, rows);
  content.replaceChildren();
  const heading = el("div", undefined, "page-heading");
  const titleGroup = document.createElement("div");
  titleGroup.append(el("h1", definition.title), el("p", definition.description, "muted"));
  const create = el("button", `New ${definition.title.slice(0, -1)}`, "button");
  create.type = "button";
  create.addEventListener("click", () => showRecordForm(moduleKey).catch((error) => notify(friendlyError(error), true)));
  heading.append(titleGroup, create);
  content.append(heading);
  const panel = el("section", undefined, "panel");
  const toolbar = el("div", undefined, "toolbar");
  const search = el("input", undefined, "search-input");
  search.type = "search";
  search.placeholder = `Search ${definition.title.toLowerCase()}…`;
  search.setAttribute("aria-label", `Search ${definition.title.toLowerCase()}`);
  search.value = requestedSearch;
  search.addEventListener("input", () => {
    searchText = search.value;
    pageIndex = 0;
    window.clearTimeout(search._timeout);
    search._timeout = window.setTimeout(async () => {
      const focused = document.activeElement === search;
      const cursor = focused ? search.selectionStart : null;
      try {
        await renderModule(content, moduleKey, params);
        const replacement = content.querySelector(".toolbar input[type=search]");
        if (focused && replacement) {
          replacement.focus();
          if (cursor !== null) replacement.setSelectionRange(cursor, cursor);
        }
      } catch (error) {
        notify(friendlyError(error), true);
      }
    }, 250);
  });
  toolbar.append(search, el("span", `${count} record${count === 1 ? "" : "s"}`, "muted"));
  const statusField = definition.fields.find((field) => field[0] === "status");
  if (statusField?.[4]) {
    const statusSelect = document.createElement("select");
    statusSelect.className = "search-input status-filter";
    statusSelect.setAttribute("aria-label", `Filter ${definition.title.toLowerCase()} by status`);
    const allOption = el("option", "All statuses");
    allOption.value = "";
    statusSelect.append(allOption);
    for (const status of statusField[4]) {
      const option = el("option", status.replaceAll("_", " "));
      option.value = status;
      statusSelect.append(option);
    }
    statusSelect.value = params.get("status") || "";
    statusSelect.addEventListener("change", () => {
      const nextParams = new URLSearchParams(params);
      if (statusSelect.value) nextParams.set("status", statusSelect.value);
      else nextParams.delete("status");
      const query = nextParams.toString();
      window.location.hash = `#/${moduleKey}${query ? `?${query}` : ""}`;
    });
    toolbar.append(statusSelect);
  }
  panel.append(toolbar);
  if (moduleKey === "whatsapp") return;
  if (!rows.length) {
    const emptyMessage = moduleKey === "payments"
      ? "No payments recorded. Invoices are not payments: issue an invoice, then record money received against it."
      : `No ${definition.title.toLowerCase()} found. Create a record to get started.`;
    panel.append(el("div", emptyMessage, "empty-state"));
  } else {
    const wrap = el("div", undefined, "table-wrap");
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const header = document.createElement("tr");
    for (const column of [...definition.columns, "actions"]) {
      const th = document.createElement("th");
      if (column !== "actions" && column !== "task_progress") {
        const sortButton = el("button", column.replaceAll("_", " "), "sort-button");
        sortButton.type = "button";
        sortButton.setAttribute("aria-label", `Sort by ${column.replaceAll("_", " ")}`);
        sortButton.addEventListener("click", () => {
          sortState[moduleKey] = {
            column,
            ascending: sort.column === column ? !sort.ascending : true
          };
          renderModule(content, moduleKey, params).catch((error) => notify(friendlyError(error), true));
        });
        if (sort.column === column) sortButton.append(el("span", sort.ascending ? " ↑" : " ↓", "sort-indicator"));
        th.append(sortButton);
      } else {
        th.textContent = column === "actions" ? "Actions" : column.replaceAll("_", " ");
      }
      header.append(th);
    }
    thead.append(header);
    table.append(thead);
    const body = document.createElement("tbody");
    for (const record of rows) {
      const row = document.createElement("tr");
      for (const column of definition.columns) {
        const value = moduleKey === "invoices" && column === "status"
          && ["issued", "partially_paid"].includes(record.status)
          && record.due_date && record.due_date < workspaceToday()
          ? "overdue (computed from due date)"
          : relationLabels.get(column)?.get(record[column]) || displayValue(moduleKey, column, record[column]);
        row.append(el("td", value));
      }
      const actionCell = document.createElement("td");
      const actions = el("div", undefined, "row-actions");
      if (["leads", "clients", "projects", "invoices", "deliverables", "payments"].includes(moduleKey)) {
        const view = el("button", "View", "small-button");
        view.type = "button";
        view.addEventListener("click", () =>
          showRecordDetails(moduleKey, record).catch((error) => notify(friendlyError(error), true)));
        actions.append(view);
      }
      const canEdit = moduleKey !== "payments" && (moduleKey !== "invoices" || record.status === "draft");
      if (canEdit) {
        const edit = el("button", "Edit", "small-button");
        edit.type = "button";
        edit.addEventListener("click", () => showRecordForm(moduleKey, record).catch((error) => notify(friendlyError(error), true)));
        actions.append(edit);
      }
      if (moduleKey === "leads" && !record.converted_client_id && record.status !== "archived") {
        const convert = el("button", "Convert", "small-button");
        convert.type = "button";
        convert.addEventListener("click", async () => {
          if (!window.confirm(`Convert ${record.contact_name} into a client? The lead and its history will be preserved.`)) return;
          convert.disabled = true;
          try {
            await recordService.convertLead(state.workspace.id, record.id);
            notify("Lead converted to a client.");
            await loadPage("leads", params);
          } catch (error) {
            notify(friendlyError(error), true);
            convert.disabled = false;
          }
        });
        actions.append(convert);
        const archive = el("button", "Archive", "small-button");
        archive.type = "button";
        archive.addEventListener("click", async () => {
          if (!window.confirm(`Archive ${record.contact_name}?`)) return;
          try {
            await recordService.update("leads", state.workspace.id, record.id, { status: "archived" });
            notify("Lead archived.");
            await loadPage("leads", params);
          } catch (error) {
            notify(friendlyError(error), true);
          }
        });
        actions.append(archive);
      }
      if (moduleKey === "invoices" && record.status === "draft") {
        const line = el("button", "Add line", "small-button");
        line.type = "button";
        line.addEventListener("click", () => addInvoiceLine(record));
        actions.append(line);
      }
      if (moduleKey === "invoices" && record.status === "draft") {
        const issue = el("button", "Issue", "small-button");
        issue.type = "button";
        issue.addEventListener("click", async () => {
          if (!window.confirm(`Issue invoice ${record.invoice_number}? Its line items and totals will then be locked.`)) return;
          try {
            await recordService.issueInvoice(state.workspace.id, record.id);
            notify("Invoice issued.");
            await loadPage("invoices", params);
          } catch (error) {
            notify(friendlyError(error), true);
          }
        });
        actions.append(issue);
      }
      if (moduleKey === "invoices" && ["issued", "partially_paid", "overdue"].includes(record.status)) {
        const recordPayment = el("button", "Record payment", "small-button");
        recordPayment.type = "button";
        recordPayment.addEventListener("click", () =>
          showRecordForm("payments", null, { invoice_id: record.id })
            .catch((error) => notify(friendlyError(error), true)));
        actions.append(recordPayment);
        const cancel = el("button", "Cancel invoice", "small-button");
        cancel.type = "button";
        cancel.addEventListener("click", async () => {
          if (!window.confirm(`Cancel invoice ${record.invoice_number}? It must have no active payments.`)) return;
          try {
            await recordService.cancelInvoice(state.workspace.id, record.id);
            notify("Invoice cancelled.");
            await loadPage("invoices", params);
          } catch (error) {
            notify(friendlyError(error), true);
          }
        });
        actions.append(cancel);
      }
      if (moduleKey === "payments" && !record.reversed_at) {
        const refund = el("button", "Refund", "small-button");
        refund.type = "button";
        refund.addEventListener("click", () => refundPayment(record));
        actions.append(refund);
        const reverse = el("button", "Reverse", "small-button");
        reverse.type = "button";
        reverse.addEventListener("click", async () => {
          if (!window.confirm("Mark this payment as reversed? This updates the invoice balance.")) return;
          try {
            await recordService.update("payments", state.workspace.id, record.id, { reversed_at: new Date().toISOString() });
            notify("Payment reversed.");
            await loadPage("payments", params);
          } catch (error) {
            notify(friendlyError(error), true);
          }
        });
        actions.append(reverse);
      }
      const canDelete = moduleKey !== "payments"
        && (moduleKey !== "invoices" || record.status === "draft")
        && !(moduleKey === "leads" && record.converted_client_id);
      if (canDelete) {
        const remove = el("button", "Delete", "small-button");
        remove.type = "button";
        remove.addEventListener("click", async () => {
          if (!window.confirm(`Delete this ${definition.title.slice(0, -1).toLowerCase()}?`)) return;
          try {
            await recordService.remove(moduleKey, state.workspace.id, record.id);
            notify("Record deleted.");
            await loadPage(moduleKey, params);
          } catch (error) {
            notify(friendlyError(error), true);
          }
        });
        actions.append(remove);
      }
      actionCell.append(actions);
      row.append(actionCell);
      body.append(row);
    }
    table.append(body);
    wrap.append(table);
    panel.append(wrap);
  }
  const pagination = el("div", undefined, "pagination");
  const back = el("button", "Previous", "button secondary");
  back.type = "button";
  back.disabled = pageIndex === 0;
  back.addEventListener("click", () => { pageIndex -= 1; renderModule(content, moduleKey, params).catch((error) => notify(friendlyError(error), true)); });
  const next = el("button", "Next", "button secondary");
  next.type = "button";
  next.disabled = (pageIndex + 1) * PAGE_SIZE >= count;
  next.addEventListener("click", () => { pageIndex += 1; renderModule(content, moduleKey, params).catch((error) => notify(friendlyError(error), true)); });
  pagination.append(back, el("span", `Page ${pageIndex + 1} of ${Math.max(1, Math.ceil(count / PAGE_SIZE))}`), next);
  panel.append(pagination);
  content.append(panel);
}

async function renderReports(content, startDate, endDate) {
  const end = endDate || workspaceToday();
  const start = startDate || (() => {
    const date = new Date(`${end}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 365);
    return date.toISOString().slice(0, 10);
  })();
  const nextDate = new Date(`${end}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const [data, metrics] = await Promise.all([
    relationshipService.reports(
      state.workspace.id,
      workspaceDateTimeToIso(`${start}T00:00`),
      workspaceDateTimeToIso(`${nextDate.toISOString().slice(0, 10)}T00:00`),
      start,
      end
    ),
    recordService.dashboard(state.workspace.id)
  ]);
  const issuedInvoices = data.invoices.filter((invoice) => !["draft", "cancelled"].includes(invoice.status));
  const invoiced = issuedInvoices.reduce((total, invoice) => total + BigInt(invoice.total_minor), 0n);
  const collected = data.payments
    .filter((payment) => !payment.reversed_at)
    .reduce((total, payment) => total + BigInt(payment.amount_minor), 0n)
    - data.adjustments.reduce((total, adjustment) => total + BigInt(adjustment.amount_minor), 0n);

  const sources = new Map();
  for (const lead of data.leads) {
    const key = lead.source?.trim() || "Unspecified";
    const counts = sources.get(key) || { total: 0, converted: 0 };
    counts.total += 1;
    if (lead.status === "won") counts.converted += 1;
    sources.set(key, counts);
  }
  const sourceRows = [...sources.entries()].sort((a, b) => b[1].total - a[1].total);
  const projectStatuses = new Map();
  for (const project of data.projects) projectStatuses.set(project.status, (projectStatuses.get(project.status) || 0) + 1);

  const months = new Map();
  const addMonthly = (date, key, value) => {
    if (!date) return;
    const month = String(date).slice(0, 7);
    const summary = months.get(month) || { invoiced: 0n, collected: 0n };
    summary[key] += value;
    months.set(month, summary);
  };
  for (const invoice of issuedInvoices) addMonthly(invoice.issue_date, "invoiced", BigInt(invoice.total_minor));
  for (const payment of data.payments) {
    if (!payment.reversed_at) addMonthly(payment.paid_at, "collected", BigInt(payment.amount_minor));
  }
  for (const adjustment of data.adjustments) {
    addMonthly(adjustment.created_at, "collected", -BigInt(adjustment.amount_minor));
  }
  const monthRows = [...months.entries()].sort(([a], [b]) => a.localeCompare(b));
  const maximum = monthRows.reduce((best, [, entry]) =>
    [entry.invoiced, entry.collected].reduce((inner, value) => value > inner ? value : inner, best), 1n);

  content.innerHTML = `
    <div class="page-heading"><div><h1>Reports</h1><p>Workspace-scoped totals for the selected period.</p></div></div>
    <section class="panel">
      <form id="report-filter" class="inline">
        <label class="field"><span>Start date</span><input type="date" name="start" value="${escapeHtml(start)}" required></label>
        <label class="field"><span>End date</span><input type="date" name="end" value="${escapeHtml(end)}" required></label>
        <button class="button" type="submit">Apply dates</button>
        <button class="button secondary" id="export-report" type="button">Export CSV</button>
      </form>
    </section>
    <section class="metric-grid">
      ${metric("Leads created", data.leads.length, "leads")}
      ${metric("Lead conversion", `${data.leads.length ? (data.leads.filter((item) => item.status === "won").length / data.leads.length * 100).toFixed(1) : "0.0"}%`, "leads?converted=1")}
      ${metric("New clients", data.clients.length, "clients")}
      ${metric("Projects started", data.projects.length, "projects")}
      ${metric("Tasks completed", data.tasks.filter((item) => item.status === "done").length, "tasks")}
      ${metric("Overdue tasks", metrics.overdueTasks, "tasks?overdue=1")}
      ${metric("Invoiced in period", money(invoiced), "invoices")}
      ${metric("Payments recorded", money(collected), "payments")}
      ${metric("Outstanding receivables", money(metrics.outstanding), "invoices?outstanding=1")}
    </section>
    <section class="panel"><h2>Monthly invoiced and collected</h2>
      ${monthRows.length ? `<div class="chart-list">${monthRows.map(([month, values]) => {
        const invoiceWidth = Math.max(1, Number(values.invoiced * 100n / maximum));
        const paymentWidth = Math.max(1, Number(values.collected * 100n / maximum));
        return `<div class="chart-row"><strong>${escapeHtml(month)}</strong><div class="chart-track"><span class="chart-bar invoiced-bar" style="width:${invoiceWidth}%"></span></div><span>${escapeHtml(money(values.invoiced))}</span><div class="chart-track"><span class="chart-bar collected-bar" style="width:${paymentWidth}%"></span></div><span>${escapeHtml(money(values.collected))}</span></div>`;
      }).join("")}</div><p class="muted chart-legend">Navy: invoiced · cyan: recorded cash collected. Reversed payments are excluded.</p>` : `<p class="empty-state">No invoices or payments in this date range.</p>`}
    </section>
    <section class="panel"><h2>Lead sources and conversion</h2>
      ${sourceRows.length ? `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Leads</th><th>Converted</th><th>Conversion rate</th></tr></thead><tbody>${sourceRows.map(([name, totals]) => `<tr><td>${escapeHtml(name)}</td><td>${totals.total}</td><td>${totals.converted}</td><td>${(totals.converted / totals.total * 100).toFixed(1)}%</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty-state">No leads in this date range.</p>`}
    </section>
    <section class="panel"><h2>Project delivery</h2><p>${escapeHtml([...projectStatuses.entries()].map(([status, count]) => `${status.replaceAll("_", " ")}: ${count}`).join(" · ") || "No projects in this date range.")}</p><p class="muted">Task completion is based on tasks marked done. Project progress in the project list uses completed tasks divided by all project tasks; projects with no tasks show 0%.</p></section>
    <section class="panel"><h2>Financial definitions</h2><p><strong>Invoiced</strong> sums issued/partially paid/paid invoices by issue date and excludes drafts and cancellations. <strong>Net payments recorded</strong> subtracts recorded refunds from non-reversed CRM payment entries; it is not payment-provider settlement. Refunds are grouped by refund date. <strong>Outstanding receivables</strong> is the current workspace balance after payments/refunds, not restricted to the selected period. Reversed payments reflect current record state and are excluded from their original payment-date bucket.</p></section>`;

  content.querySelector("#report-filter").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (String(form.get("start")) > String(form.get("end"))) {
      notify("Start date must be on or before the end date.", true);
      return;
    }
    renderReports(content, String(form.get("start")), String(form.get("end")))
      .catch((error) => notify(friendlyError(error), true));
  });
  content.querySelector("#export-report").addEventListener("click", () => {
    const records = [
      ...data.leads.map((item) => ({ type: "lead", date: item.created_at, status: item.status, amount_minor: "", source: item.source || "" })),
      ...data.invoices.map((item) => ({ type: "invoice", date: item.issue_date, status: item.status, amount_minor: item.total_minor, source: "" })),
      ...data.payments.map((item) => ({ type: "payment", date: item.paid_at, status: item.reversed_at ? "reversed" : "recorded", amount_minor: item.amount_minor, source: "" })),
      ...data.adjustments.map((item) => ({ type: "refund", date: item.created_at, status: "recorded", amount_minor: `-${item.amount_minor}`, source: "" })),
      ...data.projects.map((item) => ({ type: "project", date: item.created_at, status: item.status, amount_minor: "", source: "" })),
      ...data.tasks.map((item) => ({ type: "task", date: item.created_at, status: item.status, amount_minor: "", source: "" }))
    ];
    const columns = ["type", "date", "status", "amount_minor", "source"];
    const csvCell = (value) => {
      let safe = String(value ?? "");
      if (/^[=+\-@]/.test(safe)) safe = `'${safe}`;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const csv = [columns.join(","), ...records.map((record) => columns.map((column) => csvCell(record[column])).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const link = el("a");
    link.href = url;
    link.download = `graphiyy-report-${start}-to-${end}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function renderWhatsApp(content) {
  content.innerHTML = `
    <div class="page-heading"><div><h1>WhatsApp Business</h1><p>Official provider integration setup</p></div></div>
    <section class="panel">
      <div class="notice-panel"><strong>Setup required — not connected.</strong><p style="margin:.5rem 0 0">No messages are sent or simulated from this frontend. Connect the official WhatsApp Business Platform through separately deployed, signature-validating Supabase Edge Functions before enabling messaging.</p></div>
      <h2 style="margin-top:1.2rem">What an administrator must configure</h2>
      <ol><li>WhatsApp Business account and approved phone number.</li><li>Server-side Edge Function secrets for provider credentials (never browser or GitHub files).</li><li>Webhook URL, verification token, and signature validation in the backend function.</li><li>Workspace authorization and client association before sending or storing messages.</li></ol>
      <p class="muted">Credentials, webhook processing, message sending, and message-status updates are not implemented in this initial workspace foundation.</p>
    </section>`;
}

async function renderSettings(content) {
  const isAdmin = state.membershipRole === "owner" || state.membershipRole === "admin";
  const [settings, members] = await Promise.all([
    workspaceService.getSettings(state.workspace.id),
    relationshipService.members(state.workspace.id)
  ]);
  content.innerHTML = `
    <div class="page-heading"><div><h1>Workspace settings</h1><p>Membership and integration administration</p></div></div>
    <section class="panel">
      <h2>${escapeHtml(state.workspace.name)}</h2>
      <p>Signed in as <strong>${escapeHtml(state.session.user.email)}</strong> with role <strong>${escapeHtml(state.membershipRole)}</strong>.</p>
      ${isAdmin ? `<form id="workspace-settings-form" class="inline">
        <label class="field"><span>Currency</span><select name="currency_code" required>${["USD","INR","EUR","GBP","CAD","AUD","JPY"].map((code) => `<option value="${code}" ${settings.currency_code === code ? "selected" : ""}>${code}</option>`).join("")}</select></label>
        <label class="field"><span>Timezone</span><input name="timezone" value="${escapeHtml(settings.timezone)}" required maxlength="64"></label>
        <button class="button" type="submit">Save settings</button>
      </form>` : `<p>Currency: <strong>${escapeHtml(settings.currency_code)}</strong> · Timezone: <strong>${escapeHtml(settings.timezone)}</strong></p>`}
    </section>
    <section class="panel"><h2>Workspace members</h2>
      ${members.length ? `<div class="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th>Joined</th>${isAdmin ? "<th>Action</th>" : ""}</tr></thead><tbody>${members.map((member) => `<tr><td>${escapeHtml(member.display_name)}${member.user_id === state.session.user.id ? " (you)" : ""}</td><td>${escapeHtml(member.role)}</td><td>${formatWorkspaceDate(member.created_at)}</td>${isAdmin ? `<td>${member.user_id !== state.session.user.id || state.membershipRole === "owner" ? `<button class="small-button remove-member" data-user-id="${escapeHtml(member.user_id)}" type="button">Remove</button>` : "—"}</td>` : ""}</tr>`).join("")}</tbody></table></div>` : `<p class="empty-state">No members are listed.</p>`}
    </section>
    ${isAdmin ? `<section class="panel"><h2>Invite a member</h2>
      <p class="muted">Existing accounts are added to this workspace immediately. New accounts receive a Supabase invitation email. Workspace permissions are checked by the Edge Function.</p>
      <form id="invite-form" class="inline">
        <label class="field"><span>Email</span><input name="email" type="email" required maxlength="254"></label>
        <label class="field"><span>Role</span><select name="role"><option value="member">Member</option>${state.membershipRole === "owner" ? '<option value="admin">Admin</option>' : ""}</select></label>
        <button class="button" type="submit">Add or invite member</button>
      </form>
    </section>` : ""}
    <section class="panel"><h2>WhatsApp Business</h2><p class="muted">Setup required. Credentials and messaging remain disabled until secured server-side Edge Functions and provider verification are configured.</p></section>`;

  content.querySelector("#workspace-settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    const form = new FormData(event.currentTarget);
    const timezone = String(form.get("timezone")).trim();
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      notify("Enter a valid IANA timezone, such as UTC or Asia/Kolkata.", true);
      button.disabled = false;
      return;
    }
    try {
      const updated = await workspaceService.updateSettings(state.workspace.id, {
        currency_code: String(form.get("currency_code")),
        timezone
      });
      activeCurrency = updated.currency_code;
      activeTimezone = updated.timezone;
      notify("Workspace settings saved.");
      await renderSettings(content);
    } catch (error) {
      notify(friendlyError(error), true);
      button.disabled = false;
    }
  });
  content.querySelector("#invite-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    const form = new FormData(event.currentTarget);
    try {
      const result = await relationshipService.invite(state.workspace.id, String(form.get("email")), String(form.get("role")));
      notify(result.message);
      await renderSettings(content);
    } catch (error) {
      notify(friendlyError(error), true);
      button.disabled = false;
    }
  });
  content.querySelectorAll(".remove-member").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("Remove this member from the active workspace?")) return;
      button.disabled = true;
      try {
        await relationshipService.removeMember(state.workspace.id, button.dataset.userId);
        notify("Workspace member removed.");
        if (button.dataset.userId === state.session.user.id) {
          clearWorkspace();
          closeRealtime();
          await render();
        } else await renderSettings(content);
      } catch (error) {
        notify(friendlyError(error), true);
        button.disabled = false;
      }
    });
  });
}

async function initialize() {
  const returnedFromVerification = new URLSearchParams(window.location.search).get("auth") === "verified";
  authService.onChange((session, event) => {
    const wasSignedIn = Boolean(state.session);
    state.session = session;
    if (!session) {
      clearWorkspace();
      if (wasSignedIn && event === "SIGNED_OUT") authNotice = "You have been signed out.";
    }
    window.setTimeout(() => render().catch((error) => {
      root.replaceChildren(el("main", friendlyError(error), "auth-screen"));
    }), 0);
  });
  window.addEventListener("hashchange", () => {
    pageIndex = 0;
    searchText = "";
    render().catch((error) => notify(friendlyError(error), true));
  });
  const { data, error } = await authService.getSession();
  if (error) throw error;
  state.session = data.session;
  if (returnedFromVerification) {
    authNotice = data.session?.user?.email_confirmed_at
      ? "Email confirmed. Your account is ready."
      : "If your email was just confirmed, sign in to continue. Otherwise, use the verification link from your inbox.";
  }
  await render();
}

initialize().catch((error) => {
  root.replaceChildren(el("main", friendlyError(error), "auth-screen"));
});
