#!/usr/bin/env bash
# Records the parity scenarios in tests/scenarios with tools/drive.ts. Run it from the project root after a change to
# the menus' routes; parity runs only need the saved files.
set -e
INTRO="wait/700 space*3/60 wait/100 space*3/60 wait/150 N*3/40"
VS="$INTRO N*3/40 down_arrow*3/30 N*3/40 N*3/40"
drive() { npx tsx tools/drive.ts "$2" "$1" "$3" | tail -1; }

# Two players: default fighters and stage, then other fighters and stages picked with each player's keys.
drive versus "$VS N*3/40 N*3/40 F*3/40 N*3/60 wait/150 fuzz/2400 wait/100" 3
drive versus-2 "$VS right_arrow*3/20 right_arrow*3/20 right_arrow*3/30 N*3/40 right_arrow*3/20 right_arrow*3/20 down_arrow*3/20 N*3/40 A*3/20 A*3/20 A*3/20 F*3/40 N*3/60 wait/150 fuzz/2000 wait/100" 5
drive versus-3 "$VS down_arrow*3/20 right_arrow*3/20 right_arrow*3/20 right_arrow*3/20 right_arrow*3/30 N*3/40 right_arrow*3/20 right_arrow*3/20 right_arrow*3/20 right_arrow*3/20 right_arrow*3/30 N*3/40 S*3/20 D*3/20 D*3/20 D*3/20 F*3/40 N*3/60 wait/150 fuzz/2000 wait/100" 11
drive versus-4 "$VS left_arrow*3/30 N*3/40 down_arrow*3/20 left_arrow*3/20 left_arrow*3/30 N*3/40 S*3/20 A*3/20 A*3/20 A*3/20 A*3/20 F*3/40 N*3/60 wait/150 fuzz/2000 wait/100" 13

# One player against the CPU on another stage and fighter.
drive cpu "$INTRO N*3/40 N*3/40 N*3/40 right_arrow*3/20 right_arrow*3/30 N*3/40 down_arrow*3/20 right_arrow*3/20 right_arrow*3/20 right_arrow*3/30 N*3/40 N*3/60 wait/150 fuzz/1800 wait/100" 17

# Training, story mode and the tower from the menus, then random presses there.
drive training "$INTRO N*3/40 down_arrow*3/20 down_arrow*3/30 N*3/60 N*3/40 N*3/40 N*3/60 wait/150 fuzz/1500 wait/100" 19
drive story "$INTRO N*3/40 down_arrow*3/20 down_arrow*3/20 down_arrow*3/30 N*3/60 wait/100 N*3/40 N*3/40 N*3/40 N*3/40 N*3/40 wait/100 fuzz/1500 wait/100" 23
drive tower "$INTRO down_arrow*3/30 N*3/60 wait/100 N*3/40 N*3/40 N*3/40 N*3/40 wait/100 fuzz/1500 wait/100" 29

# Settings and extras: walk the menus with Player 1's keys.
drive settings "$INTRO down_arrow*3/20 down_arrow*3/20 down_arrow*3/30 N*3/60 down_arrow*3/20 down_arrow*3/20 right_arrow*3/20 left_arrow*3/20 N*3/40 down_arrow*3/20 N*3/40 M*3/40 M*3/40 M*3/60 down_arrow*3/20 down_arrow*3/30 N*3/60 wait/100" 31
drive extras "$INTRO down_arrow*3/20 down_arrow*3/30 N*3/60 down_arrow*3/20 N*3/60 wait/100 M*3/40 down_arrow*3/20 down_arrow*3/20 N*3/60 wait/100 M*3/40 down_arrow*3/20 N*3/60 wait/150 M*3/60 wait/100" 37
