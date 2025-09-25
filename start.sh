#!/bin/bash

# Arrêter toute instance existante de Xvfb sur le display :99
pkill -f "Xvfb :99" || true

# Démarrer Xvfb
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Attendre que Xvfb soit complètement démarré
sleep 3

# Vérifier si Xvfb est bien démarré
if ! xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "Erreur : Xvfb n'a pas démarré correctement"
    exit 1
fi

# Démarrer le serveur Node.js
node server.js

# Nettoyer en sortant
kill $XVFB_PID
