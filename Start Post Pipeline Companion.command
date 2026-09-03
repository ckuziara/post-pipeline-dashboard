#!/bin/bash
# Double-click to run this machine as a Post Pipeline companion.
#
# What that means: the hosted board can't see your LucidLink volume — no
# server in a datacenter can — so it hands its file work to a copy of Post
# Pipeline running here, where the volume actually is. Project, Assets and
# Deliver then work from the hosted board on this machine.
#
# It holds NO database credential and stores nothing. The board stays on the
# hosted deploy; this only ever touches the volume you already have mounted.
#
# ── SET THESE TWO ─────────────────────────────────────────────────────────
# BOARD  the hosted board's address, exactly as it appears in the browser
#        (no trailing slash). Only this origin is allowed to reach you.
# MOUNT  the production folder on your machine — the same path Admin →
#        Workflow → Storage shows, as it looks HERE.
BOARD="https://post-pipeline-dashboard-3mfj.onrender.com"
MOUNT="/Volumes/LucidLink/Productions"
PORT=8771
# ──────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed."
  echo "Install the LTS build from https://nodejs.org, then double-click this again."
  echo
  read -r -p "Press return to close." _
  exit 1
fi

if [ ! -d "$MOUNT" ]; then
  echo "Can't see the production folder:"
  echo "  $MOUNT"
  echo
  echo "Is LucidLink running and the volume mounted? If the path is different on"
  echo "this Mac, open this file in TextEdit and change MOUNT to match."
  echo
  read -r -p "Press return to close." _
  exit 1
fi

echo "Post Pipeline companion"
echo "  serving files to : $BOARD"
echo "  from the volume  : $MOUNT"
echo
echo "Leave this window open while you work. Close it to stop."
echo "Now open $BOARD in your browser — Project and Deliver will be live."
echo

# No DATABASE_URL on purpose: a companion resolves paths from what the board
# sends it, so running one never requires the production database credential.
# HOST is left to the server, which binds 127.0.0.1 in companion mode — this
# machine only. A companion serves a production volume; it has no business
# being reachable from the rest of the network.
#
# The pairing code is printed below once this starts. Paste it into the board's
# Workspace panel when it asks — once per browser, not once per session.
COMPANION_ORIGINS="$BOARD" MASTER_PATH="$MOUNT" PORT="$PORT" exec node server.js
