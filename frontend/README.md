# QCA Renewable Energy Schedule Management Dashboard

A professional web application for Qualified Coordinating Agencies (QCA) to manage day-ahead and intraday renewable energy scheduling workflows.

## 🚀 Quick Start

**One-command Docker run:**
```bash
docker-compose up --build
```

**Or see [QUICK_START.md](QUICK_START.md)** for quick setup instructions.

## 📖 Documentation

| File | Description |
|------|-------------|
| [RUN.md](RUN.md) | Complete setup and running guide |
| [QUICK_START.md](QUICK_START.md) | Quick start guide |

## 🛠️ Technology Stack

| Category | Technology |
|----------|------------|
| Frontend | React 18 + Vite + Tailwind CSS |
| Backend | FastAPI (Python) |
| Database | PostgreSQL 15 or SQLite |
| Containerization | Docker + Docker Compose |

## 📁 Project Structure

```
QCA_DASHBOARD/
├── README.md           # Main documentation
├── RUN.md              # Complete run guide
├── QUICK_START.md      # Quick start guide
├── docker-compose.yml  # Docker Compose configuration
├── Dockerfile.frontend # Frontend Docker image
├── nginx.conf          # Nginx configuration
├── backend/            # FastAPI backend
│   ├── Dockerfile
│   ├── main.py
│   ├── database.py
│   ├── requirements.txt
│   └── ...
├── src/                # React frontend
│   └── ...
└── scripts/            # Start scripts
    ├── start-all.bat
    └── start-all.ps1
```

## 🐳 Docker Commands

```bash
# Start all services
docker-compose up --build

# Start in background
docker-compose up -d --build

# Stop all services
docker-compose down

# View logs
docker-compose logs -f
```

## ✨ Features

- **Dashboard**: Real-time overview of schedules and system status
- **Schedule Preparation**: Day-ahead and intraday schedule management
- **Data Inputs**: Vendor-specific template management and file uploads
- **Forecast View**: Energy generation forecasts with daily/hourly/weekly views
- **Weather Reference**: Weather data visualization for informed decision-making
- **Deviation/DSM Analysis**: Deviation monitoring and Demand Side Management
- **Reports**: Comprehensive reporting with export functionality (PDF, Excel, CSV)

## 📍 Access Points

| Service | URL |
|---------|-----|
| Frontend | http://localhost:80 (Docker) or http://localhost:5173 (Dev) |
| Backend API | http://localhost:3001 |
| API Docs | http://localhost:3001/docs |

---

**Built with ❤️ by the QCA Development Team**

