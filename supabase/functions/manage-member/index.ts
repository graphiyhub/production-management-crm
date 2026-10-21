import { createClient } from "npm:@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function respond(status: number, message: string, success = false) {
  return new Response(JSON.stringify({ success, message }), { status, headers });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return respond(405, "Use POST to manage a workspace member.");

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return respond(401, "Sign in before managing members.");
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    console.error("Member-management function is missing server-side configuration.");
    return respond(503, "Member management is not configured on the server.");
  }

  let input: { workspaceId?: unknown; userId?: unknown; action?: unknown };
  try {
    input = await request.json();
  } catch {
    return respond(400, "Provide a valid member-management request.");
  }
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : "";
  const targetId = typeof input.userId === "string" ? input.userId : "";
  if (input.action !== "remove"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
    return respond(400, "Provide a valid workspace, user, and remove action.");
  }

  const userClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authorization } }
  });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return respond(401, "Your session is invalid or has expired.");

  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { error: removalError } = await adminClient.rpc("remove_workspace_member", {
    target_workspace: workspaceId,
    target_user: targetId,
    actor_id: authData.user.id
  });
  if (removalError) {
    console.error("Could not remove workspace member.", removalError.message);
    const status = removalError.code === "42501" ? 403
      : removalError.code === "P0002" ? 404
      : removalError.code === "23514" ? 409 : 500;
    return respond(status, removalError.message || "The workspace member could not be removed.");
  }
  return respond(200, "Workspace member removed.", true);
});
