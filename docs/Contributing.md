# Contributing Guidelines

This repository follows a strict pull-request–based workflow to keep the `main` branch stable and production-ready.

All contributors must follow the rules defined below.

---

## Branch Policy

- `main` is a protected branch

- Direct pushes to `main` are **not allowed**

- All changes must be made via feature branches and pull requests

### Branch Naming Convention (Mandatory)

`feature/<team>-<short-task-name>`

#### Examples

- feature/ml-enercast-csv-parser

- feature/backend-fastapi-skeleton

- feature/frontend-react-init

---

## Folder Ownership

Each team must restrict changes to their assigned folder only:

| Team           | Allowed Folder |
|----------------|----------------|
| ML Team        | `ml/`          |
| Backend Team   | `backend/`     |
| Frontend Team  | `frontend/`    |
| Maintainer     | All folders    |

Pull requests that modify files outside the assigned folder **will be rejected** unless explicitly approved.


---

## Required Workflow

All contributors must follow this sequence:

```bash

git checkout main

git pull origin main

git checkout -b feature/<team>-<task>

```

- Make changes only inside your assigned folder

- Commit small, focused changes

- Push the feature branch

- Open a pull request targeting main

## Pull Request Rules

- Every pull request must:

  - Contain at least one meaningful commit

  - Be limited to a single task or feature

  - Receive at least one approving review

- Pull request authors cannot approve their own PR

- All conversations must be resolved before merge

- Squash merge is enforced

- Feature branches are deleted after merge

## Commit Message Guidelines

Use clear, descriptive messages:

✅ Good:

```bash

Initialize backend FastAPI project skeleton

Parse Enercast CSV and validate schema

Add basic React project layout

```

❌ Avoid:

```bash

update

changes done

final commit

```

## What Not to Do

- Do NOT push directly to main

- Do NOT open pull requests without commits

- Do NOT mix ML, backend, and frontend changes in one PR

- Do NOT commit secrets, environment files, or generated artifacts

## Questions or Issues

If you face access or workflow issues, contact the repository maintainer.

---

## FINAL CHECK (important)

After merge, verify:

```bash

ls docs



```
