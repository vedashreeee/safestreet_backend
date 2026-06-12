# SafeStreet — Backend API

Node.js + Express + PostgreSQL backend for the SafeStreet road hazard reporting system.

## Folder Structure

```
safestreet-backend/
├── server.js                  # Entry point — Express app + cron job
├── schema.sql                 # PostgreSQL table definitions
├── .env.example               # Copy to .env and fill in values
│
├── routes/
│   ├── reports.js             # POST /api/reports, GET /api/reports
│   ├── auth.js                # POST /api/auth/login
│   ├── dashboard.js           # GET /api/dashboard/* (protected)
│   └── clusters.js            # POST /api/clusters/run
│
├── controllers/
│   ├── reportController.js    # Report submit, list, update status
│   ├── authController.js      # JWT login
│   └── dashboardController.js # Stats, danger zones, complaints
│
├── middleware/
│   ├── upload.js              # Multer photo upload config
│   └── auth.js                # JWT verification middleware
│
├── ml/
│   ├── clustering.js          # DBSCAN algorithm — danger zone detection
│   └── pdfGenerator.js        # Auto-generate complaint PDF letters
│
└── utils/
    ├── db.js                  # PostgreSQL connection pool
    ├── sms.js                 # Twilio SMS sender
    └── seed.js                # DB setup + demo data
```

## Quick Start

### 1. Install dependencies
```bash
cd safestreet-backend
npm install
```

### 2. Set up PostgreSQL
Install PostgreSQL from https://www.postgresql.org/download/windows/
Then create the database:
```sql
psql -U postgres
CREATE DATABASE safestreet;
\q
```

### 3. Configure environment
```bash
copy .env.example .env
```
Edit `.env` and set your `DB_PASSWORD`.

### 4. Seed database (creates tables + demo data)
```bash
node utils/seed.js
```

### 5. Start the server
```bash
npm run dev
# → http://localhost:5000
```

### 6. Test it
```bash
# Health check
curl http://localhost:5000/api/health

# Submit a test report
curl -X POST http://localhost:5000/api/reports \
  -F "lat=16.5075" \
  -F "lng=80.6395" \
  -F "hazard=pothole"
```

## API Reference

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | /api/reports | ❌ | Submit hazard report |
| GET | /api/reports/heatmap | ❌ | All GPS points for heatmap |
| GET | /api/reports/:id | ❌ | Single report details |
| GET | /api/reports | ✅ | List all reports |
| PATCH | /api/reports/:id/status | ✅ | Update report status |
| POST | /api/auth/login | ❌ | Secretary login |
| GET | /api/auth/me | ✅ | Current user info |
| GET | /api/dashboard/stats | ✅ | Summary counts |
| GET | /api/dashboard/danger-zones | ✅ | Active danger zones |
| GET | /api/dashboard/complaints | ✅ | Pending complaints |
| GET | /api/dashboard/analytics | ✅ | Charts data |
| POST | /api/clusters/run | ✅ | Trigger DBSCAN manually |

## Secretary Login (after seeding)
- Username: `secretary`
- Password: `secretary123`

## DBSCAN Settings (.env)
```
CLUSTER_RADIUS_METERS=50   # Points within 50m are neighbors
CLUSTER_MIN_REPORTS=5      # 5+ reports = Verified Danger Zone
CLUSTER_WINDOW_DAYS=30     # Only look at last 30 days
```

## Next Step
After the backend is running, build the **Secretary Dashboard** frontend
and the **Raspberry Pi alert device** script.
