#!/bin/bash

# QCA Dashboard Build Script
echo "🚀 Building QCA Dashboard..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Build the Docker image
echo "📦 Building Docker image..."
docker-compose build

# Check if build was successful
if [ $? -eq 0 ]; then
    echo "✅ Build successful!"
    echo ""
    echo "📋 Next steps:"
    echo "   1. Start the application:"
    echo "      docker-compose up"
    echo ""
    echo "   2. Access the dashboard:"
    echo "      http://localhost:3000"
    echo ""
    echo "   3. Stop the application:"
    echo "      docker-compose down"
else
    echo "❌ Build failed. Please check the error messages above."
    exit 1
fi
