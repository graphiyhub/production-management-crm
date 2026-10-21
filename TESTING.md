# Testing and release checklist

## Browser smoke test

1. Open the deployed site or serve this folder with any static HTTP server.
2. Register a new account and verify the email if Supabase email confirmation is enabled.
3. Sign in, create a workspace, sign out, and sign back in. Confirm the workspace remains available.
4. Create a lead and convert it. Confirm it remains in Leads and appears in Clients.
5. Create a client, then a project and task for that client.
6. Create an invoice, add one or more line items, issue it, and record one or more payments. Verify the balance/status updates.
7. Attempt an overpayment; the database must reject it. Refund part of a payment, verify invoice balance/status and net totals, retry the same refund request only with the same idempotency key, and reverse a payment. Confirm no operation allows refunding more than the unrefunded amount.
8. Add client notes, log lead calls/emails/meetings, add a deliverable and revision, and confirm audit history updates.
9. Create a second account and second workspace. Confirm each account sees only its own workspace list and records. As an owner, add the existing second account to the first workspace and confirm it gains access without receiving an Auth invitation email. Try adding it again and confirm the function reports that it is already a member without changing its role. Verify an admin can add a member but cannot invite an admin, and a non-admin is rejected. Invite a new email and confirm the Auth invitation email, verification redirect, and workspace access after verification. Test member removal only after deploying both Edge Functions.
10. Test password reset, sign-out, mobile navigation, search, status filters, sorting, pagination, report date filters/CSV export, and empty/error states.
11. Confirm WhatsApp shows “Setup required” and never indicates that an unconfigured message was sent.

## SQL security checks

Use two real test accounts and workspaces, not the SQL Editor's elevated role. With each account, try selecting, inserting, and changing records while supplying the other workspace's UUID. Requests must be rejected or return no rows. Verify a member cannot edit workspace settings or write membership rows, assign a record to a user outside the workspace, attach a task to a project without its client, mutate issued invoice items, directly create payment adjustments, overpay, or change a payment after reversal. Verify admins cannot invite admins or remove owners, the last owner cannot be removed, and concurrent owner-removal requests still leave an owner.

The schema uses RLS, composite foreign keys, database-enforced invoice/payment rules, and role checks in Edge Functions. The checks above still need to be run against a Supabase project before release. Do not run the initial schema a second time as an upgrade; review it first and create a migration if a schema version was already applied. Do not apply SQL automatically from this repository.

## Current release status

The source includes workspace creation, authentication UI, workspace selection, workspace-scoped CRM workflows, audit history, member invitation/removal functions, refunds, and reports. These database workflows and RLS policies have not been executed against the target Supabase project from this workspace. No claim is made that authenticated CRUD, tenant isolation, financial concurrency, Edge Functions, or GitHub Pages deployment has passed end-to-end tests. Per-record assignment authorization is not implemented. WhatsApp messaging/webhooks are not implemented and remain explicitly disabled.
