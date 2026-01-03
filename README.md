# Automated Scheduling for Solar & Wind Power Plants

## Overview
This project aims to automate generation scheduling for solar and wind power plants
to minimize financial penalties caused by over- or under-injection into the grid.

The system replaces manual, experience-based scheduling with a machine-learning
and optimization-driven approach that explicitly models forecast uncertainty.

## Problem Context
Renewable power plants must submit day-ahead and intraday generation schedules
to grid authorities (SLDC's/ RLDC's). Manual scheduling struggles with weather uncertainty and
results in deviation (DSM) penalties.

This system automates scheduling using probabilistic forecasts and penalty-aware
optimization.

## Core Inputs
- Enercast forecast data (CSV)
- Windy commercial weather API
- Site operational messages (WhatsApp messages)
- Historical generation data (if available)

## System Architecture
1. Data ingestion and preprocessing
2. ML ensemble forecasting (P10 / P50 / P90)
3. Penalty-minimizing schedule optimizer
4. Backend API layer
5. React-based visualization dashboard
6. Authority-compliant CSV schedule generation

## Repository Structure
ml/        - Forecasting models, preprocessing, and scheduling logic  
backend/   - API layer and system integration services  
frontend/  - Visualization dashboard (React)  
data/      - Sample schemas and mock inputs  
docs/      - Technical documentation  

## Development Environment (Initial)
- Python: 3.11.8
- ML: LightGBM / XGBoost
- Backend: FastAPI (Python)
- Frontend: React 18.2.0

## Contribution Guidelines
- `main` branch remains stable
- All development happens on feature branches
- Contributors work only within assigned modules
- Merges to `main` are reviewed by the maintainer
 