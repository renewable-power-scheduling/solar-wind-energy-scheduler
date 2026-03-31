# Vedanjay Power Control Dashboard

## Run (Docker)

```bash
docker-compose up --build
```

Frontend: http://localhost:80  
Backend API: http://localhost:3001  
API Docs: http://localhost:3001/docs

## Deploy To EC2 (ECR Images)

Use this flow when code changes are made locally and EC2 should run latest images.

### 1) Local Laptop (PowerShell)

```powershell
cd "C:\Users\HP\Downloads\QCA DASHBOARD FINAL"

docker build -t qca-frontend:latest -f Dockerfile.frontend .
docker build -t qca-backend:latest -f backend/Dockerfile ./backend

$pw = aws ecr get-login-password --region ap-south-1
$pw | docker login --username AWS --password-stdin 637423166541.dkr.ecr.ap-south-1.amazonaws.com

docker tag qca-frontend:latest 637423166541.dkr.ecr.ap-south-1.amazonaws.com/qca-frontend:latest
docker tag qca-backend:latest 637423166541.dkr.ecr.ap-south-1.amazonaws.com/qca-backend:latest

docker push 637423166541.dkr.ecr.ap-south-1.amazonaws.com/qca-frontend:latest
docker push 637423166541.dkr.ecr.ap-south-1.amazonaws.com/qca-backend:latest
```

### 2) EC2 Update (Recommended: Session Manager)

Open AWS Console:
- EC2 -> Instances -> Select instance -> Connect -> Session Manager -> Connect

Then run inside EC2 terminal:

```bash
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 637423166541.dkr.ecr.ap-south-1.amazonaws.com
docker compose -f /home/ubuntu/docker-compose.prod.yml pull
docker compose -f /home/ubuntu/docker-compose.prod.yml up -d
docker compose -f /home/ubuntu/docker-compose.prod.yml ps
curl -I http://localhost
```

### 3) Verify in Browser

- Open: `http://13.127.53.230/`
- Hard refresh: `Ctrl + F5`

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

- Email: `admin@vedanjay.com`
- Password: `Vedanjay@2026`

Only the above credentials are valid.

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
