#!/bin/bash
# QCA Dashboard - One Command Start Script
# This script builds all Docker images locally and starts the entire project

set -e

echo "=========================================="
echo "  QCA Dashboard - Starting All Services"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    print_error "Docker is not running. Please start Docker first."
    exit 1
fi

print_status "Docker is running"

# Step 1: Stop any existing containers
echo ""
echo "Step 1: Cleaning up existing containers..."
docker-compose down --remove-orphans 2>/dev/null || true
print_status "Cleanup complete"

# Step 2: Pull base images first (to avoid rate limiting issues)
echo ""
echo "Step 2: Pulling base images..."
docker pull python:3.11-slim > /dev/null 2>&1 || print_warning "Could not pull python:3.11-slim (may already exist)"
docker pull node:18.19.0-alpine > /dev/null 2>&1 || print_warning "Could not pull node:18.19.0-alpine (may already exist)"
docker pull nginx:1.25-alpine > /dev/null 2>&1 || print_warning "Could not pull nginx:1.25-alpine (may already exist)"
docker pull postgres:15 > /dev/null 2>&1 || print_warning "Could not pull postgres:15 (may already exist)"
print_status "Base images ready"

# Step 3: Build all images locally (this avoids Docker Hub rate limits)
echo ""
echo "Step 3: Building Docker images locally (this may take a few minutes)..."
echo ""

# Build backend image
echo "Building backend image..."
docker build -t qca-dashboard-backend ./backend --no-cache 2>&1 | grep -E "(Step|Successfully|ERROR)" || true
print_status "Backend image built"

# Build frontend image
echo "Building frontend image..."
docker build -t qca-dashboard-frontend . -f Dockerfile.frontend --no-cache 2>&1 | grep -E "(Step|Successfully|ERROR)" || true
print_status "Frontend image built"

# Step 4: Start all services
echo ""
echo "Step 4: Starting all services..."
docker-compose up -d

# Step 5: Wait for services to be healthy
echo ""
echo "Step 5: Waiting for services to be ready..."
sleep 5

# Check if services are running
MAX_WAIT=60
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    # Check backend
    BACKEND_STATUS=$(docker inspect --format='{{.State.Running}}' qca-dashboard-backend 2>/dev/null || echo "false")
    
    if [ "$BACKEND_STATUS" = "true" ]; then
        print_status "Backend is running"
        break
    fi
    
    WAIT_COUNT=$((WAIT_COUNT + 5))
    echo "Waiting for backend to start... ($WAIT_COUNT/$MAX_WAIT seconds)"
    sleep 5
done

# Step 6: Show final status
echo ""
echo "=========================================="
echo "  QCA Dashboard - Started Successfully!"
echo "=========================================="
echo ""
echo "Access Points:"
echo "  Frontend: http://localhost:80"
echo "  Backend API: http://localhost:3001"
echo "  API Docs: http://localhost:3001/docs"
echo ""
echo "To view logs:"
echo "  docker-compose logs -f"
echo ""
echo "To stop:"
echo "  docker-compose down"
echo ""

