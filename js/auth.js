import { supabase } from "./config.js";

export const authService = {
  getSession() {
    return supabase.auth.getSession();
  },
  onChange(callback) {
    return supabase.auth.onAuthStateChange((event, session) => callback(session, event));
  },
  signUp(email, password, displayName) {
    const redirectTo = `${window.location.origin}${window.location.pathname}?auth=verified`;
    return supabase.auth.signUp({
      email,
      password,
      options: { data: { name: displayName }, emailRedirectTo: redirectTo }
    });
  },
  signIn(email, password) {
    return supabase.auth.signInWithPassword({ email, password });
  },
  signOut() {
    return supabase.auth.signOut();
  },
  resetPassword(email) {
    const redirectTo = `${window.location.origin}${window.location.pathname}?auth=reset`;
    return supabase.auth.resetPasswordForEmail(email, { redirectTo });
  },
  updatePassword(password) {
    return supabase.auth.updateUser({ password });
  }
};
