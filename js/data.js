import { supabase } from "./config.js";

async function fetchAllRows(makeQuery, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await makeQuery().range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return rows;
  }
}

export const MODULES = {
  leads: {
    title: "Leads", table: "leads", description: "Track prospects through your agency pipeline.",
    columns: ["contact_name", "company_name", "email", "status", "priority", "follow_up_at"],
    fields: [
      ["contact_name", "Contact name", "text", true], ["company_name", "Company", "text"],
      ["email", "Email", "email"], ["phone", "Phone", "tel"], ["source", "Source", "text"],
      ["status", "Status", "select", false, ["new", "contacted", "qualified", "proposal", "lost"]],
      ["priority", "Priority", "select", false, ["low", "normal", "high"]],
      ["estimated_value_minor", "Estimated value (minor units)", "number"],
      ["owner_id", "Lead owner", "relation", false, "members"],
      ["follow_up_at", "Follow-up date", "date"], ["notes", "Notes", "textarea"]
    ], search: ["contact_name", "company_name", "email", "phone"]
  },
  clients: {
    title: "Clients", table: "clients", description: "Agency client accounts and contact details.",
    columns: ["name", "company_name", "email", "phone", "status"],
    fields: [
      ["name", "Contact name", "text", true], ["company_name", "Company", "text"],
      ["email", "Email", "email"], ["phone", "Phone", "tel"], ["website", "Website", "url"],
      ["business_info", "Business information", "textarea"],
      ["status", "Status", "select", false, ["active", "inactive", "archived"]],
      ["account_manager_id", "Account manager", "relation", false, "members"]
    ], search: ["name", "company_name", "email", "phone"]
  },
  projects: {
    title: "Projects", table: "projects", description: "Client-linked work, budgets, and delivery dates.",
    columns: ["title", "client_id", "service_category", "status", "priority", "due_date", "task_progress"],
    fields: [
      ["title", "Project title", "text", true], ["client_id", "Client", "relation", true, "clients"],
      ["description", "Description", "textarea"],
      ["service_category", "Service", "select", false, ["graphic_design", "video_editing", "social_media", "advertising", "website_design", "marketing", "other"]],
      ["status", "Status", "select", false, ["planning", "active", "on_hold", "completed", "cancelled"]],
      ["priority", "Priority", "select", false, ["low", "normal", "high"]],
      ["budget_minor", "Budget (minor units)", "number"], ["start_date", "Start date", "date"],
      ["due_date", "Deadline", "date"], ["owner_id", "Project owner", "relation", false, "members"]
    ], search: ["title", "description"]
  },
  tasks: {
    title: "Tasks", table: "tasks", description: "Team tasks, deadlines, and completion tracking.",
    columns: ["title", "project_id", "client_id", "status", "priority", "due_at"],
    fields: [
      ["title", "Task title", "text", true], ["description", "Description", "textarea"],
      ["project_id", "Project (optional)", "relation", false, "projects"],
      ["client_id", "Client (optional)", "relation", false, "clients"],
      ["status", "Status", "select", false, ["todo", "in_progress", "done", "cancelled"]],
      ["priority", "Priority", "select", false, ["low", "normal", "high"]],
      ["assigned_to", "Assigned member", "relation", false, "members"],
      ["due_at", "Due date", "datetime-local"]
    ], search: ["title", "description"]
  },
  invoices: {
    title: "Invoices", table: "invoices", description: "Invoices and accounts receivable in minor currency units.",
    columns: ["invoice_number", "client_id", "issue_date", "due_date", "status", "total_minor"],
    fields: [
      ["invoice_number", "Invoice number", "text", true],
      ["client_id", "Client", "relation", true, "clients"],
      ["project_id", "Project (optional)", "relation", false, "projects"],
      ["issue_date", "Issue date", "date"], ["due_date", "Due date", "date"],
      ["discount_minor", "Discount (minor units)", "number"],
      ["tax_minor", "Tax (minor units)", "number"], ["notes", "Notes", "textarea"]
    ], search: ["invoice_number", "notes"]
  },
  payments: {
    title: "Payments", table: "payments", description: "Recorded invoice payments; database rules prevent overpayment.",
    columns: ["invoice_id", "amount_minor", "method", "paid_at", "reference", "reversed_at"],
    fields: [
      ["invoice_id", "Invoice", "relation", true, "invoices"],
      ["amount_minor", "Amount (minor units)", "number", true],
      ["method", "Method", "select", false, ["cash", "bank_transfer", "card", "paypal", "other"]],
      ["paid_at", "Payment date", "datetime-local"], ["reference", "Reference", "text"], ["notes", "Notes", "textarea"]
    ], search: ["reference", "notes"]
  },
  deliverables: {
    title: "Deliverables", table: "deliverables", description: "Track project assets through review and approval.",
    columns: ["title", "project_id", "status", "due_date"],
    fields: [
      ["title", "Deliverable title", "text", true],
      ["project_id", "Project", "relation", true, "projects"],
      ["status", "Status", "select", false, ["pending", "in_review", "approved", "changes_requested"]],
      ["due_date", "Due date", "date"]
    ], search: ["title"]
  },
  revisions: {
    title: "Revisions", table: "revisions", description: "Track requested changes against deliverables.",
    columns: ["deliverable_id", "description", "status", "created_at"],
    fields: [
      ["deliverable_id", "Deliverable", "relation", true, "deliverables"],
      ["description", "Requested changes", "textarea", true],
      ["status", "Status", "select", false, ["requested", "in_progress", "completed"]]
    ], search: ["description"]
  }
};

export const relationshipService = {
  async related(table, workspaceId, column, id, fields = "*") {
    return fetchAllRows(() => supabase.from(table).select(fields)
      .eq("workspace_id", workspaceId).eq(column, id)
      .order("created_at", { ascending: false }).order("id", { ascending: true }));
  },
  async activities(workspaceId, entityType, entityId = null, limit = 8) {
    let query = supabase.from("activities").select("id,actor_id,entity_type,entity_id,action,details,created_at")
      .eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(limit);
    if (entityType) query = query.eq("entity_type", entityType);
    if (entityId) query = query.eq("entity_id", entityId);
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  },
  async addClientNote(workspaceId, clientId, body) {
    const { data, error } = await supabase.from("client_notes").insert({
      workspace_id: workspaceId, client_id: clientId, body
    }).select("*").single();
    if (error) throw error;
    return data;
  },
  async addLeadActivity(workspaceId, leadId, activityType, note) {
    const { data, error } = await supabase.from("lead_activities").insert({
      workspace_id: workspaceId,
      lead_id: leadId,
      activity_type: activityType,
      details: { note }
    }).select("*").single();
    if (error) throw error;
    return data;
  },
  async reports(workspaceId, startAt, endAt, startDate, endDate) {
    const [leadsResult, clientsResult, invoicesResult, paymentsResult, adjustmentsResult, projectsResult, tasksResult] = await Promise.all([
      fetchAllRows(() => supabase.from("leads").select("id,status,source,created_at").eq("workspace_id", workspaceId).gte("created_at", startAt).lt("created_at", endAt).order("id")),
      fetchAllRows(() => supabase.from("clients").select("id,status,created_at").eq("workspace_id", workspaceId).gte("created_at", startAt).lt("created_at", endAt).order("id")),
      fetchAllRows(() => supabase.from("invoices").select("id,status,total_minor,issue_date,due_date").eq("workspace_id", workspaceId).gte("issue_date", startDate).lte("issue_date", endDate).order("id")),
      fetchAllRows(() => supabase.from("payments").select("id,amount_minor,paid_at,reversed_at").eq("workspace_id", workspaceId).gte("paid_at", startAt).lt("paid_at", endAt).order("id")),
      fetchAllRows(() => supabase.from("payment_adjustments").select("id,payment_id,amount_minor,created_at").eq("workspace_id", workspaceId).eq("adjustment_type", "refund").gte("created_at", startAt).lt("created_at", endAt).order("id")),
      fetchAllRows(() => supabase.from("projects").select("id,status,created_at,due_date").eq("workspace_id", workspaceId).gte("created_at", startAt).lt("created_at", endAt).order("id")),
      fetchAllRows(() => supabase.from("tasks").select("id,status,created_at,due_at,completed_at").eq("workspace_id", workspaceId).gte("created_at", startAt).lt("created_at", endAt).order("id"))
    ]);
    return {
      leads: leadsResult,
      clients: clientsResult,
      invoices: invoicesResult,
      payments: paymentsResult,
      adjustments: adjustmentsResult,
      projects: projectsResult,
      tasks: tasksResult
    };
  },
  async members(workspaceId) {
    const { data: memberships, error } = await supabase.from("workspace_memberships")
      .select("workspace_id,user_id,role,created_at").eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const userIds = (memberships ?? []).map((item) => item.user_id);
    if (!userIds.length) return [];
    const { data: profiles, error: profilesError } = await supabase.from("profiles")
      .select("id,display_name").in("id", userIds);
    if (profilesError) throw profilesError;
    const byId = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    return (memberships ?? []).map((membership) => ({
      ...membership, display_name: byId.get(membership.user_id)?.display_name || "Workspace member"
    }));
  },
  async removeMember(workspaceId, userId) {
    const { data, error } = await supabase.functions.invoke("manage-member", {
      body: { workspaceId, userId, action: "remove" }
    });
    if (error?.context instanceof Response) {
      const payload = await error.context.json().catch(() => null);
      throw new Error(payload?.message || error.message);
    }
    if (error) throw error;
    if (!data?.success) throw new Error(data?.message || "Member could not be removed.");
    return data;
  },
  async invite(workspaceId, email, role) {
    const { data, error } = await supabase.functions.invoke("invite-member", {
      body: { workspaceId, email: email.trim().toLowerCase(), role }
    });
    if (error) {
      if (error.context instanceof Response) {
        const payload = await error.context.json().catch(() => null);
        throw new Error(payload?.message || error.message);
      }
      throw error;
    }
    if (!data?.success) throw new Error(data?.message || "Member could not be added or invited.");
    return data;
  },
};

export const workspaceService = {
  async list() {
    const { data, error } = await supabase
      .from("workspace_memberships")
      .select("workspace_id, role, workspace:workspaces(id, name)")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  },
  async create(name) {
    const { data, error } = await supabase.rpc("create_workspace", { workspace_name: name });
    if (error) throw error;
    return data;
  },
  async getSettings(workspaceId) {
    const { data, error } = await supabase.from("workspace_settings")
      .select("currency_code,timezone,lead_stages").eq("workspace_id", workspaceId).single();
    if (error) throw error;
    return data;
  },
  async updateSettings(workspaceId, settings) {
    const { data, error } = await supabase.from("workspace_settings")
      .update(settings).eq("workspace_id", workspaceId)
      .select("currency_code,timezone,lead_stages").single();
    if (error) throw error;
    return data;
  }
};

export const recordService = {
  async list(moduleKey, workspaceId, {
    search = "", page = 0, pageSize = 20, filters = [], orderBy = "created_at", ascending = false
  } = {}) {
    const module = MODULES[moduleKey];
    if (!module) throw new Error("Unsupported module.");
    if (orderBy !== "created_at" && !module.columns.includes(orderBy)) orderBy = "created_at";
    let query = supabase.from(module.table).select("*", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .order(orderBy, { ascending, nullsFirst: false })
      .order("id", { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (search.trim()) {
      const safeTerm = search.trim().replace(/[^\p{L}\p{N}\s@.+_-]/gu, "");
      if (!safeTerm) return { rows: [], count: 0 };
      const expression = module.search.map((column) => `${column}.ilike.%${safeTerm}%`).join(",");
      query = query.or(expression);
    }
    for (const [column, operator, value] of filters) {
      if (operator === "notIn") query = query.not(column, "in", value);
      else if (operator === "notIs") query = query.not(column, "is", value);
      else query = query[operator](column, value);
    }
    const { data, error, count } = await query;
    if (error) throw error;
    const rows = data ?? [];
    if (moduleKey === "projects" && rows.length) {
      const tasks = await fetchAllRows(() => supabase.from("tasks")
        .select("project_id,status").eq("workspace_id", workspaceId)
        .in("project_id", rows.map((project) => project.id)).order("id"));
      const totals = new Map();
      for (const task of tasks ?? []) {
        const total = totals.get(task.project_id) ?? { count: 0, done: 0 };
        total.count += 1;
        if (task.status === "done") total.done += 1;
        totals.set(task.project_id, total);
      }
      for (const project of rows) {
        const total = totals.get(project.id) ?? { count: 0, done: 0 };
        project.task_progress = total.count ? Math.round(total.done / total.count * 100) : 0;
      }
    }
    return { rows, count: count ?? 0 };
  },
  async create(moduleKey, workspaceId, values) {
    const module = MODULES[moduleKey];
    if (!module) throw new Error("Unsupported module.");
    const { data, error } = await supabase.from(module.table)
      .insert({ ...values, workspace_id: workspaceId })
      .select("*").single();
    if (error?.code === "23505" && moduleKey === "payments" && values.idempotency_key) {
      const { data: existing, error: lookupError } = await supabase.from("payments")
        .select("*").eq("workspace_id", workspaceId).eq("idempotency_key", values.idempotency_key).single();
      if (lookupError) throw lookupError;
      return existing;
    }
    if (error) throw error;
    return data;
  },
  async update(moduleKey, workspaceId, id, values) {
    const module = MODULES[moduleKey];
    if (!module) throw new Error("Unsupported module.");
    const { data, error } = await supabase.from(module.table)
      .update(values).eq("workspace_id", workspaceId).eq("id", id)
      .select("*").single();
    if (error) throw error;
    return data;
  },
  async remove(moduleKey, workspaceId, id) {
    const module = MODULES[moduleKey];
    if (!module) throw new Error("Unsupported module.");
    const { error } = await supabase.from(module.table)
      .delete().eq("workspace_id", workspaceId).eq("id", id);
    if (error) throw error;
  },
  async convertLead(workspaceId, leadId) {
    const { data, error } = await supabase.rpc("convert_lead_to_client", {
      target_workspace: workspaceId,
      target_lead: leadId
    });
    if (error) throw error;
    return data;
  },
  async issueInvoice(workspaceId, invoiceId) {
    const { error } = await supabase.rpc("issue_invoice", {
      target_workspace: workspaceId,
      target_invoice: invoiceId
    });
    if (error) throw error;
  },
  async cancelInvoice(workspaceId, invoiceId) {
    const { error } = await supabase.rpc("cancel_invoice", {
      target_workspace: workspaceId,
      target_invoice: invoiceId
    });
    if (error) throw error;
  },
  async refundPayment(workspaceId, paymentId, amountMinor, reason, idempotencyKey) {
    const { data, error } = await supabase.rpc("refund_payment", {
      target_workspace: workspaceId,
      target_payment: paymentId,
      refund_amount_minor: amountMinor,
      refund_reason: reason,
      request_idempotency_key: idempotencyKey
    });
    if (error) throw error;
    return data;
  },
  async dashboard(workspaceId) {
    const countRows = async (table, filters = []) => {
      let query = supabase.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
      for (const [column, value] of filters) query = query.eq(column, value);
      const { count, error } = await query;
      if (error) throw error;
      return count ?? 0;
    };
    const [leads, clients, activeProjects, completedProjects] = await Promise.all([
      countRows("leads"), countRows("clients", [["status", "active"]]),
      countRows("projects", [["status", "active"]]), countRows("projects", [["status", "completed"]])
    ]);
    const { count: convertedLeads, error: convertedError } = await supabase.from("leads")
      .select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId)
      .not("converted_client_id", "is", null);
    if (convertedError) throw convertedError;
    const { data: financialRows, error: financialError } = await supabase
      .rpc("workspace_financial_totals", { target_workspace: workspaceId });
    if (financialError) throw financialError;
    const financial = financialRows?.[0] ?? {
      invoiced_minor: "0", outstanding_minor: "0", collected_minor: "0"
    };
    const { count: overdueCount, error: overdueError } = await supabase.from("tasks")
      .select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId)
      .not("status", "in", "(done,cancelled)").lt("due_at", new Date().toISOString());
    if (overdueError) throw overdueError;
    const { count: allTasks, error: tasksError } = await supabase.from("tasks")
      .select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
    if (tasksError) throw tasksError;
    const { count: upcomingTasks, error: upcomingError } = await supabase.from("tasks")
      .select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId)
      .not("status", "in", "(done,cancelled)")
      .gte("due_at", new Date().toISOString())
      .lt("due_at", new Date(Date.now() + 7 * 86400000).toISOString());
    if (upcomingError) throw upcomingError;
    return {
      leads, clients, activeProjects, completedProjects, openTasks: allTasks ?? 0,
      convertedLeads: convertedLeads ?? 0,
      conversionRate: leads ? (convertedLeads ?? 0) / leads * 100 : 0,
      upcomingTasks: upcomingTasks ?? 0,
      overdueTasks: overdueCount ?? 0,
      invoiced: BigInt(financial.invoiced_minor),
      outstanding: BigInt(financial.outstanding_minor),
      collected: BigInt(financial.collected_minor)
    };
  }
};
