const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const GAME_PASSWORD = process.env.GAME_PASSWORD || 'Berg270';

app.use(express.static('public'));

// Multi-table support
let tables = {};  // Map of tableId -> gameState
let playerToTable = {};  // Map of socketId -> tableId
let disconnectionTimeouts = {};  // Map of `${tableId}-${position}` -> timeout

// Generate a unique 6-character table ID
function generateTableId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // Avoid confusing chars
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (tables[id]);  // Ensure unique
  return id;
}

// Create a new table/game state
function createNewTable(tableId, hostName) {
  return {
    id: tableId,
    hostName: hostName,
    players: {},
    playerOrder: [],
    teams: {
      team1: ['Seat1', 'Seat3'],
      team2: ['Seat2', 'Seat4']
    },
    currentPlayerIndex: 0,
    deck: [],
    discardPile: [],
    board: initializeBoard(),
    gameStarted: false,
    pendingSplitMove: null,
    movesLog: [],
    currentMoveLandingEffects: [],  // Per-table landing effects
    createdAt: Date.now()
  };
}

// Get table by socket ID
function getTableForSocket(socketId) {
  const tableId = playerToTable[socketId];
  return tableId ? tables[tableId] : null;
}

// Get player position by socket ID
function getPositionForSocket(socketId) {
  const tableId = playerToTable[socketId];
  if (!tableId || !tables[tableId]) return null;

  for (let pos in tables[tableId].players) {
    if (tables[tableId].players[pos].socketId === socketId) {
      return pos;
    }
  }
  return null;
}

function initializeBoard() {
  return {
    Seat1: {
      start: Array(5).fill(null).map((_, i) => ({ id: `S1-start-${i}`, marble: null })),
      home: Array(5).fill(null).map((_, i) => ({ id: `S1-home-${i}`, marble: null })),
      trackEntry: 0,
      homeEntry: 67
    },
    Seat2: {
      start: Array(5).fill(null).map((_, i) => ({ id: `S2-start-${i}`, marble: null })),
      home: Array(5).fill(null).map((_, i) => ({ id: `S2-home-${i}`, marble: null })),
      trackEntry: 18,
      homeEntry: 13
    },
    Seat3: {
      start: Array(5).fill(null).map((_, i) => ({ id: `S3-start-${i}`, marble: null })),
      home: Array(5).fill(null).map((_, i) => ({ id: `S3-home-${i}`, marble: null })),
      trackEntry: 36,
      homeEntry: 31
    },
    Seat4: {
      start: Array(5).fill(null).map((_, i) => ({ id: `S4-start-${i}`, marble: null })),
      home: Array(5).fill(null).map((_, i) => ({ id: `S4-home-${i}`, marble: null })),
      trackEntry: 54,
      homeEntry: 49
    }
  };
}

function createDeck() {
  const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
  const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  let deck = [];
  
  for (let deckNum = 0; deckNum < 2; deckNum++) {
    for (let suit of suits) {
      for (let value of values) {
        deck.push({ value, suit });
      }
    }
    deck.push({ value: 'Joker', suit: 'red' });
    deck.push({ value: 'Joker', suit: 'black' });
  }
  
  return shuffleDeck(deck);
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function dealCards(gameState, playerId, count) {
  if (!gameState.players[playerId]) return;

  for (let i = 0; i < count; i++) {
    if (gameState.deck.length === 0) {
      // Collect all cards from player discard piles
      const allDiscards = [];
      for (let player of gameState.playerOrder) {
        if (gameState.players[player] && gameState.players[player].discardPile) {
          allDiscards.push(...gameState.players[player].discardPile);
          gameState.players[player].discardPile = [];
        }
      }

      // Also add any cards from the old global discard pile
      if (gameState.discardPile && gameState.discardPile.length > 0) {
        allDiscards.push(...gameState.discardPile);
        gameState.discardPile = [];
      }

      // Shuffle and create new deck
      if (allDiscards.length > 0) {
        gameState.deck = shuffleDeck(allDiscards);
      }
    }
    if (gameState.deck.length > 0) {
      gameState.players[playerId].hand.push(gameState.deck.pop());
    }
  }
}

function getCardValue(card) {
  if (card.value === 'Joker') return 'joker';
  if (card.value === 'A') return 1;
  if (card.value === 'J' || card.value === 'Q' || card.value === 'K') return 'face';
  return parseInt(card.value);
}

function addMoveToLog(gameState, player, card, action = 'played', landingEffects = []) {
  const playerName = gameState.players[player]?.name || player;

  // Format card display
  let cardDisplay = card.value;
  if (card.suit !== 'red' && card.suit !== 'black') {
    const suitSymbols = {
      hearts: '♥',
      diamonds: '♦',
      clubs: '♣',
      spades: '♠'
    };
    cardDisplay = `${card.value}${suitSymbols[card.suit] || ''}`;
  }

  // Format landing effects for display
  const formattedEffects = landingEffects.map(effect => {
    const targetName = gameState.players[effect.targetPlayer]?.name || effect.targetPlayer;
    if (effect.type === 'teammate') {
      return { targetName, result: 'sent to home entrance' };
    } else {
      return { targetName, result: 'sent back to start' };
    }
  });

  const logEntry = {
    player: playerName,
    card: cardDisplay,
    action: action, // 'played' or 'discarded'
    landingEffects: formattedEffects,
    timestamp: Date.now()
  };

  gameState.movesLog.unshift(logEntry); // Add to front
  console.log(`Move logged: ${playerName} ${action} ${cardDisplay}, effects: ${formattedEffects.length}, total moves: ${gameState.movesLog.length}`);

  // Keep only last 20 moves
  if (gameState.movesLog.length > 20) {
    gameState.movesLog = gameState.movesLog.slice(0, 20);
  }
}

function getMarbleOnTrack(gameState, trackPosition) {
  for (let player of gameState.playerOrder) {
    const marbles = gameState.players[player].marbles;
    for (let marbleId in marbles) {
      if (marbles[marbleId].position === trackPosition && marbles[marbleId].location === 'track') {
        return { player, marbleId };
      }
    }
  }
  return null;
}

function getTeammate(gameState, player) {
  if (gameState.teams.team1.includes(player)) {
    return gameState.teams.team1.find(p => p !== player);
  } else {
    return gameState.teams.team2.find(p => p !== player);
  }
}

// Check if landing on a teammate is valid (their home entry must not be occupied by their own marble)
function canLandOnTeammate(gameState, teammate) {
  const homeEntry = gameState.board[teammate].homeEntry;
  const occupant = getMarbleOnTrack(gameState, homeEntry);

  // If no one is at home entry, landing is allowed
  if (!occupant) {
    return true;
  }

  // If home entry is occupied by teammate's own marble, landing is NOT allowed
  if (occupant.player === teammate) {
    return false;
  }

  // If home entry is occupied by someone else (enemy), chain reaction will handle it
  return true;
}

function isPlayerFinished(gameState, player) {
  let inHome = 0;
  for (let marbleId in gameState.players[player].marbles) {
    if (gameState.players[player].marbles[marbleId].location === 'home') {
      inHome++;
    }
  }
  return inHome === 5;
}

function canControlMarble(gameState, actingPlayer, marbleOwner) {
  if (actingPlayer === marbleOwner) return true;
  if (isPlayerFinished(gameState, actingPlayer) && getTeammate(gameState, actingPlayer) === marbleOwner) return true;
  return false;
}

// Count moveable marbles for a player (considering teammate if finished)
// If assumeFinishedAfterMove is true, count teammate's marbles even if not finished yet
// (used when checking if a 7/9 card split is valid when the first move would finish the player)
function countMoveableMarbles(gameState, actingPlayer, assumeFinishedAfterMove = false) {
  let count = 0;

  // Check own marbles
  for (let marbleId in gameState.players[actingPlayer].marbles) {
    const marble = gameState.players[actingPlayer].marbles[marbleId];
    if (marble.location === 'track' || marble.location === 'home') {
      count++;
    }
  }

  // Check teammate's marbles if finished (or will be finished after this move)
  if (isPlayerFinished(gameState, actingPlayer) || assumeFinishedAfterMove) {
    const teammate = getTeammate(gameState, actingPlayer);
    for (let marbleId in gameState.players[teammate].marbles) {
      const marble = gameState.players[teammate].marbles[marbleId];
      if (marble.location === 'track' || marble.location === 'home') {
        count++;
      }
    }
  }

  return count;
}

// Check if a player would be finished after moving a specific marble to home
// This checks if the player has 4 marbles in home and only 1 marble left to move
// (meaning if that marble enters home, they'd be finished)
function wouldBeFinishedAfterMove(gameState, player, marbleId, enteringHome) {
  // Count how many marbles are already in home
  let inHome = 0;
  let onTrackOrHome = 0;

  for (let mId in gameState.players[player].marbles) {
    const marble = gameState.players[player].marbles[mId];
    if (marble.location === 'home') {
      inHome++;
    }
    if (marble.location === 'track' || marble.location === 'home') {
      onTrackOrHome++;
    }
  }

  // If 4 are already home and enteringHome is true/undefined (could enter), player might finish
  // We're optimistic here - if the player has 4 in home and is moving their last marble,
  // we assume it could potentially enter home to allow the split move
  if (inHome === 4 && (enteringHome === true || enteringHome === undefined)) {
    return true;
  }

  return false;
}

// Count marbles on track only (for 9 card backward requirement)
function countMarblesOnTrack(gameState, actingPlayer) {
  let count = 0;

  // Check own marbles
  for (let marbleId in gameState.players[actingPlayer].marbles) {
    const marble = gameState.players[actingPlayer].marbles[marbleId];
    if (marble.location === 'track') {
      count++;
    }
  }

  // Check teammate's marbles if finished
  if (isPlayerFinished(gameState, actingPlayer)) {
    const teammate = getTeammate(gameState, actingPlayer);
    for (let marbleId in gameState.players[teammate].marbles) {
      const marble = gameState.players[teammate].marbles[marbleId];
      if (marble.location === 'track') {
        count++;
      }
    }
  }

  return count;
}

function isPathBlocked(gameState, player, startPos, endPos, direction = 'forward') {
  if (direction === 'forward') {
    let current = (startPos + 1) % 72;
    while (current !== endPos) {
      const occupant = getMarbleOnTrack(gameState, current);
      if (occupant && occupant.player === player) {
        return true;
      }
      current = (current + 1) % 72;
    }
  } else {
    let current = startPos - 1;
    if (current < 0) current += 72;
    while (current !== endPos) {
      const occupant = getMarbleOnTrack(gameState, current);
      if (occupant && occupant.player === player) {
        return true;
      }
      current = current - 1;
      if (current < 0) current += 72;
    }
  }
  return false;
}

// Check if a specific home position is occupied by checking marble objects (source of truth)
function isHomePositionOccupied(gameState, player, homeIndex) {
  for (let marbleId in gameState.players[player].marbles) {
    const marble = gameState.players[player].marbles[marbleId];
    if (marble.location === 'home' && marble.position === homeIndex) {
      return true;
    }
  }
  return false;
}

function isHomePathBlocked(gameState, player, startHomePos, endHomePos) {
  for (let i = startHomePos + 1; i < endHomePos; i++) {
    // Use marble objects as source of truth instead of board state
    if (isHomePositionOccupied(gameState, player, i)) {
      return true;
    }
  }
  return false;
}

function isHomePathBlockedFromStart(gameState, player, targetHomeIndex) {
  for (let i = 0; i < targetHomeIndex; i++) {
    // Use marble objects as source of truth instead of board state
    if (isHomePositionOccupied(gameState, player, i)) {
      return true;
    }
  }
  return false;
}

function isPathBlockedIncludingHomeEntry(gameState, player, startPos, endPos, homeEntry) {
  let current = (startPos + 1) % 72;
  while (current !== endPos) {
    if (current !== homeEntry) {
      const occupant = getMarbleOnTrack(gameState, current);
      if (occupant && occupant.player === player) {
        return true;
      }
    }
    current = (current + 1) % 72;
  }
  return false;
}

function getSpacesToPosition(start, target, direction = 'forward') {
  let spaces = 0;
  if (direction === 'forward') {
    let current = start;
    while (current !== target && spaces < 72) {
      spaces++;
      current = (current + 1) % 72;
    }
  } else {
    let current = start;
    while (current !== target && spaces < 72) {
      spaces++;
      current = current - 1;
      if (current < 0) current += 72;
    }
  }
  return spaces;
}

// ============ LEGAL PLAY CHECKING ============

// Check if player has any legal play with any card in their hand
function hasLegalPlay(gameState, position) {
  const player = gameState.players[position];
  if (!player || !player.hand) return false;

  for (let card of player.hand) {
    if (canPlayCard(gameState, position, card)) {
      return true;
    }
  }
  return false;
}

// Check if a specific card can be legally played
function canPlayCard(gameState, position, card) {
  const cardValue = card.value;

  // Handle face cards and special cards
  if (cardValue === 'A') {
    // Ace: Enter from start OR move 1 OR move 11
    if (canEnterFromStart(gameState, position)) return true;
    if (canMoveAnyMarbleForward(gameState, position, 1)) return true;
    if (canMoveAnyMarbleForward(gameState, position, 11)) return true;
    return false;
  }

  if (cardValue === 'K') {
    // King: Enter from start OR move 13
    if (canEnterFromStart(gameState, position)) return true;
    if (canMoveAnyMarbleForward(gameState, position, 13)) return true;
    return false;
  }

  if (cardValue === 'Joker') {
    // Joker: Enter from start OR land on any other player's marble
    if (canEnterFromStart(gameState, position)) return true;
    if (canJokerMove(gameState, position)) return true;
    return false;
  }

  if (cardValue === 'J') {
    // Jack moves 11 spaces
    return canMoveAnyMarbleForward(gameState, position, 11);
  }

  if (cardValue === 'Q') {
    // Queen moves 12 spaces
    return canMoveAnyMarbleForward(gameState, position, 12);
  }

  if (cardValue === '4') {
    // 4: Move backward 4 spaces
    return canMoveAnyMarbleBackward(gameState, position, 4);
  }

  if (cardValue === '7') {
    // 7: Split forward move - need at least one marble that can move 1-7 spaces forward
    return canMove7Card(gameState, position);
  }

  if (cardValue === '9') {
    // 9: Split move - forward 1-8, then different marble backward remainder
    return canMove9Card(gameState, position);
  }

  // Regular number cards (2, 3, 5, 6, 8, 10)
  const spaces = parseInt(cardValue);
  if (!isNaN(spaces)) {
    return canMoveAnyMarbleForward(gameState, position, spaces);
  }

  return false;
}

// Check if player can enter a marble from start
function canEnterFromStart(gameState, position) {
  const player = gameState.players[position];

  // Check if player has any marble in start
  let hasMarbleInStart = false;
  for (let marbleId in player.marbles) {
    if (player.marbles[marbleId].location === 'start') {
      hasMarbleInStart = true;
      break;
    }
  }
  if (!hasMarbleInStart) return false;

  // Check if track entry is not blocked by own marble
  const entryPosition = gameState.board[position].trackEntry;
  const occupant = getMarbleOnTrack(gameState, entryPosition);

  if (occupant && occupant.player === position) {
    return false; // Blocked by own marble
  }

  // Check if landing on teammate and their home entry is blocked
  const teammate = getTeammate(gameState, position);
  if (occupant && occupant.player === teammate && !canLandOnTeammate(gameState, teammate)) {
    return false;
  }

  return true;
}

// Check if any controllable marble can move forward the given spaces
function canMoveAnyMarbleForward(gameState, position, spaces) {
  const controllableMarbles = getControllableMarbles(gameState, position);

  for (let { owner, marbleId } of controllableMarbles) {
    if (canMarbleMoveForward(gameState, owner, marbleId, spaces)) {
      return true;
    }
  }
  return false;
}

// Check if a specific marble can move forward the given spaces
function canMarbleMoveForward(gameState, owner, marbleId, spaces) {
  const marble = gameState.players[owner].marbles[marbleId];
  if (!marble) return false;

  // Must be on track or in home
  if (marble.location !== 'track' && marble.location !== 'home') {
    return false;
  }

  // If in home, check if can move within home
  if (marble.location === 'home') {
    const currentHomePos = marble.position;
    const newHomePos = currentHomePos + spaces;
    if (newHomePos > 4) return false; // Would go past end of home

    // Check path is clear using marble objects as source of truth
    for (let i = currentHomePos + 1; i <= newHomePos; i++) {
      if (isHomePositionOccupied(gameState, owner, i)) {
        return false;
      }
    }
    return true;
  }

  // On track - check if can move forward
  const startPos = marble.position;
  const homeEntry = gameState.board[owner].homeEntry;

  // Check if crosses or lands on home entry
  let crossesHome = false;
  let spacesToHomeEntry = 0;
  const onHomeEntry = startPos === homeEntry;

  if (!onHomeEntry) {
    for (let i = 1; i <= spaces; i++) {
      if ((startPos + i) % 72 === homeEntry) {
        crossesHome = true;
        spacesToHomeEntry = i;
        break;
      }
    }
  }

  // If on home entry or crosses it, check home entry option
  if (onHomeEntry || crossesHome) {
    const spacesIntoHome = onHomeEntry ? spaces : spaces - spacesToHomeEntry;

    // Check if can enter home
    if (spacesIntoHome > 0 && spacesIntoHome <= 5) {
      const homeIndex = spacesIntoHome - 1;
      if (!isHomePathBlockedFromStart(gameState, owner, homeIndex) &&
          !isHomePositionOccupied(gameState, owner, homeIndex)) {
        return true; // Can enter home
      }
    }

    // Check if can pass home and continue on track
    const trackDest = (startPos + spaces) % 72;
    if (!isPathBlockedIncludingHomeEntry(gameState, owner, startPos, trackDest, homeEntry)) {
      const occupant = getMarbleOnTrack(gameState, trackDest);
      if (!occupant || occupant.player !== owner) {
        // Check teammate landing validity
        const teammate = getTeammate(gameState, owner);
        if (occupant && occupant.player === teammate && !canLandOnTeammate(gameState, teammate)) {
          return false;
        }
        return true;
      }
    }
  } else {
    // Normal forward move not crossing home
    const newPosition = (startPos + spaces) % 72;
    if (!isPathBlocked(gameState, owner, startPos, newPosition, 'forward')) {
      const occupant = getMarbleOnTrack(gameState, newPosition);
      if (!occupant || occupant.player !== owner) {
        const teammate = getTeammate(gameState, owner);
        if (occupant && occupant.player === teammate && !canLandOnTeammate(gameState, teammate)) {
          return false;
        }
        return true;
      }
    }
  }

  return false;
}

// Check if any controllable marble can move backward the given spaces
function canMoveAnyMarbleBackward(gameState, position, spaces) {
  const controllableMarbles = getControllableMarbles(gameState, position);

  for (let { owner, marbleId } of controllableMarbles) {
    const marble = gameState.players[owner].marbles[marbleId];
    if (marble.location !== 'track') continue;

    let newPosition = marble.position - spaces;
    if (newPosition < 0) newPosition += 72;

    if (!isPathBlocked(gameState, owner, marble.position, newPosition, 'backward')) {
      const occupant = getMarbleOnTrack(gameState, newPosition);
      if (!occupant || occupant.player !== owner) {
        const teammate = getTeammate(gameState, owner);
        if (occupant && occupant.player === teammate && !canLandOnTeammate(gameState, teammate)) {
          continue;
        }
        return true;
      }
    }
  }
  return false;
}

// Check if player can make a valid joker move
function canJokerMove(gameState, position) {
  const controllableMarbles = getControllableMarbles(gameState, position);

  // Need at least one marble to move
  if (controllableMarbles.length === 0) return false;

  // Check if there's any target marble on track (not our own)
  for (let player of gameState.playerOrder) {
    if (player === position) continue; // Skip own marbles for target

    for (let marbleId in gameState.players[player].marbles) {
      const marble = gameState.players[player].marbles[marbleId];
      if (marble.location === 'track') {
        // Found a potential target - check if we can land on it
        const teammate = getTeammate(gameState, position);
        if (player === teammate && !canLandOnTeammate(gameState, teammate)) {
          continue; // Can't land on this teammate marble
        }
        return true;
      }
    }
  }
  return false;
}

// Check if player can play a 7 card
function canMove7Card(gameState, position) {
  const controllableMarbles = getControllableMarbles(gameState, position);

  // Collect marbles that can move and how far they can move
  const moveableMarbles = [];
  for (let { owner, marbleId } of controllableMarbles) {
    const marble = gameState.players[owner].marbles[marbleId];
    if (marble.location !== 'track' && marble.location !== 'home') continue;

    const possibleMoves = [];
    for (let spaces = 1; spaces <= 7; spaces++) {
      if (canMarbleMoveForward(gameState, owner, marbleId, spaces)) {
        possibleMoves.push(spaces);
      }
    }
    if (possibleMoves.length > 0) {
      moveableMarbles.push({ owner, marbleId, possibleMoves });
    }
  }

  if (moveableMarbles.length === 0) return false;

  // Case 1: Only 1 moveable marble - must be able to move exactly 7
  if (moveableMarbles.length === 1) {
    // Check if player would finish after this move and have teammate marbles available
    const { owner, marbleId, possibleMoves } = moveableMarbles[0];

    // Can the single marble move exactly 7?
    if (possibleMoves.includes(7)) {
      return true;
    }

    // Check if moving this marble into home would finish the player,
    // making teammate's marbles available for the remainder
    for (let firstSpaces of possibleMoves) {
      if (firstSpaces >= 7) continue; // No remainder needed

      const marble = gameState.players[owner].marbles[marbleId];
      if (marble.location === 'track' && wouldBeFinishedAfterMove(gameState, owner, marbleId, true)) {
        const teammate = getTeammate(gameState, position);
        const remainingSpaces = 7 - firstSpaces;

        // Check if any teammate marble can move the remainder
        for (let tMarbleId in gameState.players[teammate].marbles) {
          const tMarble = gameState.players[teammate].marbles[tMarbleId];
          if (tMarble.location !== 'track' && tMarble.location !== 'home') continue;

          if (canMarbleMoveForward(gameState, teammate, tMarbleId, remainingSpaces)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  // Case 2: 2+ moveable marbles - check if any combination totals 7
  // First, check if any single marble can move exactly 7
  for (let marble of moveableMarbles) {
    if (marble.possibleMoves.includes(7)) {
      return true;
    }
  }

  // Check split combinations between two different marbles
  for (let i = 0; i < moveableMarbles.length; i++) {
    for (let j = 0; j < moveableMarbles.length; j++) {
      if (i === j) continue; // Must be different marbles

      for (let firstMove of moveableMarbles[i].possibleMoves) {
        const remainder = 7 - firstMove;
        if (remainder > 0 && remainder <= 7 && moveableMarbles[j].possibleMoves.includes(remainder)) {
          return true;
        }
      }
    }
  }

  return false;
}

// Check if path is blocked, but exclude a specific marble that will move away
function isPathBlockedExcluding(gameState, player, startPos, endPos, direction, excludeOwner, excludeMarbleId) {
  const excludeMarble = excludeOwner && excludeMarbleId ?
    gameState.players[excludeOwner].marbles[excludeMarbleId] : null;
  const excludePos = excludeMarble && excludeMarble.location === 'track' ? excludeMarble.position : -1;

  if (direction === 'forward') {
    let current = (startPos + 1) % 72;
    while (current !== endPos) {
      if (current !== excludePos) {
        const occupant = getMarbleOnTrack(gameState, current);
        if (occupant && occupant.player === player) {
          return true;
        }
      }
      current = (current + 1) % 72;
    }
  } else {
    let current = startPos - 1;
    if (current < 0) current += 72;
    while (current !== endPos) {
      if (current !== excludePos) {
        const occupant = getMarbleOnTrack(gameState, current);
        if (occupant && occupant.player === player) {
          return true;
        }
      }
      current = current - 1;
      if (current < 0) current += 72;
    }
  }
  return false;
}

// Check if player can play a 9 card
function canMove9Card(gameState, position) {
  const controllableMarbles = getControllableMarbles(gameState, position);

  // Need: one marble for forward (1-8 spaces) AND another marble on track for backward
  // The tricky part: after first marble moves, we need a DIFFERENT marble for backward
  // IMPORTANT: The first marble moving might unblock the backward path for the second marble

  // First, check if we have at least 2 marbles, or 1 marble + teammate marbles if we'd finish
  const trackMarbles = controllableMarbles.filter(m =>
    gameState.players[m.owner].marbles[m.marbleId].location === 'track'
  );

  // Need at least one marble on track for backward move
  if (trackMarbles.length === 0) return false;

  // Need at least one marble that can move forward
  for (let { owner, marbleId } of controllableMarbles) {
    for (let spaces = 1; spaces <= 8; spaces++) {
      if (canMarbleMoveForward(gameState, owner, marbleId, spaces)) {
        // Check if there's a DIFFERENT marble on track for backward
        const remainingSpaces = 9 - spaces;
        const firstMarble = gameState.players[owner].marbles[marbleId];

        // Check if first marble will leave the track (enter home)
        const willEnterHome = firstMarble.location === 'track' &&
          willMarbleEnterHome(gameState, owner, marbleId, spaces);

        for (let track of trackMarbles) {
          // Must be different marble
          if (track.owner === owner && track.marbleId === marbleId) continue;

          // Check if this marble could move backward
          const trackMarble = gameState.players[track.owner].marbles[track.marbleId];
          let backPos = trackMarble.position - remainingSpaces;
          if (backPos < 0) backPos += 72;

          // Check path - if first marble enters home, exclude it from blocking check
          let pathClear;
          if (willEnterHome) {
            pathClear = !isPathBlockedExcluding(gameState, track.owner, trackMarble.position, backPos, 'backward', owner, marbleId);
          } else {
            pathClear = !isPathBlocked(gameState, track.owner, trackMarble.position, backPos, 'backward');
          }

          if (pathClear) {
            // Also check destination isn't blocked (excluding first marble if it's leaving)
            const occupant = getMarbleOnTrack(gameState, backPos);
            const destClear = !occupant || occupant.player !== track.owner ||
              (willEnterHome && occupant.player === owner && occupant.marbleId === marbleId);

            if (destClear) {
              // Check if occupant is actually the first marble leaving
              if (occupant && willEnterHome && occupant.player === owner) {
                // First marble is at destination but will move away - OK
                return true;
              }
              if (!occupant || occupant.player !== track.owner) {
                const teammate = getTeammate(gameState, track.owner);
                if (occupant && occupant.player === teammate && !canLandOnTeammate(gameState, teammate)) {
                  continue;
                }
                return true;
              }
            }
          }
        }

        // Also check if moving this marble would finish the player, making teammate marbles available
        if (firstMarble.location === 'track' && wouldBeFinishedAfterMove(gameState, owner, marbleId, true)) {
          const teammate = getTeammate(gameState, position);
          for (let mId in gameState.players[teammate].marbles) {
            const tMarble = gameState.players[teammate].marbles[mId];
            if (tMarble.location === 'track') {
              let backPos = tMarble.position - remainingSpaces;
              if (backPos < 0) backPos += 72;
              // Exclude the first marble since it's entering home
              if (!isPathBlockedExcluding(gameState, teammate, tMarble.position, backPos, 'backward', owner, marbleId)) {
                const occupant = getMarbleOnTrack(gameState, backPos);
                if (!occupant || occupant.player !== teammate) {
                  return true;
                }
              }
            }
          }
        }
      }
    }
  }
  return false;
}

// Helper to check if a marble will enter home with given forward spaces
function willMarbleEnterHome(gameState, owner, marbleId, spaces) {
  const marble = gameState.players[owner].marbles[marbleId];
  if (marble.location !== 'track') return false;

  const homeEntry = gameState.board[owner].homeEntry;
  const startPos = marble.position;

  // Check if on home entry
  if (startPos === homeEntry) {
    return spaces <= 5;
  }

  // Check if crosses home entry
  for (let i = 1; i <= spaces; i++) {
    if ((startPos + i) % 72 === homeEntry) {
      const spacesIntoHome = spaces - i;
      return spacesIntoHome > 0 && spacesIntoHome <= 5;
    }
  }

  return false;
}

// Get all marbles the player can control (own + teammate's if finished)
function getControllableMarbles(gameState, position) {
  const marbles = [];

  // Own marbles
  for (let marbleId in gameState.players[position].marbles) {
    marbles.push({ owner: position, marbleId });
  }

  // Teammate's marbles if finished
  if (isPlayerFinished(gameState, position)) {
    const teammate = getTeammate(gameState, position);
    for (let marbleId in gameState.players[teammate].marbles) {
      marbles.push({ owner: teammate, marbleId });
    }
  }

  return marbles;
}

// ============ END LEGAL PLAY CHECKING ============

function enterLobby(gameState) {
  gameState.playerOrder.sort((a, b) => {
    const order = ['Seat1', 'Seat2', 'Seat3', 'Seat4'];
    return order.indexOf(a) - order.indexOf(b);
  });

  io.to(gameState.id).emit('lobbyReady', gameState);
}

function startGame(gameState, startingPlayer) {
  gameState.deck = createDeck();
  gameState.gameStarted = true;
  gameState.movesLog = []; // Reset moves log for new game

  // Set starting player
  const startIndex = gameState.playerOrder.indexOf(startingPlayer);
  if (startIndex !== -1) {
    gameState.currentPlayerIndex = startIndex;
  }

  for (let player of gameState.playerOrder) {
    dealCards(gameState, player, 5);
  }

  io.to(gameState.id).emit('gameStarted', gameState);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('checkPassword', (data) => {
    const { password } = data;
    if (password === GAME_PASSWORD) {
      socket.emit('passwordCorrect');
    } else {
      socket.emit('passwordIncorrect');
    }
  });

  // ============ TABLE MANAGEMENT ============

  // Get list of available tables
  socket.on('getTables', () => {
    const tableList = Object.values(tables).map(t => ({
      id: t.id,
      hostName: t.hostName,
      playerCount: Object.keys(t.players).length,
      gameStarted: t.gameStarted,
      seats: {
        Seat1: t.players.Seat1 ? t.players.Seat1.name : null,
        Seat2: t.players.Seat2 ? t.players.Seat2.name : null,
        Seat3: t.players.Seat3 ? t.players.Seat3.name : null,
        Seat4: t.players.Seat4 ? t.players.Seat4.name : null
      }
    }));
    socket.emit('tableList', tableList);
  });

  // Create a new table
  socket.on('createTable', (data) => {
    const { playerName } = data;
    const tableId = generateTableId();
    const gameState = createNewTable(tableId, playerName);
    tables[tableId] = gameState;

    // Join as Seat1 (host)
    const position = 'Seat1';
    gameState.players[position] = {
      socketId: socket.id,
      name: playerName,
      position,
      hand: [],
      marbles: {},
      discardPile: [],
      disconnected: false
    };

    for (let i = 0; i < 5; i++) {
      gameState.players[position].marbles[`marble${i}`] = {
        location: 'start',
        position: i
      };
      gameState.board[position].start[i].marble = position;
    }

    gameState.playerOrder.push(position);
    playerToTable[socket.id] = tableId;
    socket.join(tableId);

    socket.emit('joinSuccess', { position, gameState });
    io.to(tableId).emit('waitingRoomUpdate', gameState);

    // Broadcast updated table list to everyone not in a game
    io.emit('tableListUpdated');
  });

  // Join an existing table
  socket.on('joinTable', (data) => {
    const { tableId, playerName, position } = data;
    const gameState = tables[tableId];

    if (!gameState) {
      socket.emit('joinError', 'Table not found');
      return;
    }

    // Check if this is a reconnection attempt
    if (gameState.players[position]) {
      const existingPlayer = gameState.players[position];

      if (existingPlayer.name === playerName && existingPlayer.disconnected) {
        // Clear the disconnection timeout
        const timeoutKey = `${tableId}-${position}`;
        if (disconnectionTimeouts[timeoutKey]) {
          clearTimeout(disconnectionTimeouts[timeoutKey]);
          delete disconnectionTimeouts[timeoutKey];
        }

        // Restore connection
        existingPlayer.socketId = socket.id;
        existingPlayer.disconnected = false;
        playerToTable[socket.id] = tableId;
        socket.join(tableId);

        // Validate hand size
        if (existingPlayer.hand.length > 5) {
          console.warn(`[RECONNECT] Player ${playerName} had ${existingPlayer.hand.length} cards, trimming to 5`);
          const excessCards = existingPlayer.hand.splice(5);
          gameState.deck.unshift(...excessCards);
        }

        // Clear pending split move if it belongs to this player
        if (gameState.pendingSplitMove && gameState.pendingSplitMove.player === position) {
          console.log(`[RECONNECT] Clearing pending split move for ${playerName}`);
          gameState.pendingSplitMove = null;
        }

        console.log(`[RECONNECT] Player ${playerName} reconnected to table ${tableId} with ${existingPlayer.hand.length} cards`);
        socket.emit('joinSuccess', { position, gameState });
        io.to(tableId).emit('playerReconnected', { position, playerName });
        io.to(tableId).emit('gameStateUpdate', gameState);
        return;
      } else {
        socket.emit('joinError', 'Position already taken');
        return;
      }
    }

    if (Object.keys(gameState.players).length >= 4) {
      socket.emit('joinError', 'Table is full');
      return;
    }

    if (gameState.gameStarted) {
      socket.emit('joinError', 'Game already in progress');
      return;
    }

    gameState.players[position] = {
      socketId: socket.id,
      name: playerName,
      position,
      hand: [],
      marbles: {},
      discardPile: [],
      disconnected: false
    };

    for (let i = 0; i < 5; i++) {
      gameState.players[position].marbles[`marble${i}`] = {
        location: 'start',
        position: i
      };
      gameState.board[position].start[i].marble = position;
    }

    gameState.playerOrder.push(position);
    playerToTable[socket.id] = tableId;
    socket.join(tableId);

    socket.emit('joinSuccess', { position, gameState });
    io.to(tableId).emit('gameStateUpdate', gameState);
    io.to(tableId).emit('waitingRoomUpdate', gameState);

    if (Object.keys(gameState.players).length === 4) {
      enterLobby(gameState);
    }

    // Broadcast updated table list
    io.emit('tableListUpdated');
  });

  // Leave table (go back to lobby)
  socket.on('leaveTable', () => {
    const tableId = playerToTable[socket.id];
    if (!tableId || !tables[tableId]) return;

    const gameState = tables[tableId];
    const position = getPositionForSocket(socket.id);

    if (position && gameState.players[position]) {
      delete gameState.players[position];
      gameState.playerOrder = gameState.playerOrder.filter(p => p !== position);
    }

    delete playerToTable[socket.id];
    socket.leave(tableId);

    // If table is empty, clean it up
    if (Object.keys(gameState.players).length === 0) {
      delete tables[tableId];
    } else {
      io.to(tableId).emit('waitingRoomUpdate', gameState);
      io.to(tableId).emit('gameStateUpdate', gameState);
    }

    io.emit('tableListUpdated');
  });

  // ============ GAME EVENTS ============

  // Lobby: Select starting player (Seat 1 only, but broadcast to table)
  socket.on('selectStartingPlayer', (data) => {
    const tableId = playerToTable[socket.id];
    if (!tableId) return;
    const { startingPlayer } = data;
    io.to(tableId).emit('startingPlayerSelected', { startingPlayer });
  });

  // Lobby: Start game (Seat 1 only)
  socket.on('startGame', (data) => {
    const gameState = getTableForSocket(socket.id);
    if (!gameState) return;
    const { startingPlayer } = data;

    if (!startingPlayer) {
      socket.emit('error', 'No starting player selected');
      return;
    }

    startGame(gameState, startingPlayer);
    io.emit('tableListUpdated');
  });

  // Handle partial move for 7/9 cards (first part)
  socket.on('partialMove', (data) => {
    const gameState = getTableForSocket(socket.id);
    if (!gameState) return;

    const { position, cardIndex, cardType, moveData } = data;

    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    console.log(`[partialMove] Attempt by ${position}, currentPlayer is ${currentPlayer}, cardType ${cardType}`);

    if (position !== currentPlayer) {
      console.log(`[partialMove] REJECTED - Not your turn. ${position} tried but it's ${currentPlayer}'s turn`);
      logTurnState(gameState, 'partialMove-rejected');
      socket.emit('error', 'Not your turn');
      return;
    }

    const player = gameState.players[position];
    if (!player || cardIndex < 0 || cardIndex >= player.hand.length) {
      socket.emit('error', 'Invalid card selection');
      return;
    }

    const marbleOwner = moveData.marbleOwner || position;

    if (!canControlMarble(gameState, position, marbleOwner)) {
      socket.emit('error', 'Cannot move that marble');
      return;
    }

    if (cardType === 7) {
      const willFinishAfterMove = wouldBeFinishedAfterMove(gameState, marbleOwner, moveData.marbleId, moveData.enterHome);
      const moveableCount = countMoveableMarbles(gameState, position, willFinishAfterMove);
      if (moveableCount === 1 && moveData.spaces !== 7) {
        socket.emit('error', 'Only 1 marble can move - must use all 7 spaces');
        return;
      }
    }

    // Reset landing effects before processing
    gameState.currentMoveLandingEffects = [];
    const result = moveForward(gameState, marbleOwner, moveData, moveData.spaces);

    if (result.success) {
      const totalSpaces = cardType === 7 ? 7 : 9;
      const remainingSpaces = totalSpaces - moveData.spaces;

      // If used all spaces (for 7 card), complete immediately
      if (remainingSpaces === 0) {
        const card = player.hand.splice(cardIndex, 1)[0];
        player.discardPile.push(card);
        addMoveToLog(gameState, position, card, 'played', gameState.currentMoveLandingEffects);
        dealCards(gameState, position, 1);

        gameState.pendingSplitMove = null;

        if (checkWinCondition(gameState, position)) {
          const team = getTeam(gameState, position);
          const teammate = getTeammate(gameState, position);

          if (checkWinCondition(gameState, teammate)) {
            io.to(gameState.id).emit('gameWon', {
              winner: `${position} and ${teammate}`,
              team: team
            });
            return;
          }
        }

        nextTurn(gameState);
        io.to(gameState.id).emit('gameStateUpdate', gameState);
        socket.emit('splitMoveComplete');
        return;
      }

      // Store pending split move state
      gameState.pendingSplitMove = {
        player: position,
        cardIndex: cardIndex,
        cardType: cardType,
        firstMove: moveData,
        remainingSpaces: remainingSpaces
      };

      io.to(gameState.id).emit('gameStateUpdate', gameState);
      socket.emit('partialMoveSuccess', {
        remainingSpaces,
        cardType,
        playerFinished: isPlayerFinished(gameState, position)
      });
    } else {
      socket.emit('error', result.message);
    }
  });

  // Handle completing a split move (second part of 7/9)
  socket.on('completeSplitMove', (data) => {
    const gameState = getTableForSocket(socket.id);
    if (!gameState) return;

    const { position, moveData } = data;

    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    console.log(`[completeSplitMove] Attempt by ${position}, currentPlayer is ${currentPlayer}`);

    if (position !== currentPlayer) {
      console.log(`[completeSplitMove] REJECTED - Not your turn. ${position} tried but it's ${currentPlayer}'s turn`);
      logTurnState(gameState, 'completeSplitMove-rejected');
      socket.emit('error', 'Not your turn');
      return;
    }

    if (!gameState.pendingSplitMove || gameState.pendingSplitMove.player !== position) {
      console.log(`[completeSplitMove] REJECTED - No pending split move for ${position}`);
      socket.emit('error', 'No pending split move');
      return;
    }

    const pending = gameState.pendingSplitMove;
    const player = gameState.players[position];

    const marbleOwner = moveData.marbleOwner || position;

    if (!canControlMarble(gameState, position, marbleOwner)) {
      socket.emit('error', 'Cannot move that marble');
      return;
    }

    const firstMarbleOwner = pending.firstMove.marbleOwner || position;
    if (marbleOwner === firstMarbleOwner && moveData.marbleId === pending.firstMove.marbleId) {
      socket.emit('error', 'Must use a different marble');
      return;
    }

    gameState.currentMoveLandingEffects = [];
    let result;
    if (pending.cardType === 7) {
      result = moveForward(gameState, marbleOwner, moveData, pending.remainingSpaces);
    } else {
      result = moveBackwards(gameState, marbleOwner, moveData, pending.remainingSpaces);
    }

    if (result.success) {
      const card = player.hand.splice(pending.cardIndex, 1)[0];
      player.discardPile.push(card);
      addMoveToLog(gameState, position, card, 'played', gameState.currentMoveLandingEffects);
      dealCards(gameState, position, 1);

      gameState.pendingSplitMove = null;

      if (checkWinCondition(gameState, position)) {
        const team = getTeam(gameState, position);
        const teammate = getTeammate(gameState, position);

        if (checkWinCondition(gameState, teammate)) {
          io.to(gameState.id).emit('gameWon', {
            winner: `${position} and ${teammate}`,
            team: team
          });
          return;
        }
      }

      nextTurn(gameState);
      io.to(gameState.id).emit('gameStateUpdate', gameState);
    } else {
      socket.emit('error', result.message);
    }
  });

  socket.on('playCard', (data) => {
    const gameState = getTableForSocket(socket.id);
    if (!gameState) return;

    const { position, cardIndex, moveData } = data;

    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    console.log(`[playCard] Attempt by ${position}, currentPlayer is ${currentPlayer}, index ${gameState.currentPlayerIndex}`);

    if (position !== currentPlayer) {
      console.log(`[playCard] REJECTED - Not your turn. ${position} tried to play but it's ${currentPlayer}'s turn`);
      logTurnState(gameState, 'playCard-rejected');
      socket.emit('error', 'Not your turn');
      return;
    }

    gameState.pendingSplitMove = null;

    const player = gameState.players[position];
    if (!player || cardIndex < 0 || cardIndex >= player.hand.length) {
      socket.emit('error', 'Invalid card selection');
      return;
    }

    const card = player.hand[cardIndex];
    console.log(`[playCard] ${position} playing ${card.value} of ${card.suit}`);

    gameState.currentMoveLandingEffects = [];
    const result = processCardPlay(gameState, position, card, moveData);

    if (result.success) {
      player.hand.splice(cardIndex, 1);
      player.discardPile.push(card);
      addMoveToLog(gameState, position, card, 'played', gameState.currentMoveLandingEffects);
      dealCards(gameState, position, 1);

      if (checkWinCondition(gameState, position)) {
        const team = getTeam(gameState, position);
        const teammate = getTeammate(gameState, position);

        if (checkWinCondition(gameState, teammate)) {
          io.to(gameState.id).emit('gameWon', {
            winner: `${position} and ${teammate}`,
            team: team
          });
          return;
        }
      }

      nextTurn(gameState);
      logTurnState(gameState, 'playCard-afterTurn');
      io.to(gameState.id).emit('gameStateUpdate', gameState);
    } else {
      socket.emit('error', result.message);
    }
  });

  socket.on('discardCard', (data) => {
    const gameState = getTableForSocket(socket.id);
    if (!gameState) return;

    const { position, cardIndex } = data;

    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    console.log(`[discardCard] Attempt by ${position}, currentPlayer is ${currentPlayer}`);

    if (position !== currentPlayer) {
      console.log(`[discardCard] REJECTED - Not your turn. ${position} tried but it's ${currentPlayer}'s turn`);
      logTurnState(gameState, 'discardCard-rejected');
      socket.emit('error', 'Not your turn');
      return;
    }

    const player = gameState.players[position];
    if (!player || cardIndex < 0 || cardIndex >= player.hand.length) {
      socket.emit('error', 'Invalid card');
      return;
    }

    if (hasLegalPlay(gameState, position)) {
      console.log(`[discardCard] REJECTED - ${position} has a legal play available`);
      socket.emit('error', 'You have a legal play available - you must play a card');
      return;
    }

    const card = player.hand.splice(cardIndex, 1)[0];
    console.log(`[discardCard] ${position} discarding ${card.value} of ${card.suit} (no legal plays available)`);
    player.discardPile.push(card);
    addMoveToLog(gameState, position, card, 'discarded', []);
    dealCards(gameState, position, 1);

    gameState.pendingSplitMove = null;

    nextTurn(gameState);
    logTurnState(gameState, 'discardCard-afterTurn');
    io.to(gameState.id).emit('gameStateUpdate', gameState);
  });

  // ============ HOST CONTROLS ============

  // Host restarts game at same table
  socket.on('hostRestartGame', () => {
    const gameState = getTableForSocket(socket.id);
    if (!gameState) return;

    const position = getPositionForSocket(socket.id);
    if (position !== 'Seat1') {
      socket.emit('error', 'Only the host can restart the game');
      return;
    }

    // Reset game state but keep players
    gameState.board = initializeBoard();
    gameState.deck = [];
    gameState.discardPile = [];
    gameState.gameStarted = false;
    gameState.pendingSplitMove = null;
    gameState.movesLog = [];
    gameState.currentMoveLandingEffects = [];
    gameState.currentPlayerIndex = 0;

    // Reset all player marbles and hands
    for (let pos of gameState.playerOrder) {
      const player = gameState.players[pos];
      player.hand = [];
      player.discardPile = [];
      player.marbles = {};
      for (let i = 0; i < 5; i++) {
        player.marbles[`marble${i}`] = {
          location: 'start',
          position: i
        };
        gameState.board[pos].start[i].marble = pos;
      }
    }

    io.to(gameState.id).emit('gameRestarted', gameState);
    io.to(gameState.id).emit('lobbyReady', gameState);
    io.emit('tableListUpdated');
  });

  // Host closes table
  socket.on('hostCloseTable', () => {
    const tableId = playerToTable[socket.id];
    if (!tableId || !tables[tableId]) return;

    const gameState = tables[tableId];
    const position = getPositionForSocket(socket.id);
    if (position !== 'Seat1') {
      socket.emit('error', 'Only the host can close the table');
      return;
    }

    // Notify all players and clean up
    io.to(tableId).emit('tableClosed');

    // Remove all player mappings
    for (let pos in gameState.players) {
      const player = gameState.players[pos];
      if (player.socketId) {
        delete playerToTable[player.socketId];
        const sock = io.sockets.sockets.get(player.socketId);
        if (sock) sock.leave(tableId);
      }
    }

    // Clear any disconnection timeouts for this table
    for (let key in disconnectionTimeouts) {
      if (key.startsWith(tableId + '-')) {
        clearTimeout(disconnectionTimeouts[key]);
        delete disconnectionTimeouts[key];
      }
    }

    delete tables[tableId];
    io.emit('tableListUpdated');
  });

  // ============ DISCONNECT ============

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    const tableId = playerToTable[socket.id];
    if (!tableId || !tables[tableId]) {
      delete playerToTable[socket.id];
      return;
    }

    const gameState = tables[tableId];
    const position = getPositionForSocket(socket.id);

    if (position && gameState.players[position]) {
      const playerName = gameState.players[position].name;

      gameState.players[position].disconnected = true;

      console.log(`Player ${playerName} at ${position} disconnected from table ${tableId} - waiting for reconnection...`);

      io.to(tableId).emit('playerDisconnected', { position, playerName });

      const timeoutKey = `${tableId}-${position}`;
      disconnectionTimeouts[timeoutKey] = setTimeout(() => {
        if (tables[tableId] && tables[tableId].players[position] && tables[tableId].players[position].disconnected) {
          console.log(`Player ${playerName} at ${position} did not reconnect to table ${tableId} - removing`);

          delete tables[tableId].players[position];
          tables[tableId].playerOrder = tables[tableId].playerOrder.filter(p => p !== position);
          delete disconnectionTimeouts[timeoutKey];

          io.to(tableId).emit('playerRemoved', { position, playerName });
          io.to(tableId).emit('gameStateUpdate', tables[tableId]);

          // If table is empty, delete it
          if (Object.keys(tables[tableId].players).length === 0) {
            delete tables[tableId];
            io.emit('tableListUpdated');
          }
        }
      }, 30000);
    }

    delete playerToTable[socket.id];
  });
});

function processCardPlay(gameState, actingPlayer, card, moveData) {
  const cardValue = getCardValue(card);

  const marbleOwner = moveData.marbleOwner || actingPlayer;

  if (moveData.marbleId && !canControlMarble(gameState, actingPlayer, marbleOwner)) {
    return { success: false, message: 'Cannot move that marble' };
  }

  if (cardValue === 'face' || cardValue === 1) {
    if (moveData.action === 'enter') {
      return enterBoard(gameState, marbleOwner, moveData);
    } else {
      const spaces = cardValue === 'face' ? 10 : 1;
      return moveForward(gameState, marbleOwner, moveData, spaces);
    }
  }

  if (cardValue === 'joker') {
    return placeJoker(gameState, actingPlayer, marbleOwner, moveData);
  }

  if (cardValue === 7) {
    return move7(gameState, actingPlayer, moveData);
  }

  if (cardValue === 8) {
    return moveBackwards(gameState, marbleOwner, moveData, 8);
  }

  if (cardValue === 9) {
    return move9(gameState, actingPlayer, moveData);
  }

  return moveForward(gameState, marbleOwner, moveData, cardValue);
}

function enterBoard(gameState, player, moveData) {
  const { marbleId } = moveData;
  const marble = gameState.players[player].marbles[marbleId];

  if (marble.location !== 'start') {
    return { success: false, message: 'Marble not in start area' };
  }

  const entryPosition = gameState.board[player].trackEntry;

  const occupant = getMarbleOnTrack(gameState, entryPosition);
  if (occupant && occupant.player === player) {
    return { success: false, message: 'Cannot land on your own marble' };
  }

  // Check if landing on teammate is valid (their home entry must be available)
  const teammate = getTeammate(gameState, player);
  if (occupant && occupant.player === teammate && !canLandOnTeammate(gameState, teammate)) {
    return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
  }

  gameState.board[player].start[marble.position].marble = null;

  marble.location = 'track';
  marble.position = entryPosition;

  if (occupant) {
    handleLanding(gameState, player, occupant.player, occupant.marbleId);
  }

  return { success: true };
}

function moveForward(gameState, player, moveData, spaces) {
  const { marbleId, enterHome } = moveData;
  const marble = gameState.players[player].marbles[marbleId];

  if (marble.location !== 'track' && marble.location !== 'home') {
    return { success: false, message: 'Marble not on track or in home' };
  }

  if (marble.location === 'home') {
    const currentHomePos = marble.position;
    const newHomePos = currentHomePos + spaces;

    if (newHomePos > 4) {
      return { success: false, message: 'Move exceeds home zone' };
    }

    if (isHomePathBlocked(gameState, player, currentHomePos, newHomePos)) {
      return { success: false, message: 'Path blocked by your own marble in home' };
    }

    if (isHomePositionOccupied(gameState, player, newHomePos)) {
      return { success: false, message: 'Home space occupied' };
    }

    gameState.board[player].home[currentHomePos].marble = null;
    marble.position = newHomePos;
    gameState.board[player].home[newHomePos].marble = player;
    return { success: true };
  }

  const homeEntry = gameState.board[player].homeEntry;
  const startPos = marble.position;

  const onHomeEntry = startPos === homeEntry;
  let crossesHome = false;
  let spacesToHomeEntry = 0;

  if (!onHomeEntry) {
    for (let i = 1; i <= spaces; i++) {
      if ((startPos + i) % 72 === homeEntry) {
        crossesHome = true;
        spacesToHomeEntry = i;
        break;
      }
    }
  }

  if (onHomeEntry || crossesHome) {
    const spacesIntoHome = onHomeEntry ? spaces : spaces - spacesToHomeEntry;

    const canEnterHome = spacesIntoHome > 0 && spacesIntoHome <= 5 &&
      !isHomePathBlockedFromStart(gameState, player, spacesIntoHome - 1) &&
      !isHomePositionOccupied(gameState, player, spacesIntoHome - 1);

    const trackDestination = (startPos + spaces) % 72;
    const canPassHome = !isPathBlockedIncludingHomeEntry(gameState, player, startPos, trackDestination, homeEntry) &&
      !(getMarbleOnTrack(gameState, trackDestination)?.player === player);

    if (enterHome === true) {
      if (!canEnterHome) {
        return { success: false, message: 'Cannot enter home' };
      }
      const homeIndex = spacesIntoHome - 1;
      marble.location = 'home';
      marble.position = homeIndex;
      gameState.board[player].home[homeIndex].marble = player;
      return { success: true };
    } else if (enterHome === false) {
      if (!canPassHome) {
        return { success: false, message: 'Cannot pass home' };
      }
      const occupant = getMarbleOnTrack(gameState, trackDestination);
      const teammate = getTeammate(gameState, player);
      if (occupant && occupant.player === teammate && !canLandOnTeammate(gameState, teammate)) {
        return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
      }
      marble.position = trackDestination;
      if (occupant && occupant.player !== player) {
        handleLanding(gameState, player, occupant.player, occupant.marbleId);
      }
      return { success: true };
    }

    if (canEnterHome && !canPassHome) {
      const homeIndex = spacesIntoHome - 1;
      marble.location = 'home';
      marble.position = homeIndex;
      gameState.board[player].home[homeIndex].marble = player;
      return { success: true };
    } else if (!canEnterHome && canPassHome) {
      const occupant = getMarbleOnTrack(gameState, trackDestination);
      const teammate = getTeammate(gameState, player);
      if (occupant && occupant.player === teammate && !canLandOnTeammate(gameState, teammate)) {
        return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
      }
      marble.position = trackDestination;
      if (occupant && occupant.player !== player) {
        handleLanding(gameState, player, occupant.player, occupant.marbleId);
      }
      return { success: true };
    } else if (canEnterHome && canPassHome) {
      const homeIndex = spacesIntoHome - 1;
      marble.location = 'home';
      marble.position = homeIndex;
      gameState.board[player].home[homeIndex].marble = player;
      return { success: true };
    } else {
      return { success: false, message: 'No valid move available' };
    }
  }

  const newPosition = (startPos + spaces) % 72;

  if (isPathBlocked(gameState, player, startPos, newPosition, 'forward')) {
    return { success: false, message: 'Path blocked by your own marble' };
  }

  const occupant = getMarbleOnTrack(gameState, newPosition);
  if (occupant && occupant.player === player) {
    return { success: false, message: 'Cannot land on your own marble' };
  }

  const teammate = getTeammate(gameState, player);
  if (occupant && occupant.player === teammate && !canLandOnTeammate(gameState, teammate)) {
    return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
  }

  marble.position = newPosition;

  if (occupant) {
    handleLanding(gameState, player, occupant.player, occupant.marbleId);
  }

  return { success: true };
}

function moveBackwards(gameState, player, moveData, spaces) {
  const { marbleId } = moveData;
  const marble = gameState.players[player].marbles[marbleId];

  if (marble.location !== 'track') {
    return { success: false, message: 'Marble not on track' };
  }

  let newPosition = marble.position - spaces;
  if (newPosition < 0) newPosition += 72;

  if (isPathBlocked(gameState, player, marble.position, newPosition, 'backward')) {
    return { success: false, message: 'Path blocked by your own marble' };
  }

  const occupant = getMarbleOnTrack(gameState, newPosition);
  if (occupant && occupant.player === player) {
    return { success: false, message: 'Cannot land on your own marble' };
  }

  const teammate = getTeammate(gameState, player);
  if (occupant && occupant.player === teammate && !canLandOnTeammate(gameState, teammate)) {
    return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
  }

  marble.position = newPosition;

  if (occupant) {
    handleLanding(gameState, player, occupant.player, occupant.marbleId);
  }

  return { success: true };
}

function move7(gameState, actingPlayer, moveData) {
  const { moves } = moveData;

  if (!moves || moves.length === 0) {
    return { success: false, message: 'No moves specified' };
  }

  let totalSpaces = 0;
  for (let move of moves) {
    totalSpaces += move.spaces;
  }

  if (totalSpaces !== 7) {
    return { success: false, message: 'Moves must total 7 spaces' };
  }

  const owners = moves.map(m => m.marbleOwner || actingPlayer);

  if (moves.length === 2) {
    const sameOwnerSameMarble = owners[0] === owners[1] && moves[0].marbleId === moves[1].marbleId;
    if (sameOwnerSameMarble) {
      return { success: false, message: 'Must use two different marbles when splitting' };
    }
  }

  for (let move of moves) {
    const owner = move.marbleOwner || actingPlayer;
    if (!canControlMarble(gameState, actingPlayer, owner)) {
      return { success: false, message: 'Cannot move that marble' };
    }
    const result = moveForward(gameState, owner, {
      marbleId: move.marbleId,
      enterHome: move.enterHome
    }, move.spaces);
    if (!result.success) {
      return result;
    }
  }

  return { success: true };
}

function move9(gameState, actingPlayer, moveData) {
  const { forward, backward } = moveData;

  if (!forward || !backward) {
    return { success: false, message: 'Must specify both forward and backward moves' };
  }

  if (forward.spaces + backward.spaces !== 9) {
    return { success: false, message: 'Moves must total 9 spaces' };
  }

  const forwardOwner = forward.marbleOwner || actingPlayer;
  const backwardOwner = backward.marbleOwner || actingPlayer;

  const sameOwnerSameMarble = forwardOwner === backwardOwner && forward.marbleId === backward.marbleId;
  if (sameOwnerSameMarble) {
    return { success: false, message: 'Must use two different marbles for 9' };
  }

  if (!canControlMarble(gameState, actingPlayer, forwardOwner)) {
    return { success: false, message: 'Cannot move that marble' };
  }
  if (!canControlMarble(gameState, actingPlayer, backwardOwner)) {
    return { success: false, message: 'Cannot move that marble' };
  }

  let result = moveForward(gameState, forwardOwner, {
    marbleId: forward.marbleId,
    enterHome: forward.enterHome
  }, forward.spaces);
  if (!result.success) return result;

  result = moveBackwards(gameState, backwardOwner, { marbleId: backward.marbleId }, backward.spaces);
  if (!result.success) return result;

  return { success: true };
}

function placeJoker(gameState, actingPlayer, marbleOwner, moveData) {
  const { sourceMarbleId, targetPlayer, targetMarbleId } = moveData;
  const sourceMarble = gameState.players[marbleOwner].marbles[sourceMarbleId];
  const targetMarble = gameState.players[targetPlayer].marbles[targetMarbleId];

  if (sourceMarble.location !== 'track' && sourceMarble.location !== 'start') {
    return { success: false, message: 'Source marble must be on track or in start' };
  }

  if (targetMarble.location !== 'track') {
    return { success: false, message: 'Target marble must be on track' };
  }

  if (marbleOwner === targetPlayer) {
    return { success: false, message: 'Cannot joker onto your own marble' };
  }

  const teammate = getTeammate(gameState, marbleOwner);
  if (targetPlayer === teammate && !canLandOnTeammate(gameState, teammate)) {
    return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
  }

  if (sourceMarble.location === 'start') {
    gameState.board[marbleOwner].start[sourceMarble.position].marble = null;
  }

  const targetPosition = targetMarble.position;
  sourceMarble.location = 'track';
  sourceMarble.position = targetPosition;

  handleLanding(gameState, marbleOwner, targetPlayer, targetMarbleId);

  return { success: true };
}

function handleLanding(gameState, landingPlayer, targetPlayer, targetMarbleId) {
  const targetMarble = gameState.players[targetPlayer].marbles[targetMarbleId];
  const teammate = getTeammate(gameState, landingPlayer);

  if (targetPlayer === teammate) {
    // Send teammate to home entry
    const homeEntry = gameState.board[targetPlayer].homeEntry;

    // Check if there's already a marble at the home entry (for chain reactions)
    const occupant = getMarbleOnTrack(gameState, homeEntry);

    targetMarble.position = homeEntry;
    gameState.currentMoveLandingEffects.push({ targetPlayer, type: 'teammate' });

    // If there's an occupant at the home entry, trigger chain reaction
    if (occupant) {
      handleLanding(gameState, targetPlayer, occupant.player, occupant.marbleId);
    }
  } else {
    // Send enemy back to start
    const startIndex = parseInt(targetMarbleId.replace('marble', ''));
    targetMarble.location = 'start';
    targetMarble.position = startIndex;
    gameState.board[targetPlayer].start[startIndex].marble = targetPlayer;
    gameState.currentMoveLandingEffects.push({ targetPlayer, type: 'enemy' });
  }
}

function checkWinCondition(gameState, player) {
  const teammate = getTeammate(gameState, player);
  return isPlayerFinished(gameState, player) && isPlayerFinished(gameState, teammate);
}

function getTeam(gameState, player) {
  if (gameState.teams.team1.includes(player)) return 'team1';
  return 'team2';
}

function nextTurn(gameState) {
  // Clear any pending split move when turn changes
  gameState.pendingSplitMove = null;
  const previousIndex = gameState.currentPlayerIndex;
  const previousPlayer = gameState.playerOrder[previousIndex];
  gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % 4;
  const newPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
  console.log(`[TURN] Turn changed: ${previousPlayer} (index ${previousIndex}) -> ${newPlayer} (index ${gameState.currentPlayerIndex})`);
}

function logTurnState(gameState, context) {
  const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
  const currentPlayerName = gameState.players[currentPlayer]?.name || 'Unknown';
  console.log(`[DEBUG ${context}] Current turn: ${currentPlayer} (${currentPlayerName}), index: ${gameState.currentPlayerIndex}, playerOrder: ${gameState.playerOrder.join(', ')}`);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
