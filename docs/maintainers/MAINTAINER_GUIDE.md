# Maintainer Guide – Repository Access, Roles & Rules

## Purpose of This Document

This document explains **how maintainer access is structured**, **why certain rules exist**, and **how to safely work on this repository**.

It is intended for:
- Current and future **maintainers**
- Organization admins
- Engineers who need to understand **access control, SSH setup, and Git rules**

This repository intentionally enforces **strict separation** between:
- **Contributor (Personal) role**
- **Maintainer (Company) role**

This is done to:
- Prevent accidental pushes to `main`
- Preserve audit clarity
- Match professional, production-grade Git workflows

---

## Role Definitions

### 1. Contributor (PR Role)

**Purpose**
- Develop features
- Fix bugs
- Propose changes

**Capabilities**
- Create commits locally
- Push to **feature branches**
- Open Pull Requests

**Restrictions**
- ❌ Cannot push directly to `main`
- ❌ Cannot bypass maintainer review
- ❌ Cannot modify protected files directly

---

### 2. Maintainer (MN Role)

**Purpose**
- Own `main` branch
- Merge Pull Requests
- Make emergency or infrastructure changes

**Capabilities**
- Push directly to `main`
- Approve and merge PRs
- Modify protected files (`.github/`, workflows, CODEOWNERS)

**Responsibility**
- Ensure changes are intentional
- Preserve audit clarity
- Maintain repository health

---

## Branch Protection Philosophy

### Why `main` is protected

Direct pushes to `main` are **high-risk**.  
Accidental pushes, wrong identities, or incorrect SSH usage can cause irreversible damage.

Therefore:
- Only **Maintainer role** can push to `main`
- Contributors must go through PRs

---

## CODEOWNERS Configuration

The repository uses a `.github/CODEOWNERS` file to enforce ownership.

### Purpose of CODEOWNERS
- Automatically request reviews from correct teams
- Ensure maintainers are always involved in critical changes
- Prevent unreviewed modifications

### Example Structure
```text
ml/**         @org/ml-team
backend/**    @org/backend-team
frontend/**   @org/frontend-team
*             @org/maintainers
```

### Key Rule

- Any change not explicitly owned defaults to Maintainers

- This guarantees no orphaned ownership.

## SSH Architecture (Critical Section)
OAOAOAOA### Why SSH is Used Instead of HTTPS
OA
#### SSH allows:
OA
- Multiple GitHub accounts on one machine

- Strong cryptographic identity

- Clear separation of permissions

- HTTPS does not reliably support this use case.

### SSH Keys Used
OA
#### Two SSH keys are used on the same machine:
	    
| Role              | SSH Key            |
| :---------------- | :-----------------:| 
| Contributor       | id_ed25519_personal| 
| Maintainer        | id_ed25519_company | 

#### Each key is added to its respective GitHub account.

## SSH Config (~/.ssh/config)
``` bash
# Personal / Contributor
Host github-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_personal
  IdentitiesOnly yes

# Company / Maintainer
Host github-company
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_company
  IdentitiesOnly yes
```
#### This allows explicit identity selection.

## Role Switching Mechanism (IMPORTANT)

### To avoid human error, manual switching is forbidden. Instead, Git aliases are used.

###  Available Commands
```
git role-PR   # Contributor mode
git role-MN   # Maintainer mode

```
### What Each Command Does
```git role-PR```

- Switches remote to ``github-personal``

- Sets ``user.name`` and ``user.email`` to personal identity

- Prevents pushing to ``main``

``git role-MN``

- Switches remote to ``github-company``

- Sets ``user.name`` and ``user.email`` to maintainer identity

- Allows pushing to ``main``

## Enforcement Rules (Local Hooks)
### Rule 1 — Push to main is blocked for contributors

#### If a contributor tries:

``` bash
git push
```

#### They will see:

```
❌ Push to main blocked.
Only MAINTAINER role may push to main.
```


This is enforced via a ``pre-push`` Git hook.

### Rule 2 — Commits are local, pushes are controlled

#### Important concept:

- ``git commit`` → creates local history

- ``git push`` → publishes history

A contributor may **commit locally**, but **cannot publish to** ``main``.

This is intentional and mirrors real-world workflows.

## Commit Authorship vs Push Authority

 Git tracks **authorship**, not “who pushed”.

	

	
	

| Concept            | Meaning | 
| :---------------- | :------: | 
| Author      |   	Who created the commit |
| Committer         |   Who finalized the commit  | 
| Codecademy Tee    |  Who uploaded it (GitHub event, not Git data)  | 



#### Key Rule

``git push`` does not change commit ownership.

Therefore:

- A commit authored by a contributor may still be pushed by a maintainer

- This is normal and acceptable

### Recommended Maintainer Workflow
#### Standard (Preferred)

- Contributor opens PR

- Maintainer reviews

- Maintainer merges

### Emergency / Direct Fix
```
git role-MN
git commit
git push
```

## How to Verify Rules Are Working
### Test 1 — Contributor push to main
```
git role-PR
git push
```

Expected: ❌ blocked

### Test 2 — Maintainer push to main
```
git role-MN
git push
```

Expected: ✅ success

### Test 3 — Server-side verification

- **Check repository state**

- **If file is absent → push was blocked**

- **If file is present → push succeeded**

## When Maintainer Ownership Changes

#### If this role is transferred:

- Rotate SSH keys for maintainer account

- Update:
```
~/.ssh/id_ed25519_company
```

- No repository changes required

- No workflow changes required

The system is **designed for seamless handover**.

## Final Notes for Future Maintainers

- Never disable hooks casually

- Never push to main from personal identity

- Always verify role before pushing

- Treat ``main`` as production

#### If unsure:
```
git remote -v
git config user.email
```

#### If these do not match the maintainer identity, do not push.
