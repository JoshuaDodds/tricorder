# SETUP_JIRA — PAT, Integration, and Verification

## 1) Create a Jira API Token (PAT)
1. Go to Atlassian Account → **Security** → **Create and manage API tokens**.
2. Create token, label it (e.g., “Agents PAT”); copy the value.

**Store as environment variables (CI/CD and local):**

    JIRA_EMAIL=<jira-account-email>
    JIRA_PAT=<paste-token>

The Jira base URL is derived each run from the organization name `mfisbv`, producing `https://mfisbv.atlassian.net`, so no `JIRA_BASE_URL` variable is required.

## 2) Enable Git ↔ Jira Integration (Smart Commits)
- For GitHub: install **Jira Cloud** app and connect your org/repositories.
- Ensure **Smart Commits** are enabled for the repo.
- The **Git author email** must match a Jira user email.

## 3) Permissions Checklist
- Project permissions for the PAT user:
  - Browse Projects, Add Comments, Work On Issues, Log Work, Transition Issues.
- Workflow includes transitions named exactly:
  - **In Progress**
  - **In Review**

## 4) Quick Verification
**A. API smoke test**

- `GET /rest/api/3/myself` → returns your Jira user.
- `GET /rest/api/3/issue/TR-<int>` → issue loads (project key `TR` is embedded in the ticket ID).
- `GET /rest/api/3/issue/TR-<int>/transitions` → includes **In Progress** and **In Review**.
- `POST /rest/api/3/issue/TR-<int>/comment` → adds a comment.

**B. Smart Commit test**

    git commit -m "TR-<int> Connectivity smoke test #comment verify smart commits #time 2m"

Push and confirm in Jira:
- Commit is linked to the issue.
- Comment and time appear (if permissions allow).

## 5) Troubleshooting
- **Nothing happens on commit**: integration not installed, author email mismatch, or Smart Commits disabled.
- **Transition fails**: transition name not in current issue status path; fetch transitions and use the returned ID.
- **Worklog blocked**: Worklog permission missing; enable for PAT user.
- **Multiple workflows**: transitions differ by issue type; always fetch transitions per issue.

## 6) PR/Branch Conventions (Recommended)
- Branch: `tr-<num>-<short-slug>`
- PR title: `TR-<num>: <summary>`
- PR description: What/Why, How (high-level), Risk/Rollback, Links (Jira, commit/PR, run)

## 7) Safety
- Store secrets in CI secrets manager; never commit them.
- Rotate PAT on a schedule; revoke immediately if exposed.
- Limit token scope to Jira only; use a service account when possible.
