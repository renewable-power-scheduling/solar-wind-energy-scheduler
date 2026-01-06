
# Project Documentation Index

This directory contains all documentation related to the **Solar & Wind Energy Scheduler** project.
The documents here are structured by purpose so contributors, maintainers, and future team members
can quickly find the information they need without ambiguity.

---

## 📁 Directory Overview

### 1. `Images/`
Contains all reference images used across documentation.

**Includes:**
- Architecture diagrams
- Flowcharts
- UI wireframes / screenshots
- System flow illustrations

**Purpose:**
- Visual clarification of concepts described in markdown files
- Centralized image storage to avoid duplication

> ⚠️ This folder is not meant for raw assets or design files—only documentation references.

---

### 2. `contributing/`
Contains contributor-facing documentation.

**Includes:**
- Repository rules and guidelines
- Branch naming conventions
- Commit message standards
- Pull Request workflow
- Review and merge process

**Audience:**
- Team members contributing code
- New developers onboarding to the repository

**Goal:**
Ensure consistent development practices and reduce friction during collaboration.

---

### 3. `data-specs/`
Contains documentation related to system data.

**Includes:**
- Input data formats
- Output data structures
- Field definitions and units
- Constraints and assumptions

**Audience:**
- Developers working on ML, backend, or integrations
- Anyone consuming or producing system data

**Goal:**
Act as the single source of truth for all data used by the system.

---

### 4. `maintainers/`
Contains maintainer-only documentation.

**Includes:**
- Maintainer responsibilities
- Branch protection rules
- CODEOWNERS logic
- Review and merge authority
- Internal repository governance
- Handover notes for future maintainers

**Audience:**
- Current maintainers
- Future maintainers during role transition

**Goal:**
Ensure continuity, governance clarity, and consistent repository management.

> 🔒 These documents define **how the repository is controlled**, not how features are built.

---

## 📌 General Notes

- All documentation should be updated alongside relevant code changes.
- If a document becomes obsolete, it should be updated or clearly marked as deprecated.
- Avoid duplicating information across folders—link instead.

---

## 🧭 How to Use This Documentation

| Role | Start Here |
|----|----------|
| Contributor | `contributing/` |
| ML / Backend / Frontend Developer | `data-specs/` |
| Maintainer | `maintainers/` |
| Anyone needing context | This README + `Images/` |

---

Maintainers are responsible for keeping this documentation accurate and enforced.
