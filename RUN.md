# QCA Dashboard - Running the Application

This document provides comprehensive instructions for running the QCA Renewable Energy Schedule Management Dashboard using Docker containers or manually on your local machine.

## Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Docker Deployment](#docker-deployment)
  - [Using Docker Compose (Recommended)](#using-docker-compose-recommended)
  - [Using Start Scripts](#using-start-scripts)
  - [Docker Commands Reference](#docker-commands-reference)
- [Manual Deployment](#manual-deployment)
  - [Database Setup (PostgreSQL)](#database-setup-postgresql)
  - [Backend Setup](#backend-setup)
  - [Frontend Setup](#frontend-setup)
- [Access Points](#access-points)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)

---

## Quick Start

### Option 1: Docker Compose (Recommended)

```bash
# Clone and navigate to project
cd QCA_DASHBOARD_FINAL

# Start all services with one command
docker-compose up --build

# Or start in background
docker-compose up --build -d
```

### Option 2: Quick Start Script (Windows)

```powershell
# Run PowerShell script (requires Docker)
.\start-docker.ps1
```

### Option 3: Quick Start Script (Linux/Mac)

```bash
chmod +x start-docker.sh
./start-docker.sh
```

---

## Prerequisites

### For Docker Deployment

- **Docker Engine** v20.10+
- **Docker Compose** v2.0+
- **8GB RAM** minimum (16GB recommended)
- **10GB** free disk space

### For Manual Deployment

- **Python** 3.11+
- **Node.js** 18.19.0+
- **PostgreSQL** 15.x
- **npm** or **yarn**
- **Git** for version control

---

## Docker Deployment

### Using Docker Compose (Recommended)

Docker Compose orchestrates all services (Frontend, Backend, Database) with a single command.

#### 1. Navigate to Project Directory

```bash
cd QCA_DASHBOARD_FINAL
```

#### 2. Start All Services

```bash
# Build and start all containers
docker-compose up --build

# Run in detached mode (background)
docker-compose up --build -d
```

#### 3. Verify Services are Running

```bash
# Check container status
docker-compose ps

# View logs
docker-compose logs -f
```

#### 4. Stop All Services

```bash
docker-compose down

# Stop and remove volumes (WARNING: deletes all data)
docker-compose down -v
```

### Using Start Scripts

#### Windows (PowerShell)

```powershell
# Run the automated start script
.\start-docker.ps1

# Or use the batch file
.\scripts\start-all.ps1
```

#### Linux/Mac

```bash
# Make script executable
chmod +x start-docker.sh
./start-docker.sh

# Or use shell script in scripts folder
chmod +x ./scripts/start-all.sh
./scripts/start-all.sh
```

### Docker Commands Reference

| Command                            | Description                  |
| ---------------------------------- | ---------------------------- |
| `docker-compose up --build`        | Build and start all services |
| `docker-compose up -d`             | Start in background          |
| `docker-compose down`              | Stop all services            |
| `docker-compose down -v`           | Stop and remove volumes      |
| `docker-compose logs -f`           | Follow logs                  |
| `docker-compose logs backend`      | Backend logs only            |
| `docker-compose logs frontend`     | Frontend logs only           |
| `docker-compose restart`           | Restart all services         |
| `docker-compose restart backend`   | Restart backend only         |
| `docker-compose exec backend bash` | Access backend container     |

---

## Manual Deployment

### Database Setup (PostgreSQL)

#### 1. Install PostgreSQL 15

**Windows:**

- Download from [postgresql.org](https://www.postgresql.org/download/windows/)
- Run installer as administrator
- Note: Set password for `postgres` user

**macOS:**

```bash
brew install postgresql@15
brew services start postgresql@15
```

**Linux (Ubuntu/Debian):**

```bash
sudo apt update
sudo apt install postgresql-15
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

#### 2. Create Database and User

```bash
# Connect to PostgreSQL as postgres user
sudo -u postgres psql

# In PostgreSQL prompt:
CREATE USER qca_user WITH PASSWORD 'qca_password';
CREATE DATABASE qca_dashboard OWNER qca_user;
GRANT ALL PRIVILEGES ON DATABASE qca_dashboard TO qca_user;

# Exit PostgreSQL
\q
```

#### 3. Verify Connection

```bash
psql -h localhost -U qca_user -d qca_dashboard
```

### Backend Setup

#### 1. Navigate to Backend Directory

```bash
cd backend
```

#### 2. Create Virtual Environment

```bash
# Create virtual environment
python -m venv venv

# Activate virtual environment
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

# Upgrade pip
pip install --upgrade pip
```

#### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

#### 4. Configure Environment Variables

Create `.env` file in `backend/` directory:

```env
DATABASE_URL=postgresql://qca_user:qca_password@localhost:5432/qca_dashboard
PORT=3001
USE_DOCKER=false
```

#### 5. Initialize Database

```bash
python init_db.py
```

#### 6. Start Backend Server

```bash
# Development mode with auto-reload
uvicorn main:app --reload --host 0.0.0.0 --port 3001

# Production mode
uvicorn main:app --host 0.0.0.0 --port 3001
```

#### 7. Verify Backend is Running

```bash
# Health check
curl http://localhost:3001/api/health

# API root
curl http://localhost:3001/

# API documentation
open http://localhost:3001/docs
```

### Frontend Setup

#### 1. Navigate to Project Root

```bash
cd QCA_DASHBOARD_FINAL
```

#### 2. Install Dependencies

```bash
npm install
```

#### 3. Configure Environment

Create `.env` file in project root:

```env
VITE_API_BASE_URL=http://localhost:3001/api
VITE_NODE_ENV=development
```

#### 4. Start Development Server

```bash
npm run dev
```

#### 5. Verify Frontend is Running

```bash
# Access at
open http://localhost:5173
```

---

## Access Points

Once the application is running, access the following URLs:

| Service               | URL                              | Description               |
| --------------------- | -------------------------------- | ------------------------- |
| **Frontend**          | http://localhost:80              | Production build (Docker) |
| **Frontend Dev**      | http://localhost:5173            | Development mode (manual) |
| **Backend API**       | http://localhost:3001            | REST API endpoint         |
| **API Documentation** | http://localhost:3001/docs       | Swagger UI                |
| **API Health Check**  | http://localhost:3001/api/health | Health status             |
| **PostgreSQL**        | localhost:5432                   | Database connection       |

---

## Troubleshooting

### Docker Issues

#### "Docker is not running"

```powershell
# Windows: Start Docker Desktop
# Or in PowerShell:
Start-Service docker
```

#### "Port already in use"

```bash
# Check what's using the port
netstat -ano | findstr :3001  # Windows
lsof -i :3001                  # Linux/Mac

# Kill the process or change the port in docker-compose.yml
```

#### "Connection refused" to backend

```bash
# Check backend logs
docker-compose logs backend

# Verify backend is healthy
docker inspect --format='{{.State.Health.Status}}' qca-dashboard-backend
```

#### Database connection issues

```bash
# Check database logs
docker-compose logs db

# Verify database is ready
docker exec -it qca-dashboard-db psql -U qca_user -d qca_dashboard -c "SELECT 1"
```

### Manual Setup Issues

#### PostgreSQL connection refused

```bash
# Ensure PostgreSQL is running
# Windows:
net start postgresql-x64-15

# Linux:
sudo systemctl status postgresql

# Check pg_hba.conf allows local connections
```

#### Python module not found

```bash
# Activate virtual environment
# Windows:
venv\Scripts\activate

# Reinstall dependencies
pip install -r requirements.txt
```

#### Frontend API not connecting

```bash
# Verify VITE_API_BASE_URL is set correctly
# Check browser console for CORS errors
# Ensure backend is running on expected port
```

#### npm install failures

```bash
# Clear npm cache
npm cache clean --force

# Delete node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

---

## Project Structure

```
QCA_DASHBOARD_FINAL/
├── docker-compose.yml          # Docker Compose configuration
├── Dockerfile.frontend          # Frontend Docker image
├── nginx.conf                  # Nginx reverse proxy config
├── RUN.md                      # This file
├── README.md                   # Project overview
│
├── backend/                    # FastAPI Backend
│   ├── Dockerfile              # Backend Docker image
│   ├── main.py                 # Main FastAPI application
│   ├── database.py             # Database configuration
│   ├── init_db.py              # Database initialization
│   ├── models.py               # SQLAlchemy models
│   ├── schemas.py              # Pydantic schemas
│   ├── crud.py                 # Database operations
│   ├── requirements.txt        # Python dependencies
│   └── wait-for-db.py          # Database startup script
│
├── src/                        # React Frontend
│   ├── app/
│   │   ├── components/         # React components
│   │   │   ├── screens/        # Page components
│   │   │   └── ui/             # UI components
│   │   └── contexts/           # React contexts
│   ├── services/
│   │   └── api.js              # API service layer
│   └── hooks/                  # Custom React hooks
│
├── scripts/                    # Utility scripts
│   ├── start-all.ps1          # PowerShell start script
│   ├── start-all.bat          # Batch start script
│   └── start-all-manual.ps1   # Manual setup script
│
├── public/                     # Static assets
└── package.json               # Frontend dependencies
```

---

## Environment Variables

### Backend (.env)

```env
DATABASE_URL=postgresql://qca_user:qca_password@localhost:5432/qca_dashboard
PORT=3001
USE_DOCKER=false
```

### Frontend (.env)

```env
VITE_API_BASE_URL=http://localhost:3001/api
VITE_NODE_ENV=development
```

### Docker Compose

The following environment variables are configured in `docker-compose.yml`:

```yaml
# Database
POSTGRES_USER=qca_user
POSTGRES_PASSWORD=qca_password
POSTGRES_DB=qca_dashboard

# Backend
DATABASE_URL=postgresql://qca_user:qca_password@db:5432/qca_dashboard
PORT=3001

# Frontend
VITE_API_BASE_URL=http://backend:3001/api
```

---

## Database Schema

The application uses the following main entities:

- **Plant** - Renewable energy plants (Wind/Solar)
- **Schedule** - Day-ahead and intraday schedules
- **Forecast** - Energy generation forecasts
- **Weather** - Weather data and conditions
- **Deviation** - Schedule deviation records
- **Report** - Generated reports
- **Template** - Vendor-specific templates
- **WhatsAppData** - WhatsApp integration data
- **MeterData** - 96-block meter readings

---

## Additional Resources

- **API Documentation**: http://localhost:3001/docs
- **Project README**: [README.md](README.md)
- **Quick Start Guide**: [QUICK_START.md](QUICK_START.md)

---

**Built with ❤️ by the QCA Development Team**
