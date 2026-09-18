# Phone Test Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deployable phone testing collector with a mobile test page, admin record management, import, export, and search.

**Architecture:** A dependency-free Node HTTP server serves static pages and JSON APIs. Records are stored in `data/records.json` so the project can run on the target server without package installation. The mobile page submits diagnostic data, and the admin page manages the records.

**Tech Stack:** Node.js core modules, browser HTML/CSS/JavaScript, JSON file storage, CSV import/export.

---

### Task 1: Backend Storage And API

**Files:**
- Create: `server.js`
- Create: `tests/api.test.js`
- Create: `data/.gitkeep`

- [x] Write failing tests for create, list, update, export, and import behavior.
- [x] Run tests and verify they fail before implementation.
- [x] Implement JSON storage and HTTP routes.
- [x] Run tests and verify they pass.

### Task 2: Mobile Test Page

**Files:**
- Modify: `test.html`

- [x] Replace the broken mojibake content with readable Chinese UI.
- [x] Add phone number, issue, login result, and notes fields.
- [x] Collect device, browser, screen, timezone, language, and network diagnostics.
- [x] Submit to `/api/records`.

### Task 3: Admin Page

**Files:**
- Create: `admin.html`

- [x] Add searchable/filterable record table.
- [x] Add edit controls for status, issue, and solution.
- [x] Add CSV import/export controls.

### Task 4: Deployment Docs

**Files:**
- Create: `README.md`

- [x] Document local run command.
- [x] Document port 80 deployment command for `42.192.109.248`.
- [x] Document backup location.
