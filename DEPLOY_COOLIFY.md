# Coolify Deployment Guide

## Quick Deploy

1. **In Coolify:**
   - Create new application
   - Select "Docker Compose" as build pack
   - Connect your Git repository

2. **Environment Variables:**
   - Copy `.env.example` to `.env`
   - Set all required variables in Coolify's Environment tab
   - Most important: `DOMAIN` (for Traefik routing)

3. **Database:**
   - SQLite database persists in `./data` directory
   - Automatically created on first run
   - No size limitations

4. **Deploy:**
   - Push to your repository
   - Coolify will auto-deploy with Traefik routing

## Files Created

- `Dockerfile` - Simple Node.js container
- `docker-compose.yml` - Traefik labels for Coolify
- `.dockerignore` - Excludes unnecessary files
- `.env.example` - Environment variables template
- `/health` endpoint - Health check for container

## That's it! 🚀

The configuration is minimal and just works with Coolify's defaults.