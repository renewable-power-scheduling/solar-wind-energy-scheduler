# ML Team – Git Workflow (Quick Guide) 
### (for other teams replace folder names with your assigned folder names)

This guide explains the **mandatory steps** an ML team member must follow to get work merged into `main`.

---

## 1. One-time setup (first day only)

```bash
mkdir vedanjay-projects
cd vedanjay-projects
```
## 2. Clone the repository
```
git clone https://github.com/renewable-power-scheduling/solar-wind-energy-scheduler.git
cd solar-wind-energy-scheduler
```
#### Verify you are on main:
```
git branch
```
## 3. Sync with main (MANDATORY before every task)
```
git checkout main
git pull origin main
```
#### Skipping this may cause conflicts or PR rejection.

## 4. Create a feature branch (ML naming rule)
#### Format:
```
feature/ml-<short-task-name>
```
##### Example:
```
git checkout -b feature/ml-enercast-csv-parser
```

## 5. Work ONLY inside ``ml/``

```
cd ml
mkdir enercast_parser
cd enercast_parser
touch parser.py schema_validator.py README.md
```
### 🚫 Do NOT touch:

- ``backend/``

- ``frontend/``

- ``.github/``

- ``CODEOWNERS``

- ``root files``

### PRs violating this will be blocked.
#### for other teams use your assigned directory as
```
frontend/
backend/
maintainer/
```
## 6. Check and commit changes
```
git status
git diff
git add ml/
git commit -m "Add initial Enercast CSV parser skeleton"
```
### ❌ Avoid commit messages like: ``update``, ``final``, ``changes``

## 7. Push your branch
```
git push -u origin feature/ml-enercast-csv-parser
```
### This does not affect ``main``.
## 8. Open a Pull Request
### On GitHub:

- Base: ``main``

- Compare: ``feature/ml-enercast-csv-parser``

### PR title
```
ML: Initial Enercast CSV parser
```
### PR description
```
- Added Enercast CSV parser skeleton
- ML folder only
```
## 9. Review & merge

- You **cannot approve your own PR**

- CODEOWNERS requests ML team (another member from the ml team who has not created this feature tree) / maintainer review

- After approval:

  - Maintainer squash merges

  - Feature branch is deleted
## 10. Cleanup after merge (to delete feature branch after merge)
```
git checkout main
git pull origin main
git branch -d feature/ml-enercast-csv-parser
```
## Key rules (remember this)

- One task = one branch

- ML work stays in ml/

- No direct push to main

- PR approval is mandatory
