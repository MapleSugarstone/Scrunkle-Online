# SRT Executive Showdown

A TypeScript browser port of SRT Executive Showdown 1.2 that plays frame for frame like the original project. The original's scripts are transpiled to TypeScript, and a reference runner compares the port with the original on every frame. Two players can fight on one keyboard or online, where rollback netcode keeps both browsers in step.

## Play

You need `node` 22 or later. On Windows, `play.cmd` installs what is missing and opens the game. Otherwise run these two commands and open the address the second one prints.

```bash
npm install
```

```bash
npm run dev
```

Choose **Play offline**. The game's own keys apply:

- Player 1: arrows move, N attacks, M uses a special, B shields and V pauses.
- Player 2: W A S D move, F attacks, G uses a special, H shields and R pauses.
- Menus: Player 1's keys. N selects, M goes back, and `.` and `,` change the song where the game offers it.

**Controls** in the lobby sets your own keys. On one computer they become Player 1's keys when the game starts, and the game's settings menu can still change them.

Controllers work in the standard layout. The left stick or the D-pad moves, A attacks and selects, B uses a special and goes back, X and Y jump, the shoulder buttons and triggers shield, and Back and Start pause. On one computer the first controller you use plays Player 1 and the next one plays Player 2. **Controls** names the controllers the browser sees once you press a button on one.

On touch screens a joystick and five buttons appear during play, beside the stage when the screen is wide and below it when the screen is tall. The joystick centers where your thumb lands. The controls hide while a controller is in use and come back at the next touch. **Touch controls** in the lobby turns them on or off, and the **Touch buttons** tab under **Controls** swaps what two buttons do.

**Leave game** under the stage goes back to the start screen. The page loads every image and short sound before **Play offline** turns on, as the original loads its whole project before it starts. The music keeps loading after that.

**Display** on the start screen picks how the stage is drawn, and F2 picks the next mode at any time. **Smooth** draws at your screen's resolution. **Old flash game** draws at half the stage's size, dithers the picture to 256 colors and enlarges it. **Handheld** draws on a grid three quarters of the stage's size, turns every vector costume into a bitmap at that same scale, draws every costume with hard pixel edges and enlarges the result. The mode changes only the picture, so online players can each use a different one.

**Actually wear hats** on the start screen draws each fighter's hat on the fighter's head in every animation frame. The hat turns and flips with the fighter, gets the fighter's white outline, and is drawn with the fighter, so the other fighter can stand in front of it. Like **Display**, it changes only the picture.

### Saves

Your progress stays in this browser. In offline play the page keeps the game's save, settings and keybinds as they change, and puts them back the next time you play. The game's own save codes still work: the last row of **Settings** opens the save screen. **Save** downloads your code as `SRT Executive Showdown save.txt`. **Load** asks for a code: paste one, or choose the file button beside the answer box to open a saved `.txt` file. A loaded code becomes this browser's save. Art mode codes download and open the same way, as `SRT Executive Showdown art.txt`. Online games start from the game's own data on every computer, so all players start the same, and they never change your save.

### Replays

After a match of 10 seconds or more, offline or online, the page asks whether to save a replay. **Replays** on the start screen lists them, renames and deletes them, and plays them with pause, frame steps, speeds and a seek bar. Its download button saves a replay as an MP4 video at 480p, 720p or 1080p, recorded while the replay plays once at normal speed, or as a `.meow` file. **Upload** adds `.meow` files from other players. A replay saved with another version of the game may not play the same, and the player says so when it stops matching.

## Online play

Online games are peer to peer. Every player runs the whole game from the title screen, and inputs travel directly between browsers. A small room server in `server/` hands out room codes and passes the connection setup between players. It relays inputs only for a pair of players whose direct connection fails.

Before a player's first online game, the page says that playing online shares IP addresses with the other players in the room, because the connections are direct. Once they accept, that browser does not show it again.

1. One player chooses **Host an online game** and shares the six-character room code.
2. The other enters the code and chooses **Join**.
3. The host picks the input delay and starts the game.

Your keys from **Controls** play your own player, so both players can use the same keys. In matches and on character select each player controls their own fighter. In the other menus both players' keys count as Player 1's, so either player can move through them. One frame of input delay (33 ms) suits most connections. Two frames give fewer visible corrections on links slower than about 100 ms.

To try online play on one computer, run `play online`, or run these in two terminals and open two tabs:

```bash
npm --prefix server install
```

```bash
npm run worker:dev
```

```bash
npm run dev
```

The room server listens on port 8788, and the page forwards `/api` to it.

## Publishing

The workflow in `.github/workflows/pages.yml` type-checks and builds the game and publishes `dist/` on every push to `main`. Set the repository's Pages source to GitHub Actions before the first push. The generated code and `public/assets` are committed, because building them needs the reference runner.

To deploy the room server:

1. Run `npx wrangler login` in `server/`, then `npm run worker:deploy` in the project root.
2. Check that `<address>/api/health` answers with the protocol number.
3. If the address differs from the one in `pages.yml`, put it there or in a repository variable named `RELAY_URL`.

`server/wrangler.toml` allows the published site's origin in `ALLOWED_ORIGINS`. Deploy the room server again whenever `src/net/protocol.ts` or `server/` changes.

## Commands

| Command | What it does |
|---|---|
| `npm run extract` | Unpacks `game.sb3` into `sb3/`. |
| `npm run decompile` | Prints every script as pseudocode into `out/dec/`. |
| `npm run ref:dump` | Records costume data, vector images and touching masks from the original. |
| `npm run transpile` | Writes `src/game/generated/` and `src/game/assets-data.json`. |
| `npm run assets` | Writes `public/assets/`. |
| `npx tsx tools/hat-anchors.ts [--sheets <dir>]` | Finds the head in every fighter costume and writes `src/game/hat-anchors.json` for **Actually wear hats**. `--sheets` draws each character's costumes with a hat, for checking. |
| `npm run typecheck` | Checks the types. |
| `npm run ref:server` | Keeps the original loaded so parity runs skip its one-minute load. |
| `npm run test:parity` | Runs every scenario in `tests/scenarios` against the original. |
| `npx tsx tools/parity.ts <scenario>` | Compares the port with the original frame by frame and stops at the first difference. |
| `npm run test:rollback` | Restores random earlier snapshots and checks that the re-simulated frames match a straight run, in the parity digest and in the hash online players compare. |
| `npm run test:net` | Plays two simulated peers with latency, jitter and packet loss and checks they agree. Add `-- --replay` to record each peer's replays as an online page does and play them back. |
| `npx tsx tools/replay-test.ts <scenario>` | Records the matches in a scenario as replays and checks that each plays back the same. |
| `npx tsx tools/replay-check.ts <file>` | Plays a saved `.meow` file back and checks its state hashes, to tell which player's game diverged in a desync. |
| `npx tsx tools/replay-perf.ts <file>` | Times a saved replay's frames, snapshot saves and loads, and lists the slowest frames. |
| `npm run test:math` | Checks the portable math functions bit for bit. |
| `bash tools/record-suite.sh` | Records the parity scenarios again by driving the port through the menus. |
| `npx tsx tools/drive.ts "<tokens>" <name>` | Plays the port with a token script and saves the input as a scenario. The tokens are listed at the top of the file. |
| `npx tsx tools/port-shots.ts <scenario> <frames>` | Saves frames of the port as images. |
| `npx tsx tools/port-state.ts <scenario> <frames> [variables]` | Prints the screen, chosen variables and running scripts at chosen frames. |
| `npx tsx tools/perf.ts <scenario>` | Reports milliseconds per frame, overall and during matches. |
| `npx tsx tools/load-time.ts` | Times how long the built site takes to load until Play turns on, with an empty cache. |

These tools need `npm run ref:server` running and help when parity fails. `tools/parity-steps.ts` finds the first thread step within a frame that leaves the two sides different. `tools/parity-probe.ts` compares every custom block call and its arguments within a frame, after `PROBE=1 npm run transpile`. `tools/ref-compiled.ts` prints the JavaScript the original's compiler made for a script. `tools/parity-ticks.ts` compares the order in which threads ran, and `tools/parity-pieces.ts` and `tools/parity-vars.ts` print differing values.

## How the port works

| Folder | Contents |
|---|---|
| `src/engine/` | The runtime: value casting, the thread scheduler, broadcasts, clones, layers, pen and sound models, renderer geometry, snapshots and portable math. |
| `src/game/generated/` | One TypeScript module per sprite, generated from the project. |
| `src/render/` | The WebGL renderer. |
| `src/client/` | The page: keyboard, controllers and touch, audio, overlays, the lobby and the online session. |
| `src/net/` | The room protocol, the rollback session, the peer links and the room client. |
| `server/` | The room server. |
| `tools/` | The transpiler, asset pipeline, parity and network tests, and project tools. |
| `reference/` | The page that runs the original project for comparison. |

The project was made for a runtime with a 640 by 360 stage that compiles scripts to JavaScript. The reference runner uses that runtime, and the transpiler follows its compiled behavior where it differs from the interpreter: `and` and `or` stop early, number-like literals become numbers, loop counts and wait times are read once, and a custom block that ends in a sound or volume block returns to the next block of its caller.

The simulation is deterministic. Time advances 33 ms per frame, random numbers come from a seeded generator, and sine, cosine, arctangent, exponent and logarithm come from `src/engine/dmath.ts`, so every browser computes the same bits.
