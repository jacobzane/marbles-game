# Marble Card Game

A multiplayer team-based marble racing game for exactly 4 players (2v2).

## Game Rules Summary

- **Players**: 4 players (North & South vs East & West)
- **Marbles**: Each player has 5 marbles
- **Board**: 72 spaces around the main track
- **Cards**: Two standard decks (108 cards total including jokers)
- **Hand**: 5 cards per player

### Card Rules
- **Face cards (J, Q, K) or Ace**: Enter a marble from start to the track
- **8**: Move backwards 8 spaces
- **7**: May split movement between 2 marbles (total: 7 spaces)
- **9**: MUST split - one marble forward, one backward (total: 9 spaces)
- **Joker**: Place your marble on top of any marble (teammate or enemy)
- **Other cards (2-6, 10)**: Move forward that many spaces

### Landing Rules
- Cannot land on your own marble
- Land on teammate → they move to their home entry
- Land on enemy → they return to start

### Win Condition
First team to get all 10 marbles (5 per player) into their home zones wins!

## Setup Instructions

### 1. Install Dependencies
```bash
cd marble-game
npm install
```

### 2. Run the Server
```bash
npm start
```

The server will start on http://localhost:3000

### 3. Connect Players
- Open http://localhost:3000 in 4 different browser windows/tabs
- Each player enters their name and selects a position (North, East, South, or West)
- Game starts automatically when all 4 players join

## Playing on Local Network

To play with friends on the same WiFi network:

1. Find your computer's local IP address:
   - **Windows**: Run `ipconfig` in Command Prompt, look for "IPv4 Address"
   - **Mac/Linux**: Run `ifconfig` or `ip addr`, look for your local IP (usually starts with 192.168.x.x)

2. Share this address with your friends: `http://YOUR_IP:3000`
   - Example: `http://192.168.1.100:3000`

3. Friends connect to this address on their devices

## Current Status

✅ Implemented:
- 4-player connection system
- Board rendering (72 spaces, start/home zones)
- Card dealing and hand management
- Turn-based gameplay
- Team structure (North/South vs East/West)

⚠️ Needs Refinement:
- Move selection UI (currently uses placeholders)
- Click-to-select marble interactions
- Card-specific move validation
- Visual feedback for legal moves
- Win condition checking

## Next Steps

1. Test the basic connection and board rendering
2. Implement marble selection UI
3. Add move validation for each card type
4. Test gameplay with all card types
5. Polish UI/UX
6. Deploy to web hosting

## Development Notes

The game uses:
- **Node.js + Express** for the server
- **Socket.IO** for real-time multiplayer
- **Vanilla JavaScript** for client-side logic
- **SVG** for board rendering

## Troubleshooting

**Players can't connect?**
- Make sure the server is running (`npm start`)
- Check firewall settings allow connections on port 3000
- Verify all players are on the same network

**Game won't start?**
- Ensure exactly 4 players have joined
- Check browser console for errors (F12)

**Need to reset the game?**
- Restart the server (Ctrl+C, then `npm start`)
