export const state = {
  session: null,
  workspace: null,
  membershipRole: null
};

export function clearWorkspace() {
  state.workspace = null;
  state.membershipRole = null;
  sessionStorage.removeItem("graphiyy-active-workspace");
}
