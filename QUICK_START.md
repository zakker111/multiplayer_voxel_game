# 🚀 Quick Start Guide - Deploy Your Game in 10 Minutes

This guide will help you deploy your Voxel FPS game so others can test it.

---

## 📋 What You Need

- ✅ GitHub account
- ✅ Your code is ready (it is!)
- ✅ 10 minutes of time

---

## 🎯 Fastest Path: Railway + Vercel (Free)

### Step 1: Push to GitHub (2 minutes)

```bash
# Initialize git (if not already done)
git init
git add .
git commit -m "Voxel FPS game - ready for testing"

# Create repository on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/voxel-fps.git
git branch -M main
git push -u origin main
```

### Step 2: Deploy Server to Railway (3 minutes)

1. Go to [railway.app](https://railway.app)
2. Click "Sign up" → "Login with GitHub"
4. Click "New Project"
6. Click "Deploy from GitHub repo"
7. Select your `voxel-fps` repository
8. Railway detects Node.js automatically
9. Click "Variables" tab
10. Add new variable:
    - **Key:** `PORT`
    - **Value:** `3000`
11. Click "Deploy"
12. Wait 2-3 minutes
13. Copy your server URL (e.g., `wss://voxel-fps.up.railway.app`)

### Step 3: Update Client Code (1 minute)

Open `src/game/game.ts` and find line ~3338:

```typescript
// Change this line:
this.networkClient = new NetworkClient('ws://localhost:3000');

// To your Railway URL:
this.networkClient = new NetworkClient('wss://voxel-fps.up.railway.app');
```

Save the file.

### Step 4: Deploy Client to Vercel (2 minutes)

1. Go to [vercel.com](https://vercel.com)
2. Click "Sign up" → "Login with GitHub"
4. Click "Add New..." → "Project"
5. Click "Import" next to your `voxel-fps` repository
6. Vercel detects Vite automatically
8. Click "Deploy"
9. Wait 1-2 minutes
10. Copy your client URL (e.g., `https://voxel-fps.vercel.app`)

### Step 5: Share with Friends! 🎉

Send this URL to your friends:
```
https://voxel-fps.vercel.app
```

They open it, click "Online Multiplayer", and play together!

---

## 🧪 Testing Instructions

### For You (Host)
1. Open your client URL
2. Click "Online Multiplayer"
3. You're connected to your server!

### For Your Friends (Testers)
1. Open the URL you sent them
2. Click "Online Multiplayer"
4. They're connected to the same server!
5. You should see each other in the game

### What to Test
- ✅ Connection works
- ✅ Multiple players can join
- ✅ Players can see each other
- ✅ Flag pickup/drop/capture works
- ✅ Combat works
- ✅ Building works
- ✅ Bots work

---

## 🔄 Making Updates

### Update Server Code
```bash
# Make your changes
git add .
git commit -m "Update server"
git push
```
Railway automatically redeploys!

### Update Client Code
```bash
# Make your changes
git add .
git commit -m "Update client"
git push
```
Vercel automatically redeploys!

---

## 🐛 Troubleshooting

### "Failed to connect to server"
**Check:**
- Is server running? Check Railway logs
- Is URL correct? Should be `wss://` not `ws://`
- Did you add PORT=3000 variable?

### "Can't see other players"
**Check:**
- Are both players on "Online Multiplayer"?
- Are both connected to same server?
- Check browser console (F12) for errors

### "Server won't start"
**Check:**
- Railway logs for error messages
- Did you set PORT=3000?
- Is code pushed to GitHub?

---

## 💰 Cost

**Total Cost:** $0

- Railway: Free tier ($5 credit/month)
- Vercel: Free tier (unlimited for personal)
- GitHub: Free for public repos

---

## 📞 Need Help?

### Check Logs
- **Railway:** Dashboard → Your project → Deployments → View logs
- **Vercel:** Dashboard → Your project → Deployments → View logs

### Common Issues
1. **Server not connecting:** Check Railway logs
2. **Client not loading:** Check Vercel logs
3. **Players can't see each other:** Both on "Online Multiplayer"?

### Get Help
- Check Railway/Vercel documentation
- Open GitHub issue
- Check browser console (F12)

---

## 🎉 You're Live!

Your game is now live and playable online!

**Share your URL:**
```
https://voxel-fps.vercel.app
```

**Have fun testing!** 🎮

---

## 📚 More Information

- **README.md** - Full project documentation
- **DEPLOYMENT.md** - Detailed deployment guide
- **PROJECT_SUMMARY.md** - Complete project overview

---

**That's it! Your game is live in 10 minutes!** 🚀
