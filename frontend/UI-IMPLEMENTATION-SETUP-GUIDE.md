# UI Implementation Setup Guide

## QCA Renewable Energy Schedule Management Dashboard - Frontend

**Version:** 1.0.0  
**Last Updated:** 2024  
**Project:** QCA Dashboard - Vedanjay Power Control Dashboard

---

## Table of Contents

1. [Project Overview](#1️⃣-project-overview)
2. [Tools Required](#2️⃣-tools-required)
3. [Installation Steps](#3️⃣-installation-steps)
4. [Project Run Instructions](#4️⃣-project-run-instructions)
5. [Folder Structure Explanation](#5️⃣-folder-structure-explanation)
6. [Routing Architecture](#6️⃣-routing-architecture)
7. [Theme Setup (Light / Dark Mode)](#7️⃣-theme-setup-light--dark-mode)
8. [Authentication Setup](#8️⃣-authentication-setup)
9. [API & Service Layer](#9️⃣-api--service-layer)
10. [State Management](#1️⃣0️⃣-state-management)
11. [Utility Functions](#1️⃣1️⃣-utility-functions)
12. [Assets & Styling](#1️⃣2️⃣-assets--styling)
13. [Build & Deployment Steps](#1️⃣3️⃣-build--deployment-steps)
14. [Performance Optimization](#1️⃣4️⃣-performance-optimization)
15. [Known Issues / Improvements Scope](#1️⃣5️⃣-known-issues--improvements-scope)

---

## 1️⃣ Project Overview

### What the UI Project Is About

The **QCA Dashboard (Vedanjay Power Control Dashboard)** is a comprehensive web-based application designed for managing renewable energy operations, specifically for solar and wind power plants. The dashboard provides real-time monitoring, schedule preparation, deviation analysis, and reporting capabilities for energy grid operators.

### Purpose of the Application

- **Real-time Monitoring**: Track current power generation, efficiency metrics, and plant status
- **Schedule Management**: Create, prepare, and submit power generation schedules
- **Deviation Analysis**: Monitor and analyze differences between scheduled and actual power generation
- **Data Inputs**: Manage plant data, meter readings, and forecast information
- **Reporting**: Generate and export various reports for regulatory and operational purposes
- **Schedule Readiness**: Monitor plant readiness for schedule submissions

### High-level Architecture Explanation

The application follows a **Single Page Application (SPA)** architecture built with React. It uses:

- **Client-side State Management**: React Context API for global state (auth, theme, filters, data)
- **Component-based Architecture**: Modular UI components with lazy loading
- **API-first Design**: Service layer abstracts backend communication
- **Theme System**: CSS custom properties for dynamic theming

```
┌─────────────────────────────────────────────────────────────────┐
│                        Root App (App.jsx)                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ ThemeContext │  │ AuthContext  │  │ FilterContext        │  │
│  │ - theme      │  │ - user       │  │ - search            │  │
│  │ - toggle     │  │ - login      │  │ - date              │  │
│  │ - isDarkMode │  │ - logout     │  │ - state             │  │
│  └──────────────┘  └──────────────┘  │ - plant             │  │
│                                       └──────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    DataContext                            │   │
│  │  - sharedData (forecast, meter, selectedPlant, dateRange)│   │
│  └──────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────────────────────────────────┐   │
│  │   Sidebar   │  │            Main Content Area            │   │
│  │  Navigation │  │  ┌───────────────────────────────────┐  │   │
│  │             │  │  │       TopNav Component            │  │   │
│  │ - Dashboard │  │  └───────────────────────────────────┘  │   │
│  │ - Schedule  │  │  ┌───────────────────────────────────┐  │   │
│  │ - Readiness │  │  │                                   │  │   │
│  │ - Data      │  │  │     Lazy Loaded Screen           │  │   │
│  │ - Deviation │  │  │     (Dashboard, Schedule, etc)   │  │   │
│  │ - Reports   │  │  │                                   │  │   │
│  │             │  │  └───────────────────────────────────┘  │   │
│  └─────────────┘  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Technology Stack Used

| Category | Technology | Version |
|----------|------------|---------|
| **Framework** | React | 18.2.0 |
| **Build Tool** | Vite | 5.2.0 |
| **Language** | JavaScript (ES6+) | ES2022 |
| **Styling** | Tailwind CSS | 4.1.12 |
| **UI Components** | Radix UI Primitives | Latest |
| **Icons** | Lucide React | 0.487.0 |
| **Charts** | Chart.js, Recharts, Plotly.js | Latest |
| **Routing** | React Router DOM | 7.12.0 |
| **State Management** | React Context API | Built-in |
| **HTTP Client** | Native Fetch API | Built-in |
| **Forms** | React Hook Form | 7.55.0 |
| **Notifications** | Sonner | 2.0.3 |
| **Animation** | Motion | 12.23.24 |
| **PDF Generation** | jsPDF, jsPDF-AutoTable | Latest |
| **Date Handling** | date-fns | 3.6.0 |
| **Drag & Drop** | React DnD | 16.0.1 |

---

## 2️⃣ Tools Required

### Node.js

**Required Version:** 18.19.0 or higher

Node.js is the JavaScript runtime required to run the development server and build the application. The project specifically requires Node.js 18.19.0 as defined in the `engines` field of `package.json`.

**Why Required:**
- Development server execution
- Package management (npm)
- Build and bundling via Vite
- Hot module replacement during development

**Installation:**
```bash
# Using nvm (recommended)
nvm install 18.19.0
nvm use 18.19.0

# Or download from https://nodejs.org/
```

### npm (Node Package Manager)

**Required Version:** 9.9.2 or higher

npm is the default package manager for Node.js and is used to install dependencies and run scripts.

**Why Required:**
- Installing project dependencies
- Running development/build scripts
- Managing package versions

**Verification:**
```bash
npm --version  # Should output 9.9.2 or higher
```

### Code Editor

**Recommended:** Visual Studio Code (VS Code)

VS Code is the recommended code editor for this project due to:
- Excellent JavaScript/React IntelliSense
- Built-in terminal integration
- Extensive extension ecosystem
- Built-in Git support

**Recommended Extensions:**
- ES7+ React/Redux/React-Native snippets
- Tailwind CSS IntelliSense
- Prettier - Code formatter
- ESLint
- Error Lens

### Browser

**Requirements:**
- Chrome 90+ (recommended)
- Firefox 88+
- Safari 14+
- Edge 90+

**Note:** A modern browser with ES2022 support is required for modern JavaScript features used in the codebase.

### Git

**Required Version:** 2.0 or higher

Git is used for version control and is required for cloning the repository and managing code changes.

**Why Required:**
- Cloning the repository
- Version control
- Collaboration (if applicable)

### Docker (Optional - For Containerized Deployment)

**Required Version:** 20.10 or higher

Docker is optional but included in the project for containerized deployment.

**Why Required (Optional):**
- Containerized frontend deployment
- Consistent environment across machines
- Integration with docker-compose for full-stack deployment

---

## 3️⃣ Installation Steps

### Step 1: Clone Repository

```bash
# Clone the repository
git clone <repository-url>

# Navigate to project directory
cd "QCA DASHBOARD FINAL"
```

### Step 2: Navigate to Project Folder

```bash
cd "c:/Users/harsh/OneDrive/Desktop/QCA DASHBOARD FINAL"
# Or if already in the directory:
cd .
```

### Step 3: Install Dependencies

```bash
# Using npm (recommended)
npm install

# The command will install all packages from package.json including:
# - React 18.2.0 and react-dom
# - Tailwind CSS 4.1.12
# - Radix UI components
# - Chart.js, Recharts, Plotly.js
# - Lucide React icons
# - And all other dependencies
```

**Expected Output:**
- `node_modules` folder created
- All dependencies installed
- Package lock file updated (`package-lock.json`)

### Step 4: Environment Setup

The project uses environment variables for configuration. Create a `.env` file in the project root:

```bash
# Create .env file
touch .env

# Or copy from example if available
```

**Environment Variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_API_BASE_URL` | Backend API base URL | `http://localhost:3001/api` |
| `VITE_USE_REAL_API` | Use real API or mock data | `true` |

**Example .env file:**
```env
VITE_API_BASE_URL=http://localhost:3001/api
VITE_USE_REAL_API=true
```

**Note:** The `.env` file is not included in the repository for security reasons. The application will use default values if not specified.

### Step 5: Verify Installation

```bash
# Check that node_modules exists
ls node_modules | head -20

# Verify package.json is readable
cat package.json

# Check that Tailwind is installed
ls node_modules | grep tailwind
```

---

## 4️⃣ Project Run Instructions

### Development Mode

```bash
# Start development server
npm run dev
```

**What Happens:**
1. Vite starts the development server
2. Opens browser at http://localhost:5173
3. Enables hot module replacement (HMR)
4. Watches for file changes

**Default Port:** `5173`

**How to Change Port:**

Option 1: Command line
```bash
npm run dev -- --port 3000
# Or
npm run dev -- --port 8080
```

Option 2: Modify vite.config.js
```javascript
// vite.config.js
export default defineConfig({
  server: {
    port: 3000,  // Change this
    host: '0.0.0.0'
  },
  // ...
});
```

### Production Mode

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

**What Happens:**
1. Optimizes and bundles the application
2. Creates optimized assets in `dist` folder
3. Serves the production build locally for testing

**Production Build Output:** `dist/` folder

### Hot Reload

The development server includes Hot Module Replacement (HMR) which:
- Instantly updates modules in the browser without full reload
- Preserves application state during development
- Shows live preview of changes

### Troubleshooting Common Run Issues

| Issue | Solution |
|-------|----------|
| Port already in use | Change port or stop other processes using the port |
| Node modules missing | Run `npm install` |
| Memory issues | Increase Node.js memory: `NODE_OPTIONS=--max-old-space-size=4096 npm run build` |
| Build errors | Clear cache: `rm -rf node_modules/.vite` |
| SSL certificate errors | Use `--strict-port` flag or update Node.js |

---

## 5️⃣ Folder Structure Explanation

```
QCA DASHBOARD FINAL/
├── .gitignore                    # Git ignore rules
├── docker-compose.yml             # Docker compose configuration
├── Dockerfile.frontend            # Frontend Docker build
├── index.html                    # HTML entry point
├── jsconfig.json                 # JavaScript configuration
├── nginx.conf                    # Nginx configuration
├── package.json                  # Dependencies and scripts
├── package-lock.json             # Locked dependency versions
├── postcss.config.mjs            # PostCSS configuration
├── README.md                     # Project readme
├── start-docker.ps1              # Docker startup script (PowerShell)
├── start-docker.sh               # Docker startup script (Shell)
├── TODO.md                       # Project todos
├── vite.config.js                # Vite build configuration
│
├── backend/                      # Python FastAPI backend
│   ├── app/
│   │   └── __init__.py
│   ├── crud.py
│   ├── database.py
│   ├── Dockerfile
│   ├── enercast.py
│   ├── init_db.py
│   ├── main.py
│   ├── models.py
│   ├── requirements.txt
│   ├── schemas.py
│   └── wait-for-db.py
│
├── data/                         # Data folder (gitkeep)
│   └── .gitkeep
│
├── ml/                          # Machine learning modules
│   ├── .gitkeep
│   ├── enercast_parser/
│   │   ├── enercast_parser.py
│   │   ├── parser.py
│   │   └── schema_validator.py
│   └── windy_api/
│       ├── day3_api_call/
│       │   ├── fetch_windy_data.py
│       │   └── windy_raw.json
│       └── day4_data_processing/
│           ├── convert_json_to_table.py
│           └── windy_tabular.csv
│
├── public/                      # Static public assets
│   ├── vedanjay logo.png        # Company logo
│   ├── vedanjay-favicon.svg     # Favicon
│   └── vite.svg                 # Vite logo
│
├── scripts/                     # Build and startup scripts
│   ├── build.sh
│   ├── check-and-run.ps1
│   ├── start-all-manual.ps1
│   ├── start-all.bat
│   ├── start-all.ps1
│   └── start-backend-local.bat
│
└── src/                         # Main source code directory
    ├── App.jsx                  # Legacy App entry (redirects to Dashboard)
    ├── index.css                # Legacy CSS entry
    ├── main.jsx                 # Main React entry point
    │
    ├── app/                     # Main application folder
    │   ├── App.jsx              # Main App component with routing
    │   │
    │   ├── components/
    │   │   ├── ActionButtons.jsx        # Action buttons component
    │   │   ├── ChartArea.jsx            # Chart display area
    │   │   ├── DataStatusSection.jsx    # Data status display
    │   │   ├── DeviationSummary.jsx    # Deviation summary
    │   │   ├── FiltersSection.jsx       # Filter controls
    │   │   ├── ScheduleTable.jsx       # Schedule data table
    │   │   ├── Sidebar.jsx              # Navigation sidebar
    │   │   ├── TopNav.jsx               # Top navigation bar
    │   │   │
    │   │   ├── common/                  # Common/shared components
    │   │   │   ├── ErrorBoundary.jsx   # Error boundary wrapper
    │   │   │   ├── ErrorMessage.jsx     # Error display
    │   │   │   └── LoadingSpinner.jsx   # Loading indicator
    │   │   │
    │   │   ├── screens/                 # Screen/page components
    │   │   │   ├── Dashboard.jsx         # Main dashboard (CURRENT)
    │   │   │   ├── Dashboard_STYLING_TODO.md  # Styling notes
    │   │   │   ├── DataInputs.jsx       # Data input screen
    │   │   │   ├── DeviationDSM.jsx     # Deviation DSM screen
    │   │   │   ├── ForecastView.jsx     # Forecast view screen
    │   │   │   ├── Login.jsx            # Login screen
    │   │   │   ├── Reports.jsx          # Reports screen
    │   │   │   ├── ScheduleComparison.jsx  # Schedule comparison
    │   │   │   ├── SchedulePreparation.jsx # Schedule preparation
    │   │   │   ├── ScheduleReadinessDashboard.jsx # Schedule readiness
    │   │   │   ├── ScheduleTemplates.jsx # Schedule templates
    │   │   │   └── WeatherView.jsx      # Weather view screen
    │   │   │
    │   │   └── ui/                      # UI component library
    │   │       ├── accordion.jsx/.tsx
    │   │       ├── alert-dialog.tsx
    │   │       ├── alert.tsx
    │   │       ├── aspect-ratio.tsx
    │   │       ├── avatar.tsx
    │   │       ├── badge.jsx/.tsx
    │   │       ├── breadcrumb.tsx
    │   │       ├── button.jsx/.tsx
    │   │       ├── calendar.tsx
    │   │       ├── card.jsx/.tsx
    │   │       ├── carousel.tsx
    │   │       ├── chart.tsx
    │   │       ├── checkbox.tsx
    │   │       ├── collapsible.tsx
    │   │       ├── command.tsx
    │   │       ├── context-menu.tsx
    │   │       ├── dialog.tsx
    │   │       ├── drawer.tsx
    │   │       ├── dropdown-menu.tsx
    │   │       ├── form.tsx
    │   │       ├── hover-card.tsx
    │   │       ├── input-otp.tsx
    │   │       ├── input.jsx/.tsx
    │   │       ├── label.jsx/.tsx
    │   │       ├── menubar.tsx
    │   │       ├── navigation-menu.tsx
    │   │       ├── pagination.tsx
    │   │       ├── PlantForm.jsx         # Plant creation form
    │   │       ├── popover.tsx
    │   │       ├── progress.tsx
    │   │       ├── radio-group.tsx
    │   │       ├── resizable.tsx
    │   │       ├── scroll-area.tsx
    │   │       ├── select.tsx
    │   │       ├── separator.tsx
    │   │       ├── sheet.tsx
    │   │       ├── sidebar.tsx
    │   │       ├── skeleton.tsx
    │   │       ├── slider.tsx
    │   │       ├── sonner.tsx           # Toast notifications
    │   │       ├── switch.tsx
    │   │       ├── table.jsx/.tsx
    │   │       ├── tabs.tsx
    │   │       ├── textarea.tsx
    │   │       ├── toggle-group.tsx
    │   │       ├── toggle.tsx
    │   │       ├── tooltip.tsx
    │   │   ├── use-mobile.js/.ts       # Mobile detection hook
    │   │   └── utils.js/.ts            # Utility functions
    │   │
    ├── components/              # Legacy components (UNUSED)
    │   ├── ChartPanel.jsx
    │   ├── MainChartArea.jsx
    │   ├── Navbar.jsx
    │   ├── RightSidebar.jsx
    │   ├── ScheduleTable.jsx
    │   ├── Sidebar.jsx
    │   ├── TogglePanel.jsx
    │
    ├── data/                   # Data files (used by old dashboard)
    │   ├── assetsData.js       # Asset/plant definitions
    │   ├── chartData.js
    │   └── timeUtils.js        # Time utility functions
    │
    ├── hooks/                  # Custom React hooks
    │   ├── useApi.js           # API call hook with loading/error
    │   └── useScheduleReadiness.js
    │
    ├── pages/                 # Legacy pages (UNUSED)
    │   └── Dashboard.jsx      # Old dashboard implementation
    │
    ├── services/               # API services
    │   ├── api.js             # Main API service (mock + real)
    │   └── mockDataService.js
    │
    ├── styles/                # Styling files
    │   ├── fonts.css          # Font definitions
    │   ├── index.css          # Main CSS entry
    │   ├── tailwind.css       # Tailwind imports
    │   └── theme.css          # Theme variables (light/dark)
    │
    └── utils/                 # Utility functions
        └── csvExport.js       # CSV export utilities
```

### Detailed Folder Explanations

#### `src/app/` - Main Application

This is the primary application folder containing the current implementation.

| Folder/File | Purpose | Key Functions/Classes |
|-------------|---------|----------------------|
| `App.jsx` | Root component with routing, contexts, and layout | State management for auth, theme, filters, navigation |
| `components/ActionButtons.jsx` | Reusable action button components | Buttons for CRUD operations |
| `components/ChartArea.jsx` | Chart display wrapper | Integration with Chart.js/Recharts |
| `components/Sidebar.jsx` | Navigation sidebar | Menu items, collapse/expand |
| `components/TopNav.jsx` | Top navigation bar | User info, logout, theme toggle |
| `screens/*.jsx` | Page components | Dashboard, Schedule, Reports, etc. |
| `components/ui/` | UI component library | Radix-based reusable components |

#### `src/components/` - Legacy Components (UNUSED)

This folder contains older implementation components that are no longer actively used.

**Status:** This file is currently not used in the project.

The legacy components include:
- `ChartPanel.jsx`
- `MainChartArea.jsx`
- `Navbar.jsx`
- `RightSidebar.jsx`
- `ScheduleTable.jsx`
- `Sidebar.jsx`
- `TogglePanel.jsx`

#### `src/pages/` - Legacy Pages (UNUSED)

This folder contains the old dashboard implementation.

**Status:** This file is currently not used in the project.

The legacy dashboard used:
- Local state for assets and theme
- Different component structure
- Direct imports from `src/components/`

#### `src/services/` - API Layer

| File | Purpose | Key Functions |
|------|---------|----------------|
| `api.js` | Main API service with mock/fallback | `api.dashboard`, `api.plants`, `api.schedules`, `api.forecasts`, `api.reports`, `api.deviations`, `api.weather`, `api.templates` |

#### `src/hooks/` - Custom Hooks

| File | Purpose | Key Functions |
|------|---------|----------------|
| `useApi.js` | API call management | `useApi()`, `useMultipleApi()`, `usePaginatedApi()` |

#### `src/styles/` - Styling

| File | Purpose |
|------|---------|
| `theme.css` | CSS custom properties for light/dark themes |
| `tailwind.css` | Tailwind CSS v4 imports |
| `index.css` | Main CSS entry point |
| `fonts.css` | Font definitions |

#### `src/data/` - Data Files

| File | Purpose |
|------|---------|
| `assetsData.js` | Plant/asset definitions (legacy) |
| `timeUtils.js` | Time slot generation |
| `chartData.js` | Chart data structures |

#### `src/utils/` - Utilities

| File | Purpose |
|------|---------|
| `csvExport.js` | CSV export functionality |

---

## 6️⃣ Routing Architecture

### Overview

The application uses **client-side state-based routing** rather than traditional URL-based routing. Navigation is managed through React state in the main `App.jsx` component.

### Navigation Flow

```
┌─────────────────────────────────────────────────────────────┐
│                      App.jsx                                │
├─────────────────────────────────────────────────────────────┤
│  State: activeScreen (string)                               │
│  - 'dashboard'                                              │
│  - 'schedule'                                               │
│  - 'schedule-readiness'                                    │
│  - 'data-inputs'                                            │
│  - 'deviation'                                              │
│  - 'schedule-comparison'                                    │
│  - 'templates'                                               │
│  - 'reports'                                                 │
│  - 'weather'                                                 │
│  - 'forecast'                                               │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
    ┌─────────────────┐
    │   Sidebar.jsx  │
    │  Navigation    │
    │  Menu Items   │
    └─────────────────┘
              │
              ▼
    ┌─────────────────┐
    │  renderScreen()│
    │    Function    │
    └─────────────────┘
              │
              ▼
    ┌────────────────────────────────────────────────────────┐
    │              Lazy Loaded Screens                       │
    │  - Dashboard (lazy)                                   │
    │  - SchedulePreparation (lazy)                         │
    │  - ScheduleReadinessDashboard (lazy)                 │
    │  - DataInputs (lazy)                                  │
    │  - ForecastView (lazy)                               │
    │  - WeatherView (lazy)                                 │
    │  - DeviationDSM (lazy)                               │
    │  - ScheduleTemplates (lazy)                          │
    │  - Reports (lazy)                                     │
    │  - ScheduleComparison (lazy)                         │
    └────────────────────────────────────────────────────────┘
```

### Navigation Menu Items

| Menu Label | Screen ID | Component |
|------------|-----------|-----------|
| Dashboard | `dashboard` | Dashboard.jsx |
| Schedule Preparation | `schedule` | SchedulePreparation.jsx |
| Schedule Readiness | `schedule-readiness` | ScheduleReadinessDashboard.jsx |
| Data Inputs | `data-inputs` | DataInputs.jsx |
| Deviation/DSM | `deviation` | DeviationDSM.jsx |
| Schedule Comparison | `schedule-comparison` | ScheduleComparison.jsx |
| Schedule Templates | `templates` | ScheduleTemplates.jsx |
| Reports | `reports` | Reports.jsx |

### Protected Routes

Routes are protected through authentication state:

```javascript
// In App.jsx
if (!isAuthenticated) {
  return <Login onLogin={handleLogin} />;
}

return (
  // Full application with Sidebar and TopNav
  <div className="h-screen flex flex-col">
    <TopNav />
    <div className="flex flex-1">
      <Sidebar />
      {renderScreen()}
    </div>
  </div>
);
```

### Admin Login Flow

1. **Initial State**: User sees login screen
2. **Credentials**: Admin credentials (hardcoded: admin/admin)
3. **Authentication**: Validates credentials, stores user in localStorage
4. **Navigation**: Redirects to dashboard after successful login
5. **Session**: Persists in localStorage (user + token)

### Role-Based Access

Currently implemented with a single **admin** role. The `AuthContext` provides:

```javascript
{
  user: {
    email: 'admin',
    role: 'admin',
    name: 'Admin',
    token: 'vedanjay-token-...'
  },
  isAuthenticated: true,
  login: handleLogin,
  logout: handleLogout
}
```

---

## 7️⃣ Theme Setup (Light / Dark Mode)

### Overview

The application implements a comprehensive light/dark theme system using CSS custom properties (CSS variables) and Tailwind CSS v4.

### Theme Implementation

#### Theme Storage

Theme is persisted in **localStorage** under the key `vedanjay-theme`.

```javascript
// App.jsx
const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light');
```

#### Theme Context

```javascript
// App.jsx
const themeContextValue = useMemo(
  () => ({
    theme,
    setTheme,
    toggleTheme,
    isDarkMode: theme === 'dark',
  }),
  [theme]
);
```

#### Theme Application Effect

```javascript
useEffect(() => {
  const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, normalizedTheme);

  document.documentElement.classList.remove('dark', 'light');
  document.body.classList.remove('theme-dark', 'theme-light');

  document.documentElement.classList.add(normalizedTheme);
  document.body.classList.add(`theme-${normalizedTheme}`);
  document.body.setAttribute('data-theme', normalizedTheme);
}, [theme]);
```

### CSS Variables (theme.css)

#### Light Theme Variables

```css
:root {
  /* Primary Colors */
  --background: #f5f7f7;
  --foreground: #1f2937;
  --card: #ffffff;
  --card-foreground: #1f2937;
  --primary: #22c55e;        /* Green - Vedanjay brand */
  --primary-foreground: #f8fffb;
  
  /* Secondary Colors */
  --secondary: #334155;
  --secondary-foreground: #ffffff;
  
  /* Muted Colors */
  --muted: #e9eef0;
  --muted-foreground: #64748b;
  
  /* Accent Colors */
  --accent: #edf5ef;
  --accent-foreground: #1f2937;
  
  /* Semantic Colors */
  --destructive: #dc2626;
  --border: #d7e2dd;
  --ring: #22c55e;
  --success: #22c55e;
  --warning: #d97706;
  --info: #0284c7;
  
  /* Sidebar */
  --sidebar: #ffffff;
  --sidebar-foreground: #1f2937;
  --sidebar-primary: #22c55e;
  --sidebar-accent: #eef7f1;
  --sidebar-border: #d7e2dd;
}
```

#### Dark Theme Variables

```css
.dark {
  --background: #111827;
  --foreground: #f1f5f9;
  --card: #1f2937;
  --card-foreground: #f1f5f9;
  --popover: #111827;
  --popover-foreground: #f1f5f9;
  --primary: #22c55e;
  --primary-foreground: #052e16;
  --secondary: #334155;
  --secondary-foreground: #f1f5f9;
  --muted: #334155;
  --muted-foreground: #94a3b8;
  --accent: #273244;
  --accent-foreground: #f1f5f9;
  --destructive: #ef4444;
  --border: #334155;
  --input: #334155;
  --ring: #22c55e;
  --success: #22c55e;
  --warning: #f59e0b;
  --info: #38bdf8;
  
  /* Sidebar */
  --sidebar: #111827;
  --sidebar-foreground: #f1f5f9;
  --sidebar-primary: #22c55e;
  --sidebar-accent: #1f2937;
  --sidebar-border: #334155;
}
```

### Tailwind Integration

The theme is integrated with Tailwind CSS v4 using the `@theme` directive:

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  /* ... more variables */
}
```

### Theme Toggle Component

The theme can be toggled from:

1. **Login Screen**: Moon/Sun icon button
2. **TopNav**: Theme toggle button in the navigation bar

```jsx
<button onClick={toggleTheme}>
  {isDarkMode ? <Sun /> : <Moon />}
</button>
```

### How UI Components Adapt

Components use Tailwind utility classes that automatically respond to theme:

```jsx
<div className="bg-background text-foreground">
  <button className="bg-primary hover:bg-primary/90">
    Primary Button
  </button>
  <div className="border-border">
    Bordered Card
  </div>
</div>
```

### Modifying Theme Colors

To modify theme colors, edit the CSS variables in `src/styles/theme.css`:

1. **Primary Color**: Change `--primary` value
2. **Background Colors**: Modify `--background`, `--card`, etc.
3. **Text Colors**: Update `--foreground`, `--muted-foreground`
4. **Semantic Colors**: Modify `--success`, `--warning`, `--destructive`

---

## 8️⃣ Authentication Setup

### Overview

The application uses a simple authentication system with hardcoded credentials (admin + per-employee accounts).

### Login Implementation

#### Credentials

```javascript
// Login.jsx
const ADMIN_ACCOUNT = {
  username: 'Scheduling_VPPL',
  password: 'Scheduling@vppl54',
};

// Team accounts use:
// username = EMPID (example: VPPL6127)
// password = EMPID#BIRTHYEAR (example: VPPL6127#1995)
```

#### Login Flow

```javascript
const handleSubmit = async (e) => {
  e.preventDefault();
  
  // Admin: username/password must match ADMIN_ACCOUNT.
  // Employee: username must match an empId and password must equal `EMPID#BIRTHYEAR`.
  // On success, it stores `vedanjay-user` + `vedanjay-token` in localStorage and calls `onLogin(userData)`.
};
```

### Storage Mechanism

User session is stored in **localStorage**:

| Key | Value | Purpose |
|-----|-------|---------|
| `vedanjay-user` | JSON object | User data (email, role, name) |
| `vedanjay-token` | String | Authentication token |

### Route Protection Logic

```javascript
// App.jsx
const isAuthenticated = Boolean(currentUser && localStorage.getItem(AUTH_TOKEN_KEY));

if (!isAuthenticated) {
  return (
    <ThemeContext.Provider value={themeContextValue}>
      <AuthContext.Provider value={authContextValue}>
        <Login onLogin={handleLogin} />
        <Toaster />
      </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}

// Render full application
return <MainLayout />;
```

### Logout Flow

```javascript
const handleLogout = () => {
  localStorage.removeItem(AUTH_USER_KEY);
  localStorage.removeItem(AUTH_TOKEN_KEY);
  setCurrentUser(null);
  setActiveScreen('dashboard');
  setScreenContext(null);
};
```

### Auth Context

```javascript
export const AuthContext = createContext();

const authContextValue = useMemo(
  () => ({
    user: currentUser,
    isAuthenticated,
    login: handleLogin,
    logout: handleLogout,
  }),
  [currentUser, isAuthenticated]
);
```

---

## 9️⃣ API & Service Layer

### Overview

The application uses a service layer (`src/services/api.js`) that provides both mock data and real API integration.

### API Configuration

```javascript
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';
const USE_REAL_API = import.meta.env.VITE_USE_REAL_API !== 'false';
const MOCK_DELAY = 300;
```

### Base URL Setup

The backend API base URL can be configured via environment variable:
- Default: `http://localhost:3001/api`
- Environment: `VITE_API_BASE_URL`

### Error Handling

```javascript
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function fetchWithError(url, options = {}) {
  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new ApiError(
        errorData.message || `HTTP ${response.status}`,
        response.status,
        errorData
      );
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(error.message || 'Network request failed', 0, { originalError: error });
  }
}
```

### Service Architecture

The API service is organized by resource:

| Service | Endpoints | Description |
|---------|-----------|-------------|
| `api.dashboard` | `getStats()`, `getSummary()` | Dashboard statistics |
| `api.plants` | `getAll()`, `getById()`, `create()`, `update()`, `delete()` | Plant management |
| `api.schedules` | `getAll()`, `getById()`, `create()`, `update()`, `delete()`, `bulkUpload()` | Schedule management |
| `api.forecasts` | `getAll()`, `getForecastData()`, `compare()` | Forecast data |
| `api.reports` | `generate()`, `getAll()`, `download()`, `delete()` | Report generation |
| `api.deviations` | `getAll()`, `getByPeriod()` | Deviation tracking |
| `api.weather` | `getCurrent()`, `getForecast()` | Weather data |
| `api.templates` | `getAll()`, `create()`, `delete()` | Schedule templates |
| `api.whatsappData` | `getAll()`, `create()`, `update()`, `delete()` | WhatsApp data |
| `api.meterData` | `getAll()`, `getLatest()`, `getDataPoints()` | Meter readings |

### Data Fetching Pattern

```javascript
// Example: Fetching plant data
const { data, loading, error, execute } = useApi(() => api.plants.getAll({ type: 'Solar' }), {
  immediate: true,
  initialData: { plants: [], total: 0 }
});

// Execute manually
await execute();
```

### S3 Integration

The Dashboard includes S3 integration for schedule file storage:

```javascript
const S3_BUCKET = 'forecast--storage';
const S3_REGION = 'ap-south-1';
const S3_BASE_URL = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
const S3_OUTPUTS_PREFIX = 'outputs/';
```

**S3 Operations:**
- List schedule files: `listS3Objects(prefix)`
- Fetch CSV files: `fetchCsvFromS3(key)`
- Parse schedule data: `parseS3ListXml()`, `parseCsv()`, `parseMeterCsv()`

---

## 1️⃣0️⃣ State Management

### Overview

The application uses **React Context API** for global state management, combined with local component state.

### Context Structure

| Context | Purpose | State Variables |
|---------|---------|-----------------|
| `ThemeContext` | Theme management | `theme`, `setTheme`, `toggleTheme`, `isDarkMode` |
| `AuthContext` | Authentication | `user`, `isAuthenticated`, `login`, `logout` |
| `FilterContext` | Global filters | `filters`, `updateFilters` |
| `DataContext` | Shared data | `sharedData`, `updateSharedData`, `clearSharedData` |

### Global State Definition

```javascript
// FilterContext
const [globalFilters, setGlobalFilters] = useState({
  search: '',
  date: '',
  state: 'All States',
  plant: 'All Plants',
});

// DataContext
const [sharedData, setSharedData] = useState({
  forecastData: null,
  meterData: null,
  selectedPlant: null,
  dateRange: null,
});
```

### Component Consumption

```javascript
// Using custom hooks to consume contexts
export function useFilters() {
  return useContext(FilterContext);
}

export function useData() {
  return useContext(DataContext);
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function useAuth() {
  return useContext(AuthContext);
}
```

### How Components Consume State

```javascript
function DashboardComponent() {
  const { filters, updateFilters } = useFilters();
  const { sharedData, updateSharedData } = useData();
  const { theme, isDarkMode } = useTheme();
  const { user, logout } = useAuth();
  
  // Use state...
}
```

---

## 1️⃣1️⃣ Utility Functions

### useApi Hook

Located in `src/hooks/useApi.js`, provides API call management:

```javascript
// Single API call
const { data, loading, error, execute, reset } = useApi(
  () => api.dashboard.getStats(),
  { immediate: true, initialData: null }
);

// Multiple API calls
const { data, loading, errors, execute } = useMultipleApi([
  () => api.plants.getAll(),
  () => api.schedules.getAll()
]);

// Paginated API
const { data, loading, error, page, totalPages, nextPage, prevPage } = 
  usePaginatedApi(() => api.reports.getAll({ page, pageSize: 10 }));
```

### Time Utilities

```javascript
// src/data/timeUtils.js
export const generateTimeSlots = () => {
  const slots = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
};
// Returns: ["00:00", "00:15", "00:30", ..., "23:45"]
```

### CSV Export Utility

```javascript
// src/utils/csvExport.js
// CSV export functionality for various data types
```

### Dashboard Helper Functions

From `src/app/components/screens/Dashboard.jsx`:

| Function | Purpose |
|----------|---------|
| `parseS3ListXml(xml)` | Parse S3 XML listing response |
| `listS3Objects(prefix)` | List objects in S3 bucket |
| `parseCsv(text)` | Parse general CSV data |
| `parseMeterCsv(text)` | Parse meter CSV specifically |
| `fetchCsvFromS3(key)` | Fetch CSV file from S3 |
| `formatTimeFromIso(iso)` | Format ISO timestamp to time |
| `getDateList(endDate, days)` | Generate date list |
| `exportToCSV(data, filename)` | Export data as CSV |

### Date Formatting

Uses `date-fns` library for date manipulation:

```javascript
import { format, parse, addDays, subDays } from 'date-fns';

// Format date
format(new Date(), 'yyyy-MM-dd');

// Parse date
parse(dateString, 'yyyy-MM-dd', new Date());

// Date arithmetic
addDays(new Date(), 7);
subDays(new Date(), 1);
```

---

## 1️⃣2️⃣ Assets & Styling

### Logo Integration

**Logo Location:** `public/vedanjay logo.png`

**Usage in Components:**
```jsx
// Sidebar.jsx
<img src="/vedanjay logo.png" alt="Vedanjay logo" className="w-8 h-8 rounded-lg" />

// Login.jsx
<img src="/vedanjay logo.png" alt="Vedanjay logo" className="w-16 h-16 rounded-2xl" />
```

### Favicon

**Location:** `public/vedanjay-favicon.svg`

Defined in `index.html`:
```html
<link rel="icon" type="image/svg+xml" href="/vedanjay-favicon.svg" />
```

### CSS/Tailwind Usage

The project uses **Tailwind CSS v4** with the following configuration:

**Tailwind Configuration (vite.config.js):**
```javascript
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

**Tailwind Imports (src/styles/tailwind.css):**
```css
@import 'tailwindcss' source(none);
@source '../**/*.{js,ts,jsx,tsx}';
@import 'tw-animate-css';
```

### Global Styles

**Entry Point:** `src/styles/index.css`

```css
/* Base styles */
* {
  @apply border-border outline-ring/50;
}

html {
  font-size: var(--font-size);
}

body {
  @apply bg-background text-foreground;
  font-family: 'Poppins', 'Segoe UI', 'Inter', sans-serif;
  transition: background-color 0.3s ease, color 0.3s ease;
}
```

### Responsive Design

The application uses Tailwind's responsive utilities:

| Breakpoint | Width | Usage |
|------------|-------|-------|
| `sm` | 640px | Small screens |
| `md` | 768px | Tablets (default) |
| `lg` | 1024px | Laptops |
| `xl` | 1280px | Desktops |
| `2xl` | 1536px | Large screens |

**Example:**
```jsx
<div className="hidden md:block">
  {/* Desktop sidebar */}
</div>

<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
  {/* Responsive grid */}
</div>
```

### Branding Colors

| Color | Hex | Usage |
|-------|-----|-------|
| Primary (Green) | `#22c55e` | Main actions, highlights |
| Secondary (Slate) | `#334155` | Secondary elements |
| Success | `#22c55e` | Success states |
| Warning | `#d97706` | Warning states |
| Info | `#0284c7` | Information |
| Destructive | `#dc2626` | Errors, destructive actions |

---

## 1️⃣3️⃣ Build & Deployment Steps

### Production Build Command

```bash
# Build for production
npm run build
```

**What happens:**
1. Vite optimizes and bundles the application
2. JavaScript and CSS are minified
3. Assets are hashed for cache busting
4. Output goes to `dist/` folder

### Output Folder

```
dist/
├── index.html
├── assets/
│   ├── index-*.css        # Hashed CSS files
│   ├── index-*.js         # Hashed JS bundles
│   └── images/            # Optimized images
└── favicon.svg
```

### Environment Differences

| Aspect | Development | Production |
|--------|-------------|------------|
| **API URL** | localhost:3001 | Configurable via env |
| **Mock Data** | Optional (env) | Usually real API |
| **Source Maps** | Yes | No (optimized) |
| **Minification** | No | Yes |
| **Hot Reload** | Yes | No |
| **Caching** | None | Aggressive |

### Deployment Steps

#### Option 1: Static Hosting

1. **Build the project:**
   ```bash
   npm run build
   ```

2. **Deploy the `dist/` folder** to any static hosting:
   - Netlify
   - Vercel
   - AWS S3 + CloudFront
   - Nginx/Apache server

3. **Configure environment variables** for production:
   ```env
   VITE_API_BASE_URL=https://your-api.com/api
   VITE_USE_REAL_API=true
   ```

#### Option 2: Docker

1. **Build Docker image:**
   ```bash
   docker build -t qca-dashboard-frontend .
   ```

2. **Run container:**
   ```bash
   docker run -p 80:80 qca-dashboard-frontend
   ```

3. **Using docker-compose:**
   ```bash
   docker-compose up --build
   ```

#### Option 3: Nginx

The project includes `nginx.conf` for Nginx deployment:

```nginx
# Configuration for serving static files
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### Changing Environment Variables for Production

Create/modify `.env.production` or set environment variables:

```bash
# Build with production API
VITE_API_BASE_URL=https://production-api.example.com/api npm run build

# Or create .env file
echo "VITE_API_BASE_URL=https://api.example.com" > .env
echo "VITE_USE_REAL_API=true" >> .env
npm run build
```

---

## 1️⃣4️⃣ Performance Optimization

### Lazy Loading

The application uses React's `lazy()` and `Suspense` for code splitting:

```javascript
const Dashboard = lazy(() =>
  import('./components/screens/Dashboard').then((module) => ({ default: module.Dashboard }))
);

const SchedulePreparation = lazy(() =>
  import('./components/screens/SchedulePreparation').then((module) => ({
    default: module.SchedulePreparation,
  }))
);

// Usage
<Suspense fallback={<LoadingSpinner />}>
  {renderScreen()}
</Suspense>
```

**Lazy Loaded Screens:**
- Dashboard
- SchedulePreparation
- ScheduleReadinessDashboard
- DataInputs
- ForecastView
- WeatherView
- DeviationDSM
- ScheduleTemplates
- Reports
- ScheduleComparison

### Code Splitting

- Each screen is a separate chunk
- UI components from `src/app/components/ui/` are imported on-demand
- Reduces initial bundle size

### Bundle Optimization

Vite handles optimization automatically:
- Tree shaking
- Code splitting
- Dynamic imports
- Asset optimization

### Image Optimization

- SVG for icons (Lucide React)
- SVG for logo/favicon
- CSS-based animations (reduced image usage)

### Additional Optimizations

| Technique | Implementation |
|-----------|----------------|
| Memoization | `useMemo()`, `useCallback()` |
| Context splitting | Separate contexts for different concerns |
| Virtual scrolling | For large tables (if needed) |
| Debouncing | Input filters |

---

## 1️⃣5️⃣ Known Issues / Improvements Scope

### Unused Files

The following files are identified as currently not used in the project:

1. **`src/pages/Dashboard.jsx`**
   - Status: Legacy dashboard implementation
   - Replaced by: `src/app/components/screens/Dashboard.jsx`

2. **`src/components/`** (entire folder)
   - Status: Legacy components
   - Files include:
     - `ChartPanel.jsx`
     - `MainChartArea.jsx`
     - `Navbar.jsx`
     - `RightSidebar.jsx`
     - `ScheduleTable.jsx`
     - `Sidebar.jsx`
     - `TogglePanel.jsx`

3. **`src/data/chartData.js`**
   - Status: Unused data file
   - May have been used by old dashboard

4. **`src/utils/csvExport.js`**
   - Status: Appears unused
   - CSV export is handled within components

5. **`src/hooks/useScheduleReadiness.js`**
   - Status: Needs verification
   - May be used by ScheduleReadinessDashboard

### Hardcoded Values

1. **Login Credentials:**
   ```javascript
   // Admin (hardcoded)
   const ADMIN_USERNAME = 'Scheduling_VPPL';
   const ADMIN_PASSWORD = 'Scheduling@vppl54';

   // Team accounts (hardcoded)
   // username = EMPID
   // password = EMPID#BIRTHYEAR
   ```
   - Current auth is frontend-only (localStorage gate); use backend auth for real security.

2. **S3 Configuration:**
   ```javascript
   const S3_BUCKET = 'forecast--storage';
   const S3_REGION = 'ap-south-1';
   ```
   - Should be environment variables

3. **Dashboard Plant Options:**
   ```javascript
   const DASHBOARD_PLANT_OPTIONS = [
     { name: 'Globus Steel N Power (GSNP)', type: 'Solar' },
   ];
   ```
   - Should come from API

### Improvement Areas

1. **Authentication**
   - Implement proper JWT authentication
   - Add role-based access control (RBAC)
   - Add session timeout handling
   - Move credentials to backend

2. **API Integration**
   - Complete mock-to-real API transition
   - Add API retry logic
   - Implement request caching

3. **Error Handling**
   - Global error boundary improvements
   - User-friendly error messages
   - Error logging/monitoring

4. **Performance**
   - Implement virtual scrolling for large tables
   - Add skeleton loaders
   - Optimize chart rendering

5. **Accessibility**
   - ARIA label improvements
   - Keyboard navigation
   - Screen reader support

6. **Testing**
   - Add unit tests (Jest/React Testing Library)
   - Add E2E tests (Cypress/Playwright)
   - Test coverage reporting

7. **Code Quality**
   - Add TypeScript for type safety
   - Improve component documentation
   - Remove unused code/files
   - Add ESLint/Prettier configuration

8. **Environment Configuration**
   - Add environment-specific configs
   - Secure sensitive data storage

---

## Quick Start Commands

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Docker deployment
docker-compose up --build
```

---

*Document generated for QCA Dashboard - Vedanjay Power Control Dashboard*

