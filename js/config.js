import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const SUPABASE_URL = "https://ipnreuybteartgcqxqnd.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_I4KTWdU1f_gJ2A513icCCw_dFgnvWTf";

if (new URL(SUPABASE_URL).hostname !== "ipnreuybteartgcqxqnd.supabase.co") {
  throw new Error("The configured Supabase URL does not match the verified project.");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
});
