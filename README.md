# Graphiyy CRM

Graphiyy CRM is a static, hash-routed vanilla JavaScript application backed by Supabase Auth and PostgreSQL. GitHub Pages serves only the frontend; all private business-data access depends on Supabase Row Level Security.

## Supabase project verification

The configured URL is `https://ipnreuybteartgcqxqnd.supabase.co`. The Auth health endpoint identified project reference `ipnreuybteartgcqxqnd`; a request without a key returned the expected `401 UNAUTHORIZED_MISSING_API_KEY`, and a read-only health request with the supplied publishable key returned `200`. This verifies the URL/project reference and that the publishable key is accepted, not that the database schema, Auth settings, or application workflows are configured.

The browser configuration in `js/config.js` contains only the supplied publishable key. A Supabase publishable key is not a secret. Never put a secret key, service-role key, database password, WhatsApp token, or app secret in this repository or any browser-delivered file.

## Supabase authentication setup

1. Open the Supabase project with ID `ipnreuybteartgcqxqnd`.
2. In **Project Settings → API**, copy the Project URL and publishable key. The existing values are in `js/config.js`; keep the browser configuration limited to the publishable key. Never use a secret or service-role key in browser code.
3. In **Authentication → Providers → Email**, enable email/password sign-in. Choose whether email confirmation is required; the app will prompt users to verify their email when sign-up does not return an active session.
4. In **Authentication → URL Configuration**, set the Site URL for local testing and allow these redirect URLs:
   - `http://localhost:5500/**` (VS Code Live Server default)
   - `https://YOUR-GITHUB-USER.github.io/YOUR-REPOSITORY/**`
   
   Email confirmation redirects back to the app with `?auth=verified`; password recovery uses `?auth=reset`. Open the app using `http://localhost:5500` (not `file://`) so those redirect URLs match.
5. Register an account and sign in to verify Auth. CRM workspace and business-data screens additionally require the database schema and workspace setup; this authentication-only setup does not apply SQL or alter the database.

To enable optional cross-session live updates, use **Database → Publications/Replication** to add `leads`, `clients`, `projects`, `tasks`, `invoices`, and `payments` to the `supabase_realtime` publication. The app scopes each subscription by the active workspace and removes subscriptions when switching workspaces or signing out. RLS remains the security boundary.

### Applying future database changes

The schema file is the initial setup, not a rerunnable migration bundle. For production, store each subsequent database change as a numbered migration, test it in a non-production Supabase project, review its effects, then apply it through the Supabase CLI or SQL Editor with a backup/rollback plan. Do not rerun the whole initial schema after it has been installed; statements that create policies/triggers are not all idempotent.

`supabase/seed.sql` is deliberately empty of workspace demo records. If you make development fixtures, use dedicated test accounts and never seed a real customer workspace.

## Authentication and tenancy

- Supabase Auth owns identities, sessions, email verification, and password reset.
- Each user can see only their own profile and memberships.
- Workspace-scoped queries are filtered by `workspace_id`, and RLS repeats the membership check on the database.
- Business relationships use composite workspace foreign keys so a record cannot point across workspace boundaries.
- Initial ownership assignment is only through the `create_workspace` RPC. The browser cannot directly insert or edit membership rows.
- Workspace roles are `owner`, `admin`, and `member`. Workspace members can access their workspace's CRM records; owners/admins can update settings and manage membership using the separately deployed Edge Functions. Record assignment is stored and checked against workspace membership, but is not a per-record authorization boundary.

## Run locally

No build step or package installation is required.

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000`. If Python is unavailable, use VS Code Live Server or another static HTTP server. The Supabase JS v2 package is loaded as an ES module from a CDN, so the browser needs network access to that host.

## GitHub Pages deployment

1. Create a GitHub repository and push this folder to its `main` branch.
   If Git is installed, a new local repository can be prepared with:

   ```powershell
   git init
   git add .
   git commit -m "Initial Graphiyy CRM"
   git branch -M main
   git remote add origin https://github.com/YOUR-GITHUB-USER/YOUR-REPOSITORY.git
   git push -u origin main
   ```
2. In **Settings → Pages**, choose **GitHub Actions** as the build and deployment source.
3. Update the production callback URL in Supabase as described above.
4. The workflow in `.github/workflows/deploy.yml` uploads this static site. It does not deploy schema changes or Edge Functions.
5. Verify the published repository URL and run the checks in [`TESTING.md`](./TESTING.md).

GitHub Pages cannot run trusted backend code or protect secrets. Supabase Edge Functions must be deployed separately with the Supabase CLI; configure their secrets with Supabase's secret-management commands/dashboard, never in GitHub files. WhatsApp is explicitly setup-required in this application until those backend functions and provider credentials are configured.

### Deploying workspace membership Edge Functions

The invitation/removal UI requires both functions to be deployed; it reports server configuration errors instead of pretending an invitation succeeded. Install and authenticate the Supabase CLI, then from this repository run:

```powershell
supabase login
supabase secrets set SITE_URL=https://YOUR-GITHUB-USER.github.io/YOUR-REPOSITORY --project-ref ipnreuybteartgcqxqnd
supabase functions deploy invite-member --project-ref ipnreuybteartgcqxqnd
supabase functions deploy manage-member --project-ref ipnreuybteartgcqxqnd
```

Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to deployed functions. If using a self-hosted function environment, configure those as server-only secrets there. Confirm the Site URL is included in Supabase Auth's Redirect URLs. The invitation function adds an existing Auth user directly to the workspace without sending an Auth invitation email; new email addresses continue through `inviteUserByEmail`. The service-role key must never be added to this repository, a GitHub Actions variable used by the static site, or a browser bundle.

Do not apply SQL automatically from this project. Review `supabase/schema.sql` and apply it manually to a development Supabase project first. It is an initial-install schema, not an incremental upgrade script; if any earlier version was applied, prepare and review a migration rather than rerunning the whole file.

## Implementation status and current limits

Completed in this implementation pass:

- [x] Verify the Supabase project URL and supplied publishable key.
- [x] Create the relational schema, tenant RLS, composite workspace constraints, and secure workspace creation/conversion/financial functions.
- [x] Add email/password Auth, session restoration, verification/reset routes, and membership-based onboarding/workspace selection.
- [x] Add shared, workspace-scoped CRUD for leads, clients, projects, tasks, invoices, and payments.
- [x] Connect lead conversion, invoice items/totals, payment recording/reversal/refunds, dashboard metrics, and selective workspace Realtime subscriptions.
- [x] Add client notes, lead interaction logs, record audit history, deliverable/revision tracking, role-checked invitation/removal functions, date-filtered reporting, and CSV export.
- [x] Keep WhatsApp explicitly disabled until a secure server integration is configured; no frontend message-sending success is simulated.
- [x] Add responsive navigation, GitHub Pages deployment configuration, setup, and testing documentation.

Not yet verified or complete:

- [ ] Apply the reviewed schema manually in a non-production Supabase project, then exercise all database workflows there.
- [ ] Complete two-user/two-workspace RLS tests, including direct attempts to forge workspace IDs, assignments, payments, refunds, or membership changes.
- [ ] Deploy and test the invitation/removal Edge Functions, Auth email templates, and redirect URLs in the target project.
- [ ] Test invoice rounding and issue/payment/refund/reversal behavior against PostgreSQL, including concurrent requests.
- [ ] Complete browser, responsive, GitHub Pages, and production configuration validation.
- [ ] Implement WhatsApp provider integration only when a trusted backend, signature-verified webhook, and credentials are provisioned.

See [`TESTING.md`](./TESTING.md) before treating the application as a release candidate.

The payment UI supports partial refunds and one-time reversal. Refunds are immutable, idempotency-keyed database adjustments; the schema recalculates invoice status and workspace totals. This behavior has not yet been executed against the live Supabase database. The schema's line calculation rounds quantity × unit price to the nearest minor unit per line. Overdue invoice status is computed for display; there is no scheduled job that persists an overdue status.
