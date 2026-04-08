#!/usr/bin/env bash
# Deploy Grove to VPS
# Usage: bash scripts/deploy.sh
set -euo pipefail

SSH_KEY="$HOME/.ssh/grove-aws.pem"
HOST="ubuntu@52.37.76.231"

echo "Pushing to origin..."
git push origin main

echo "Deploying to VPS..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$HOST" 'sudo bash -s' << 'REMOTE'
cd /root/grove
git pull origin main
npm install --production
pm2 restart grove-server grove-proxy
sleep 3
pm2 list
echo "---"
curl -sf http://localhost:8420/health && echo " Health OK" || echo " Health FAILED"
REMOTE

echo "Deploy complete."
