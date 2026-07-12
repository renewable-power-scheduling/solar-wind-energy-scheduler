# Vedanjay Power Control Dashboard

## Run (Docker)

```bash
docker-compose up --build
```

Frontend: http://localhost:8083
Backend API: http://localhost:3006  
API Docs: http://localhost:3006/docs

Note: the frontend image serves via Nginx and proxies `/api/*` to the backend upstream set by the compose file (see `nginx.conf.template`). Local and production Docker use the internal `qca-backend:3001` service address.

### Auto-upload worker (24x7)

Auto-upload is run as a separate container (`auto_upload_worker`) with `restart: always`, so it keeps working even when no browser is open.

- `docker-compose.yml`: runs `auto_upload_worker` locally.
- `docker-compose.prod.yml`: runs `auto_upload_worker` on EC2.

To avoid double-running the worker, `AUTO_UPLOAD_ENABLED` is set to `0` on the `backend` service and `1` on the `auto_upload_worker` service.

## Deploy To EC2 (ECR Images)

Use this flow when code changes are made locally and EC2 should run latest images.

### 1) Local Laptop (PowerShell)

```powershell
cd "C:\Users\HP\Downloads\QCA DASHBOARD FINAL"

docker build -t qca-frontend:latest -f Dockerfile.frontend .
docker build -t qca-backend:latest -f backend/Dockerfile ./backend

$pw = aws ecr get-login-password --region ap-south-1
$pw | docker login --username AWS --password-stdin 397483229292.dkr.ecr.ap-south-1.amazonaws.com

docker tag qca-frontend:latest 397483229292.dkr.ecr.ap-south-1.amazonaws.com/qca-frontend:latest
docker tag qca-backend:latest 397483229292.dkr.ecr.ap-south-1.amazonaws.com/qca-backend:latest

docker push 397483229292.dkr.ecr.ap-south-1.amazonaws.com/qca-frontend:latest
docker push 397483229292.dkr.ecr.ap-south-1.amazonaws.com/qca-backend:latest
```

### 2) EC2 Update (Recommended: Session Manager)

Open AWS Console:
- EC2 -> Instances -> Select instance -> Connect -> Session Manager -> Connect

Then run inside EC2 terminal:

```bash
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 397483229292.dkr.ecr.ap-south-1.amazonaws.com
docker compose -f /home/ubuntu/docker-compose.prod.yml pull
docker compose -f /home/ubuntu/docker-compose.prod.yml up -d
docker compose -f /home/ubuntu/docker-compose.prod.yml ps
curl -I http://localhost
```

### 3) Verify in Browser

- Open: `http://13.127.53.230/`
- Hard refresh: `Ctrl + F5`

## Troubleshooting (EC2/IP)

### UI shows S3 errors (cloud IP works differently than localhost)

Some screens list/read S3 files. If S3 CORS blocks browser access on the EC2 IP, the app falls back to backend S3 proxy endpoints:
- `POST /api/s3/list`
- `GET /api/s3/text?key=...`

Rebuild + push the latest `qca-frontend` and `qca-backend` images, then `docker compose ... pull && up -d` on EC2.

### UI shows `psycopg2.OperationalError ... localhost:5432 connection refused`

That means the backend is using a localhost DB URL. In Docker it should connect to the `db` service.
- Ensure the EC2 compose file includes `DATABASE_URL=postgresql://qca_user:qca_password@db:5432/qca_dashboard` for the backend (or use the latest backend image which defaults to `db` when `USE_DOCKER=true`).
- Check containers: `docker compose -f /home/ubuntu/docker-compose.prod.yml ps`
- Check logs: `docker compose -f /home/ubuntu/docker-compose.prod.yml logs --tail=200 backend db`

### Important

- `/home/ubuntu/docker-compose.prod.yml` is an EC2 path. Do not run that path in local Windows PowerShell.
- Local compose path is `.\docker-compose.prod.yml` (runs containers on laptop, not EC2).

## Run (Local)

Backend:

```bash
cd backend
pip install -r requirements.txt
set DATABASE_URL=postgresql://qca_user:qca_password@localhost:5432/qca_dashboard
uvicorn main:app --host 0.0.0.0 --port 3001 --reload
```

Frontend:

```bash
npm install
npm run dev
```

Frontend (dev): http://localhost:5173

## Admin Login

- Admin username: `Scheduling_VPPL`
- Admin password: `Scheduling@vppl54`

## Team Logins

- Username: employee id (example: `VPPL6127`)
- Password format: `EMPID#BIRTHYEAR` (example: `VPPL6127#1995`)
- Intern username: `intern`
- Intern password: `intern`

## Remember Me

The login screen includes a `Remember me` option which stores the entered username and password in browser `localStorage` on that device.

Note: current auth is frontend-only (localStorage gate). Anyone with browser access can bypass it; add backend auth if you need real security.

## Frontend Structure

- App shell, global auth/theme, lazy loading: `src/app/App.jsx`
- Header and actions: `src/app/components/TopNav.jsx`
- Responsive/collapsible sidebar: `src/app/components/Sidebar.jsx`
- Login module: `src/app/components/screens/Login.jsx`
- Theme variables and global compatibility styles: `src/styles/theme.css`

## Theme System

- Default theme: `light`
- Toggle in header (sun/moon icon)
- Stored in localStorage: `vedanjay-theme`
- Auth keys in localStorage:
  - `vedanjay-user`
  - `vedanjay-token`

## Branding Assets

- Logo: `public/vedanjay logo.png`
- Favicon: `public/vedanjay-favicon.svg`
- Browser title/meta: `index.html`

## Manual Changes API Gateway (New)

- Bootstrap files are in `infra/`.
- Deploy/runbook: `infra/README.md`
- CloudFormation stack: `infra/apigw-manual-schedule.yaml`
- Lambda handler: `infra/lambda/manual_changes_ingest.py`
