# 🚀 Deployment Guide - Host Your Game for Testing

This guide explains how to deploy your Voxel FPS game so others can test it online.

## 📋 Prerequisites

- GitHub account
- Node.js 18+ installed locally
- Basic command line knowledge

---

## 🎯 Quick Deployment Options

### Option 1: Railway + Vercel (⭐ Recommended - Easiest)

**Time:** 5 minutes  
**Cost:** Free tier  
**Difficulty:** ⭐ Very Easy

#### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit - Voxel FPS game"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/voxel-fps.git
git push -u origin main
```

#### Step 2: Deploy to Railway
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repository
5. Railway auto-detects Node.js
6. Add environment variable:
   - Key: `PORT`
   - Value: `3000`
7. Click "Deploy"

#### Step 3: Get Your Server URL
After deployment, Railway gives you a URL like:
```
https://voxel-fps.up.railway.app
```

#### Step 4: Share with Friends!
That's it! Because Voxel FPS uses a unified full-stack architecture, **Railway serves both the client web game and the WebSocket server** simultaneously.

You do **not** need to edit any code or configure separate client hosting:
1. Share `https://voxel-fps.up.railway.app` with your friends.
2. They open the link in any browser, click **Multiplayer**, and click **Connect & Deploy**.
3. Or click **"Copy Link"** in the Multiplayer lobby to copy a direct invite link (e.g. `?mode=online&team=red`) so opponents immediately join on the opposing team!

---

### Option 2: Render (Free Tier)

**Time:** 5 minutes  
**Cost:** Free (750 hours/month)  
**Difficulty:** ⭐ Very Easy

#### Deploy Server
1. Go to [render.com](https://render.com)
2. Sign up with GitHub
3. Click "New" → "Web Service"
4. Connect your repository
5. Configure:
   - **Name:** voxel-fps-server
   - **Environment:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm run server`
6. Add environment variable:
   - Key: `PORT`
   - Value: `3000`
7. Click "Create Web Service"

Get URL: `wss://voxel-fps-server.onrender.com`

#### Deploy Client
Same as Railway Option - use Vercel or Netlify.

---

### Option 3: VPS (DigitalOcean, AWS, Linode)

**Time:** 30 minutes  
**Cost:** $4-6/month  
**Difficulty:** ⭐⭐⭐ Medium

#### Step 1: Create VPS
1. Sign up at DigitalOcean/AWS/Linode
2. Create a Droplet/Instance
3. Choose Ubuntu 22.04 LTS
4. Choose basic plan ($4-6/month)
5. Add SSH key
6. Create

#### Step 2: Connect to VPS
```bash
ssh root@your-server-ip
```

#### Step 3: Install Node.js
```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# Verify
node --version  # Should show v18.x.x
npm --version   # Should show 9.x.x
```

#### Step 4: Install Git
```bash
apt install -y git
```

#### Step 5: Clone and Setup
```bash
cd /var/www
git clone https://github.com/YOUR_USERNAME/voxel-fps.git
cd voxel-fps
npm install
npm run build
```

#### Step 6: Install PM2 (Process Manager)
```bash
npm install -g pm2
```

#### Step 7: Start Server
```bash
pm2 start npm --name "voxel-fps" -- run server
```

#### Step 8: Save PM2 Configuration
```bash
pm2 save
pm2 startup
# Copy and run the command it gives you
```

#### Step 9: Configure Firewall
```bash
# Install UFW if not installed
apt install -y ufw

# Allow SSH
ufw allow ssh

# Allow port 3000
ufw allow 3000

# Enable firewall
ufw enable
```

#### Step 10: Get Your Server URL
Your server URL: `wss://your-server-ip:3000`

Example: `wss://123.45.67.89:3000`

#### Step 11: Update Client Code
Edit `src/game/game.ts`:
```typescript
this.networkClient = new NetworkClient('wss://123.45.67.89:3000');
```

#### Step 12: Deploy Client
Deploy to Vercel/Netlify/GitHub Pages (same as Option 1).

---

### Option 4: Fly.io (Free Tier)

**Time:** 10 minutes  
**Cost:** Free tier  
**Difficulty:** ⭐⭐ Easy

#### Step 1: Install Fly CLI
```bash
# macOS/Linux
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
```

#### Step 2: Login
```bash
fly auth login
```

#### Step 3: Launch App
```bash
fly launch
# Answer prompts:
# - App name: voxel-fps-server
# - Region: Choose closest
# - Database: No
```

#### Step 4: Deploy
```bash
fly deploy
```

#### Step 5: Get URL
```bash
fly status
```

Get URL: `wss://voxel-fps-server.fly.dev`

---

## 🌐 Deploy Client (All Options)

### Vercel (Recommended)
```bash
npm install -g vercel
vercel
# Follow prompts
```

### Netlify
```bash
npm install -g netlify-cli
netlify deploy --prod
```

### GitHub Pages
```bash
# Build
npm run build

# Deploy to gh-pages branch
git subtree push --prefix dist origin gh-pages
```

Your client URL: `https://YOUR_USERNAME.github.io/voxel-fps`

---

## 🔧 After Deployment

### Update Server URL in Client
After deploying your server, update the client code:

**File:** `src/game/game.ts`

**Find:**
```typescript
private initializeNetwork(): void {
  this.networkClient = new NetworkClient('ws://localhost:3000');
  // ...
}
```

**Change to:**
```typescript
private initializeNetwork(): void {
  // Use your deployed server URL
  this.networkClient = new NetworkClient('wss://your-server-url.com');
  // ...
}
```

### Rebuild and Redeploy Client
```bash
npm run build
# Then redeploy to Vercel/Netlify/GitHub Pages
```

---

## 🧪 Testing Your Deployment

### Test Server Connection
1. Open browser console (F12)
2. Go to your client URL
3. Click "Online Multiplayer"
4. Check console for:
   ```
   Connecting to server: wss://your-server-url.com
   Connected to server
   ```

### Test Multiplayer
1. Open your client URL in two browser windows
2. In both windows, click "Online Multiplayer"
3. Both should connect to the same server
4. You should see each other in the game

### Test with Friends
1. Share your client URL
2. Friends open it and click "Online Multiplayer"
3. Everyone connects and plays together!

---

## 🐛 Troubleshooting

### "Failed to connect to server"
**Check:**
- Server is running: Check deployment logs
- URL is correct: Use `wss://` for HTTPS
- Firewall: Ensure port 3000 is open (VPS only)

### "WebSocket connection failed"
**Check:**
- URL format: `wss://your-server.com` (not `ws://` for HTTPS)
- Server is deployed and running
- No typos in the URL

### "Client can't connect"
**Check:**
- Client is built with correct server URL
- Client is deployed and accessible
- Browser console for errors
- Network tab for WebSocket connection

### Server Not Starting (VPS)
**Check:**
```bash
# Check PM2 status
pm2 status

# Check logs
pm2 logs voxel-fps

# Restart server
pm2 restart voxel-fps
```

---

## 📊 Deployment Comparison

| Platform | Free Tier | Cost After | Setup Time | Performance |
|----------|-----------|------------|------------|-------------|
| Railway | $5 credit | ~$5/month | 5 min | ⭐⭐⭐⭐⭐ |
| Render | 750 hrs | ~$7/month | 5 min | ⭐⭐⭐⭐ |
| Fly.io | 3 VMs | ~$5/month | 10 min | ⭐⭐⭐⭐⭐ |
| VPS | None | $4-6/month | 30 min | ⭐⭐⭐⭐⭐ |

---

## 🎯 Recommended Setup

### For Testing/Small Groups
- **Server:** Railway (free tier)
- **Client:** Vercel (free)
- **Total Cost:** $0

### For Medium Groups
- **Server:** Railway or Fly.io ($5/month)
- **Client:** Vercel or Netlify (free)
- **Total Cost:** ~$5/month

### For Large Groups/Production
- **Server:** VPS (DigitalOcean $6/month)
- **Client:** Vercel Pro ($20/month) or custom domain
- **Total Cost:** ~$26/month

---

## 🔒 SSL/HTTPS

All platforms provide free HTTPS automatically:
- ✅ Railway: Automatic HTTPS
- ✅ Render: Automatic HTTPS
- ✅ Fly.io: Automatic HTTPS
- ✅ Vercel: Automatic HTTPS
- ✅ Netlify: Automatic HTTPS
- ✅ GitHub Pages: Automatic HTTPS

For VPS, use Let's Encrypt:
```bash
apt install certbot
certbot --nginx -d yourdomain.com
```

---

## 📝 Quick Checklist

### Before Deployment
- [ ] Code pushed to GitHub
- [ ] All tests passing
- [ ] README.md updated
- [ ] No sensitive data in code

### Server Deployment
- [ ] Server deployed to platform
- [ ] Server URL obtained (wss://...)
- [ ] Server tested and working
- [ ] Environment variables set (PORT=3000)

### Client Deployment
- [ ] Server URL updated in code
- [ ] Client rebuilt (`npm run build`)
- [ ] Client deployed to hosting
- [ ] Client URL obtained (https://...)

### Testing
- [ ] Opened client in browser
- [ ] Selected "Online Multiplayer"
- [ ] Connected to server successfully
- [ ] Tested with another player
- [ ] All features working

---

## 🎉 You're Done!

Your game is now live and playable online!

**Share your client URL with friends:**
```
https://your-client-url.com
```

They open it, click "Online Multiplayer", and play together!

---

## 📞 Need Help?

### Documentation
- `README.md` - Main project documentation
- `src/server/README.md` - Server documentation

### Platform Support
- Railway: [docs.railway.app](https://docs.railway.app)
- Render: [render.com/docs](https://render.com/docs)
- Fly.io: [fly.io/docs](https://fly.io/docs)
- Vercel: [vercel.com/docs](https://vercel.com/docs)

### Common Issues
1. Check deployment platform logs
2. Check browser console for errors
3. Verify all URLs are correct
4. Ensure ports are open (VPS only)

---

## 🚀 Next Steps

1. **Deploy** - Follow this guide
2. **Test** - Play with friends
3. **Gather Feedback** - Ask testers for feedback
4. **Iterate** - Improve based on feedback
5. **Scale** - Upgrade hosting if needed

---

**Good luck with your deployment!** 🎮

If you encounter any issues, check the troubleshooting section or open an issue on GitHub.
