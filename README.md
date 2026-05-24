# 📄 Invoice Workflow Tracker

A clean, minimal internal invoice tracker for a single clerk — built with **Node.js + Express + SQLite + Tailwind CSS + Alpine.js**.

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
# http://localhost:3000
```

For live-reload during development:
```bash
npm run dev    # uses nodemon
```

---

## 📁 Project Structure

```
invoice-tracker/
├── public/
│   ├── index.html       ← Full SPA frontend (Tailwind + Alpine.js)
│   └── uploads/         ← Invoice images stored here (auto-created)
├── server.js            ← Express backend + SQLite API
├── schema.sql           ← Database schema (reference)
├── invoices.db          ← SQLite database (auto-created on first run)
└── package.json
```

---

## 🗄️ Database Schema

```sql
CREATE TABLE invoices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT    NOT NULL,
    amount         REAL    NOT NULL,
    image_path     TEXT,
    status         TEXT    NOT NULL CHECK(status IN ('Processed','Postponed','Pending')),
    reason         TEXT,             -- Nullable; only for Postponed / Pending
    created_at     DATETIME NOT NULL DEFAULT (datetime('now'))
);
```

---

## 🌐 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats` | Dashboard summary statistics |
| GET | `/api/invoices` | List all invoices (newest first) |
| GET | `/api/invoices/:id` | Get single invoice |
| POST | `/api/invoices` | Create invoice (multipart/form-data) |
| DELETE | `/api/invoices/:id` | Delete invoice + its image file |

---

## 🎨 Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | HTML + Tailwind CSS CDN + Alpine.js CDN |
| Backend | Node.js + Express |
| Database | SQLite (better-sqlite3) |
| Uploads | Multer |
