#!/bin/bash

# Quick Deployment Script for Voxel FPS
# This script helps you deploy the game to various platforms

echo "🎮 Voxel FPS Deployment Script"
echo "================================"
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

echo "✅ Node.js and npm detected"
echo ""

# Build the project
echo "📦 Building project..."
npm install
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed. Please fix errors and try again."
    exit 1
fi

echo "✅ Build successful"
echo ""

# Show deployment options
echo "🚀 Choose deployment platform:"
echo "1. Railway (Recommended - Free tier)"
echo "2. Render (Free tier)"
echo "3. Vercel (Frontend only)"
echo "4. Fly.io (Free tier)"
echo "5. Custom server (VPS)"
echo ""

read -p "Enter choice (1-5): " choice

case $choice in
    1)
        echo ""
        echo "🚂 Deploying to Railway..."
        echo ""
        
        # Check if Railway CLI is installed
        if ! command -v railway &> /dev/null; then
            echo "📦 Installing Railway CLI..."
            npm install -g @railway/cli
        fi
        
        echo "🔐 Logging in to Railway..."
        railway login
        
        echo "📝 Initializing project..."
        railway init
        
        echo "🚀 Deploying..."
        railway up
        
        echo ""
        echo "✅ Deployment complete!"
        echo ""
        echo "🌐 Getting public URL..."
        railway domain
        
        echo ""
        echo "🎮 Your game is live!"
        echo ""
        echo "⚠️  Remember to update src/game/game.ts line 2181"
        echo "   Change ws://localhost:3000 to your Railway URL"
        echo "   Then run: npm run build && railway up"
        ;;
        
    2)
        echo ""
        echo "🎨 Deploying to Render..."
        echo ""
        echo "📋 Steps:"
        echo "1. Push your code to GitHub"
        echo "2. Go to https://render.com/"
        echo "3. Click 'New Web Service'"
        echo "4. Connect your GitHub repository"
        echo "5. Set Build Command: npm install && npm run build"
        echo "6. Set Start Command: npm run server"
        echo "7. Click 'Deploy'"
        echo ""
        echo "✅ Your game will be live at: https://your-app.onrender.com"
        ;;
        
    3)
        echo ""
        echo "▲ Deploying frontend to Vercel..."
        echo ""
        
        # Check if Vercel CLI is installed
        if ! command -v vercel &> /dev/null; then
            echo "📦 Installing Vercel CLI..."
            npm install -g vercel
        fi
        
        echo "🚀 Deploying..."
        vercel
        
        echo ""
        echo "✅ Frontend deployed!"
        echo ""
        echo "⚠️  Note: You need to deploy the server separately"
        echo "   Use Railway or Render for the server"
        ;;
        
    4)
        echo ""
        echo "🪁 Deploying to Fly.io..."
        echo ""
        
        # Check if Fly CLI is installed
        if ! command -v fly &> /dev/null; then
            echo "📦 Installing Fly CLI..."
            curl -L https://fly.io/install.sh | sh
        fi
        
        echo "🔐 Logging in..."
        fly auth login
        
        echo "🚀 Launching app..."
        fly launch
        
        echo "🚀 Deploying..."
        fly deploy
        
        echo ""
        echo "✅ Deployment complete!"
        echo "🌐 Your game is live at: https://your-app.fly.dev"
        ;;
        
    5)
        echo ""
        echo "🖥️  Custom server deployment..."
        echo ""
        echo "📋 Steps:"
        echo "1. Copy project files to your VPS"
        echo "2. Install Node.js on the server"
        echo "3. Run: npm install"
        echo "4. Run: npm run build"
        echo "5. Run: npm run server"
        echo "6. Set up reverse proxy (nginx)"
        echo "7. Configure SSL certificate"
        echo ""
        echo "✅ Your game will be live at: https://your-domain.com"
        ;;
        
    *)
        echo "❌ Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "🎉 Deployment complete!"
echo ""
echo "📖 For more details, see DEPLOYMENT.md"
echo ""
