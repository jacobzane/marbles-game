const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const GAME_PASSWORD = process.env.GAME_PASSWORD || 'Berg270';

app.use(express.static('public'));

// Game state
let gameState = {
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
  // Track partial moves for 7 and 9 cards
  pendingSplitMove: null,
  // Track recent moves for display
  movesLog: []
};

// Track disconnected players for reconnection
let disconnectionTimeouts = {};

// Temporary storage for landing effects during move processing
let currentMoveLandingEffects = [];

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

function dealCards(playerId, count) {
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

function addMoveToLog(player, card, action = 'played', landingEffects = []) {
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

function getMarbleOnTrack(trackPosition) {
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

function getTeammate(player) {
  if (gameState.teams.team1.includes(player)) {
    return gameState.teams.team1.find(p => p !== player);
  } else {
    return gameState.teams.team2.find(p => p !== player);
  }
}

// Check if landing on a teammate is valid (their home entry must not be occupied by their own marble)
function canLandOnTeammate(teammate) {
  const homeEntry = gameState.board[teammate].homeEntry;
  const occupant = getMarbleOnTrack(homeEntry);

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

function isPlayerFinished(player) {
  let inHome = 0;
  for (let marbleId in gameState.players[player].marbles) {
    if (gameState.players[player].marbles[marbleId].location === 'home') {
      inHome++;
    }
  }
  return inHome === 5;
}

function canControlMarble(actingPlayer, marbleOwner) {
  if (actingPlayer === marbleOwner) return true;
  if (isPlayerFinished(actingPlayer) && getTeammate(actingPlayer) === marbleOwner) return true;
  return false;
}

// Count moveable marbles for a player (considering teammate if finished)
// If assumeFinishedAfterMove is true, count teammate's marbles even if not finished yet
// (used when checking if a 7/9 card split is valid when the first move would finish the player)
function countMoveableMarbles(actingPlayer, assumeFinishedAfterMove = false) {
  let count = 0;

  // Check own marbles
  for (let marbleId in gameState.players[actingPlayer].marbles) {
    const marble = gameState.players[actingPlayer].marbles[marbleId];
    if (marble.location === 'track' || marble.location === 'home') {
      count++;
    }
  }

  // Check teammate's marbles if finished (or will be finished after this move)
  if (isPlayerFinished(actingPlayer) || assumeFinishedAfterMove) {
    const teammate = getTeammate(actingPlayer);
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
function wouldBeFinishedAfterMove(player, marbleId, enteringHome) {
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
function countMarblesOnTrack(actingPlayer) {
  let count = 0;
  
  // Check own marbles
  for (let marbleId in gameState.players[actingPlayer].marbles) {
    const marble = gameState.players[actingPlayer].marbles[marbleId];
    if (marble.location === 'track') {
      count++;
    }
  }
  
  // Check teammate's marbles if finished
  if (isPlayerFinished(actingPlayer)) {
    const teammate = getTeammate(actingPlayer);
    for (let marbleId in gameState.players[teammate].marbles) {
      const marble = gameState.players[teammate].marbles[marbleId];
      if (marble.location === 'track') {
        count++;
      }
    }
  }
  
  return count;
}

function isPathBlocked(player, startPos, endPos, direction = 'forward') {
  if (direction === 'forward') {
    let current = (startPos + 1) % 72;
    while (current !== endPos) {
      const occupant = getMarbleOnTrack(current);
      if (occupant && occupant.player === player) {
        return true;
      }
      current = (current + 1) % 72;
    }
  } else {
    let current = startPos - 1;
    if (current < 0) current += 72;
    while (current !== endPos) {
      const occupant = getMarbleOnTrack(current);
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
function isHomePositionOccupied(player, homeIndex) {
  for (let marbleId in gameState.players[player].marbles) {
    const marble = gameState.players[player].marbles[marbleId];
    if (marble.location === 'home' && marble.position === homeIndex) {
      return true;
    }
  }
  return false;
}

function isHomePathBlocked(player, startHomePos, endHomePos) {
  for (let i = startHomePos + 1; i < endHomePos; i++) {
    // Use marble objects as source of truth instead of board state
    if (isHomePositionOccupied(player, i)) {
      return true;
    }
  }
  return false;
}

function isHomePathBlockedFromStart(player, targetHomeIndex) {
  for (let i = 0; i < targetHomeIndex; i++) {
    // Use marble objects as source of truth instead of board state
    if (isHomePositionOccupied(player, i)) {
      return true;
    }
  }
  return false;
}

function isPathBlockedIncludingHomeEntry(player, startPos, endPos, homeEntry) {
  let current = (startPos + 1) % 72;
  while (current !== endPos) {
    if (current !== homeEntry) {
      const occupant = getMarbleOnTrack(current);
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
function hasLegalPlay(position) {
  const player = gameState.players[position];
  if (!player || !player.hand) return false;

  for (let card of player.hand) {
    if (canPlayCard(position, card)) {
      return true;
    }
  }
  return false;
}

// Check if a specific card can be legally played
function canPlayCard(position, card) {
  const cardValue = card.value;

  // Handle face cards and special cards
  if (cardValue === 'A') {
    // Ace: Enter from start OR move 1 OR move 11
    if (canEnterFromStart(position)) return true;
    if (canMoveAnyMarbleForward(position, 1)) return true;
    if (canMoveAnyMarbleForward(position, 11)) return true;
    return false;
  }

  if (cardValue === 'K') {
    // King: Enter from start OR move 13
    if (canEnterFromStart(position)) return true;
    if (canMoveAnyMarbleForward(position, 13)) return true;
    return false;
  }

  if (cardValue === 'Joker') {
    // Joker: Enter from start OR land on any other player's marble
    if (canEnterFromStart(position)) return true;
    if (canJokerMove(position)) return true;
    return false;
  }

  if (cardValue === 'J') {
    // Jack moves 11 spaces
    return canMoveAnyMarbleForward(position, 11);
  }

  if (cardValue === 'Q') {
    // Queen moves 12 spaces
    return canMoveAnyMarbleForward(position, 12);
  }

  if (cardValue === '4') {
    // 4: Move backward 4 spaces
    return canMoveAnyMarbleBackward(position, 4);
  }

  if (cardValue === '7') {
    // 7: Split forward move - need at least one marble that can move 1-7 spaces forward
    return canMove7Card(position);
  }

  if (cardValue === '9') {
    // 9: Split move - forward 1-8, then different marble backward remainder
    return canMove9Card(position);
  }

  // Regular number cards (2, 3, 5, 6, 8, 10)
  const spaces = parseInt(cardValue);
  if (!isNaN(spaces)) {
    return canMoveAnyMarbleForward(position, spaces);
  }

  return false;
}

// Check if player can enter a marble from start
function canEnterFromStart(position) {
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
  const occupant = getMarbleOnTrack(entryPosition);

  if (occupant && occupant.player === position) {
    return false; // Blocked by own marble
  }

  // Check if landing on teammate and their home entry is blocked
  const teammate = getTeammate(position);
  if (occupant && occupant.player === teammate && !canLandOnTeammate(teammate)) {
    return false;
  }

  return true;
}

// Check if any controllable marble can move forward the given spaces
function canMoveAnyMarbleForward(position, spaces) {
  const controllableMarbles = getControllableMarbles(position);

  for (let { owner, marbleId } of controllableMarbles) {
    if (canMarbleMoveForward(owner, marbleId, spaces)) {
      return true;
    }
  }
  return false;
}

// Check if a specific marble can move forward the given spaces
function canMarbleMoveForward(owner, marbleId, spaces) {
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
      if (isHomePositionOccupied(owner, i)) {
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
      if (!isHomePathBlockedFromStart(owner, homeIndex) &&
          !isHomePositionOccupied(owner, homeIndex)) {
        return true; // Can enter home
      }
    }

    // Check if can pass home and continue on track
    const trackDest = (startPos + spaces) % 72;
    if (!isPathBlockedIncludingHomeEntry(owner, startPos, trackDest, homeEntry)) {
      const occupant = getMarbleOnTrack(trackDest);
      if (!occupant || occupant.player !== owner) {
        // Check teammate landing validity
        const teammate = getTeammate(owner);
        if (occupant && occupant.player === teammate && !canLandOnTeammate(teammate)) {
          return false;
        }
        return true;
      }
    }
  } else {
    // Normal forward move not crossing home
    const newPosition = (startPos + spaces) % 72;
    if (!isPathBlocked(owner, startPos, newPosition, 'forward')) {
      const occupant = getMarbleOnTrack(newPosition);
      if (!occupant || occupant.player !== owner) {
        const teammate = getTeammate(owner);
        if (occupant && occupant.player === teammate && !canLandOnTeammate(teammate)) {
          return false;
        }
        return true;
      }
    }
  }

  return false;
}

// Check if any controllable marble can move backward the given spaces
function canMoveAnyMarbleBackward(position, spaces) {
  const controllableMarbles = getControllableMarbles(position);

  for (let { owner, marbleId } of controllableMarbles) {
    const marble = gameState.players[owner].marbles[marbleId];
    if (marble.location !== 'track') continue;

    let newPosition = marble.position - spaces;
    if (newPosition < 0) newPosition += 72;

    if (!isPathBlocked(owner, marble.position, newPosition, 'backward')) {
      const occupant = getMarbleOnTrack(newPosition);
      if (!occupant || occupant.player !== owner) {
        const teammate = getTeammate(owner);
        if (occupant && occupant.player === teammate && !canLandOnTeammate(teammate)) {
          continue;
        }
        return true;
      }
    }
  }
  return false;
}

// Check if player can make a valid joker move
function canJokerMove(position) {
  const controllableMarbles = getControllableMarbles(position);

  // Need at least one marble to move
  if (controllableMarbles.length === 0) return false;

  // Check if there's any target marble on track (not our own)
  for (let player of gameState.playerOrder) {
    if (player === position) continue; // Skip own marbles for target

    for (let marbleId in gameState.players[player].marbles) {
      const marble = gameState.players[player].marbles[marbleId];
      if (marble.location === 'track') {
        // Found a potential target - check if we can land on it
        const teammate = getTeammate(position);
        if (player === teammate && !canLandOnTeammate(teammate)) {
          continue; // Can't land on this teammate marble
        }
        return true;
      }
    }
  }
  return false;
}

// Check if player can play a 7 card
function canMove7Card(position) {
  const controllableMarbles = getControllableMarbles(position);

  // Collect marbles that can move and how far they can move
  const moveableMarbles = [];
  for (let { owner, marbleId } of controllableMarbles) {
    const marble = gameState.players[owner].marbles[marbleId];
    if (marble.location !== 'track' && marble.location !== 'home') continue;

    const possibleMoves = [];
    for (let spaces = 1; spaces <= 7; spaces++) {
      if (canMarbleMoveForward(owner, marbleId, spaces)) {
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
      if (marble.location === 'track' && wouldBeFinishedAfterMove(owner, marbleId, true)) {
        const teammate = getTeammate(position);
        const remainingSpaces = 7 - firstSpaces;

        // Check if any teammate marble can move the remainder
        for (let tMarbleId in gameState.players[teammate].marbles) {
          const tMarble = gameState.players[teammate].marbles[tMarbleId];
          if (tMarble.location !== 'track' && tMarble.location !== 'home') continue;

          if (canMarbleMoveForward(teammate, tMarbleId, remainingSpaces)) {
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

// Check if player can play a 9 card
function canMove9Card(position) {
  const controllableMarbles = getControllableMarbles(position);

  // Need: one marble for forward (1-8 spaces) AND another marble on track for backward
  // The tricky part: after first marble moves, we need a DIFFERENT marble for backward

  // First, check if we have at least 2 marbles, or 1 marble + teammate marbles if we'd finish
  const trackMarbles = controllableMarbles.filter(m =>
    gameState.players[m.owner].marbles[m.marbleId].location === 'track'
  );

  // Need at least one marble on track for backward move
  if (trackMarbles.length === 0) return false;

  // Need at least one marble that can move forward
  for (let { owner, marbleId } of controllableMarbles) {
    for (let spaces = 1; spaces <= 8; spaces++) {
      if (canMarbleMoveForward(owner, marbleId, spaces)) {
        // Check if there's a DIFFERENT marble on track for backward
        const remainingSpaces = 9 - spaces;

        for (let track of trackMarbles) {
          // Must be different marble
          if (track.owner === owner && track.marbleId === marbleId) continue;

          // Check if this marble could move backward
          const trackMarble = gameState.players[track.owner].marbles[track.marbleId];
          let backPos = trackMarble.position - remainingSpaces;
          if (backPos < 0) backPos += 72;

          // Simple check - is path clear and destination valid?
          if (!isPathBlocked(track.owner, trackMarble.position, backPos, 'backward')) {
            const occupant = getMarbleOnTrack(backPos);
            if (!occupant || occupant.player !== track.owner) {
              const teammate = getTeammate(track.owner);
              if (occupant && occupant.player === teammate && !canLandOnTeammate(teammate)) {
                continue;
              }
              return true;
            }
          }
        }

        // Also check if moving this marble would finish the player, making teammate marbles available
        const marble = gameState.players[owner].marbles[marbleId];
        if (marble.location === 'track' && wouldBeFinishedAfterMove(owner, marbleId, true)) {
          const teammate = getTeammate(position);
          for (let mId in gameState.players[teammate].marbles) {
            const tMarble = gameState.players[teammate].marbles[mId];
            if (tMarble.location === 'track') {
              let backPos = tMarble.position - remainingSpaces;
              if (backPos < 0) backPos += 72;
              if (!isPathBlocked(teammate, tMarble.position, backPos, 'backward')) {
                const occupant = getMarbleOnTrack(backPos);
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

// Get all marbles the player can control (own + teammate's if finished)
function getControllableMarbles(position) {
  const marbles = [];

  // Own marbles
  for (let marbleId in gameState.players[position].marbles) {
    marbles.push({ owner: position, marbleId });
  }

  // Teammate's marbles if finished
  if (isPlayerFinished(position)) {
    const teammate = getTeammate(position);
    for (let marbleId in gameState.players[teammate].marbles) {
      marbles.push({ owner: teammate, marbleId });
    }
  }

  return marbles;
}

// ============ END LEGAL PLAY CHECKING ============

function enterLobby() {
  gameState.playerOrder.sort((a, b) => {
    const order = ['Seat1', 'Seat2', 'Seat3', 'Seat4'];
    return order.indexOf(a) - order.indexOf(b);
  });

  io.emit('lobbyReady', gameState);
}

function startGame(startingPlayer) {
  gameState.deck = createDeck();
  gameState.gameStarted = true;
  gameState.movesLog = []; // Reset moves log for new game

  // Set starting player
  const startIndex = gameState.playerOrder.indexOf(startingPlayer);
  if (startIndex !== -1) {
    gameState.currentPlayerIndex = startIndex;
  }

  for (let player of gameState.playerOrder) {
    dealCards(player, 5);
  }

  io.emit('gameStarted', gameState);
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

  socket.on('joinGame', (data) => {
    const { playerName, position } = data;

    // Check if this is a reconnection attempt
    if (gameState.players[position]) {
      const existingPlayer = gameState.players[position];

      // Allow reconnection if same player name and they were disconnected
      if (existingPlayer.name === playerName && existingPlayer.disconnected) {
        // Clear the disconnection timeout
        if (disconnectionTimeouts[position]) {
          clearTimeout(disconnectionTimeouts[position]);
          delete disconnectionTimeouts[position];
        }

        // Restore connection
        existingPlayer.socketId = socket.id;
        existingPlayer.disconnected = false;

        console.log(`Player ${playerName} reconnected to ${position}`);
        socket.emit('joinSuccess', { position, gameState });
        io.emit('playerReconnected', { position, playerName });
        io.emit('gameStateUpdate', gameState);
        return;
      } else {
        socket.emit('joinError', 'Position already taken');
        return;
      }
    }

    if (Object.keys(gameState.players).length >= 4) {
      socket.emit('joinError', 'Game is full');
      return;
    }

    gameState.players[position] = {
      socketId: socket.id,
      name: playerName,
      position,
      hand: [],
      marbles: {},
      discardPile: [], // Per-player discard pile
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

    socket.emit('joinSuccess', { position, gameState });
    io.emit('gameStateUpdate', gameState);
    io.emit('waitingRoomUpdate', gameState);

    if (Object.keys(gameState.players).length === 4) {
      enterLobby();
    }
  });

  // Lobby: Select starting player (Seat 1 only, but broadcast to all)
  socket.on('selectStartingPlayer', (data) => {
    const { startingPlayer } = data;

    // Broadcast to all players
    io.emit('startingPlayerSelected', { startingPlayer });
  });

  // Lobby: Start game (Seat 1 only)
  socket.on('startGame', (data) => {
    const { startingPlayer } = data;

    if (!startingPlayer) {
      socket.emit('error', 'No starting player selected');
      return;
    }

    startGame(startingPlayer);
  });

  // Handle partial move for 7/9 cards (first part)
  socket.on('partialMove', (data) => {
    const { position, cardIndex, cardType, moveData } = data;

    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    console.log(`[partialMove] Attempt by ${position}, currentPlayer is ${currentPlayer}, cardType ${cardType}`);

    if (position !== currentPlayer) {
      console.log(`[partialMove] REJECTED - Not your turn. ${position} tried but it's ${currentPlayer}'s turn`);
      logTurnState('partialMove-rejected');
      socket.emit('error', 'Not your turn');
      return;
    }

    const player = gameState.players[position];
    if (!player || cardIndex < 0 || cardIndex >= player.hand.length) {
      socket.emit('error', 'Invalid card selection');
      return;
    }

    const marbleOwner = moveData.marbleOwner || position;

    if (!canControlMarble(position, marbleOwner)) {
      socket.emit('error', 'Cannot move that marble');
      return;
    }

    // Bug 1 Fix: If only 1 moveable marble for 7 card, must use all 7 spaces
    // Exception: If this move would finish the player, teammate's marbles become available
    if (cardType === 7) {
      const willFinishAfterMove = wouldBeFinishedAfterMove(marbleOwner, moveData.marbleId, moveData.enterHome);
      const moveableCount = countMoveableMarbles(position, willFinishAfterMove);
      if (moveableCount === 1 && moveData.spaces !== 7) {
        socket.emit('error', 'Only 1 marble can move - must use all 7 spaces');
        return;
      }
    }

    // Reset landing effects before processing
    currentMoveLandingEffects = [];
    const result = moveForward(marbleOwner, moveData, moveData.spaces);

    if (result.success) {
      const totalSpaces = cardType === 7 ? 7 : 9;
      const remainingSpaces = totalSpaces - moveData.spaces;

      // If used all spaces (for 7 card), complete immediately
      if (remainingSpaces === 0) {
        // Remove card from hand and add to player's discard pile
        const card = player.hand.splice(cardIndex, 1)[0];
        player.discardPile.push(card);
        addMoveToLog(position, card, 'played', currentMoveLandingEffects);
        dealCards(position, 1);

        // Clear any pending state
        gameState.pendingSplitMove = null;

        // Check win condition
        if (checkWinCondition(position)) {
          const team = getTeam(position);
          const teammate = getTeammate(position);
          
          if (checkWinCondition(teammate)) {
            io.emit('gameWon', { 
              winner: `${position} and ${teammate}`,
              team: team
            });
            return;
          }
        }

        nextTurn();
        io.emit('gameStateUpdate', gameState);
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
      
      io.emit('gameStateUpdate', gameState);
      socket.emit('partialMoveSuccess', { 
        remainingSpaces,
        cardType,
        playerFinished: isPlayerFinished(position)
      });
    } else {
      socket.emit('error', result.message);
    }
  });

  // Handle completing a split move (second part of 7/9)
  socket.on('completeSplitMove', (data) => {
    const { position, moveData } = data;

    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    console.log(`[completeSplitMove] Attempt by ${position}, currentPlayer is ${currentPlayer}`);

    if (position !== currentPlayer) {
      console.log(`[completeSplitMove] REJECTED - Not your turn. ${position} tried but it's ${currentPlayer}'s turn`);
      logTurnState('completeSplitMove-rejected');
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
    
    if (!canControlMarble(position, marbleOwner)) {
      socket.emit('error', 'Cannot move that marble');
      return;
    }
    
    // Prevent using the same marble for both parts
    const firstMarbleOwner = pending.firstMove.marbleOwner || position;
    if (marbleOwner === firstMarbleOwner && moveData.marbleId === pending.firstMove.marbleId) {
      socket.emit('error', 'Must use a different marble');
      return;
    }

    // Reset landing effects before processing second part
    currentMoveLandingEffects = [];
    let result;
    if (pending.cardType === 7) {
      result = moveForward(marbleOwner, moveData, pending.remainingSpaces);
    } else {
      result = moveBackwards(marbleOwner, moveData, pending.remainingSpaces);
    }

    if (result.success) {
      const card = player.hand.splice(pending.cardIndex, 1)[0];
      player.discardPile.push(card);
      addMoveToLog(position, card, 'played', currentMoveLandingEffects);
      dealCards(position, 1);
      
      gameState.pendingSplitMove = null;

      if (checkWinCondition(position)) {
        const team = getTeam(position);
        const teammate = getTeammate(position);
        
        if (checkWinCondition(teammate)) {
          io.emit('gameWon', { 
            winner: `${position} and ${teammate}`,
            team: team
          });
          return;
        }
      }

      nextTurn();
      io.emit('gameStateUpdate', gameState);
    } else {
      socket.emit('error', result.message);
    }
  });

  socket.on('playCard', (data) => {
    const { position, cardIndex, moveData } = data;

    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    console.log(`[playCard] Attempt by ${position}, currentPlayer is ${currentPlayer}, index ${gameState.currentPlayerIndex}`);

    if (position !== currentPlayer) {
      console.log(`[playCard] REJECTED - Not your turn. ${position} tried to play but it's ${currentPlayer}'s turn`);
      logTurnState('playCard-rejected');
      socket.emit('error', 'Not your turn');
      return;
    }

    // Clear any pending split move when playing a different card
    gameState.pendingSplitMove = null;

    const player = gameState.players[position];
    if (!player || cardIndex < 0 || cardIndex >= player.hand.length) {
      socket.emit('error', 'Invalid card selection');
      return;
    }

    const card = player.hand[cardIndex];
    console.log(`[playCard] ${position} playing ${card.value} of ${card.suit}`);

    // Reset landing effects before processing
    currentMoveLandingEffects = [];
    const result = processCardPlay(position, card, moveData);

    if (result.success) {
      player.hand.splice(cardIndex, 1);
      player.discardPile.push(card);
      addMoveToLog(position, card, 'played', currentMoveLandingEffects);
      dealCards(position, 1);

      if (checkWinCondition(position)) {
        const team = getTeam(position);
        const teammate = getTeammate(position);

        if (checkWinCondition(teammate)) {
          io.emit('gameWon', {
            winner: `${position} and ${teammate}`,
            team: team
          });
          return;
        }
      }

      nextTurn();
      logTurnState('playCard-afterTurn');
      io.emit('gameStateUpdate', gameState);
    } else {
      socket.emit('error', result.message);
    }
  });

  socket.on('discardCard', (data) => {
    const { position, cardIndex } = data;

    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    console.log(`[discardCard] Attempt by ${position}, currentPlayer is ${currentPlayer}`);

    if (position !== currentPlayer) {
      console.log(`[discardCard] REJECTED - Not your turn. ${position} tried but it's ${currentPlayer}'s turn`);
      logTurnState('discardCard-rejected');
      socket.emit('error', 'Not your turn');
      return;
    }

    const player = gameState.players[position];
    if (!player || cardIndex < 0 || cardIndex >= player.hand.length) {
      socket.emit('error', 'Invalid card');
      return;
    }

    // Check if player has any legal play - can only discard if no legal moves
    if (hasLegalPlay(position)) {
      console.log(`[discardCard] REJECTED - ${position} has a legal play available`);
      socket.emit('error', 'You have a legal play available - you must play a card');
      return;
    }

    const card = player.hand.splice(cardIndex, 1)[0];
    console.log(`[discardCard] ${position} discarding ${card.value} of ${card.suit} (no legal plays available)`);
    player.discardPile.push(card);
    addMoveToLog(position, card, 'discarded', []);
    dealCards(position, 1);

    gameState.pendingSplitMove = null;

    nextTurn();
    logTurnState('discardCard-afterTurn');
    io.emit('gameStateUpdate', gameState);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    for (let pos in gameState.players) {
      if (gameState.players[pos].socketId === socket.id) {
        const playerName = gameState.players[pos].name;

        // Mark as disconnected instead of removing
        gameState.players[pos].disconnected = true;

        console.log(`Player ${playerName} at ${pos} disconnected - waiting for reconnection...`);

        // Notify other players
        io.emit('playerDisconnected', { position: pos, playerName });

        // Set timeout to remove player if they don't reconnect (30 seconds)
        disconnectionTimeouts[pos] = setTimeout(() => {
          if (gameState.players[pos] && gameState.players[pos].disconnected) {
            console.log(`Player ${playerName} at ${pos} did not reconnect - removing from game`);

            delete gameState.players[pos];
            gameState.playerOrder = gameState.playerOrder.filter(p => p !== pos);
            delete disconnectionTimeouts[pos];

            io.emit('playerRemoved', { position: pos, playerName });
            io.emit('gameStateUpdate', gameState);
          }
        }, 30000); // 30 second grace period

        break;
      }
    }
  });
});

function processCardPlay(actingPlayer, card, moveData) {
  const cardValue = getCardValue(card);
  
  const marbleOwner = moveData.marbleOwner || actingPlayer;
  
  if (moveData.marbleId && !canControlMarble(actingPlayer, marbleOwner)) {
    return { success: false, message: 'Cannot move that marble' };
  }
  
  if (cardValue === 'face' || cardValue === 1) {
    if (moveData.action === 'enter') {
      return enterBoard(marbleOwner, moveData);
    } else {
      const spaces = cardValue === 'face' ? 10 : 1;
      return moveForward(marbleOwner, moveData, spaces);
    }
  }
  
  if (cardValue === 'joker') {
    return placeJoker(actingPlayer, marbleOwner, moveData);
  }
  
  if (cardValue === 7) {
    return move7(actingPlayer, moveData);
  }
  
  if (cardValue === 8) {
    return moveBackwards(marbleOwner, moveData, 8);
  }
  
  if (cardValue === 9) {
    return move9(actingPlayer, moveData);
  }
  
  return moveForward(marbleOwner, moveData, cardValue);
}

function enterBoard(player, moveData) {
  const { marbleId } = moveData;
  const marble = gameState.players[player].marbles[marbleId];

  if (marble.location !== 'start') {
    return { success: false, message: 'Marble not in start area' };
  }

  const entryPosition = gameState.board[player].trackEntry;

  const occupant = getMarbleOnTrack(entryPosition);
  if (occupant && occupant.player === player) {
    return { success: false, message: 'Cannot land on your own marble' };
  }

  // Check if landing on teammate is valid (their home entry must be available)
  const teammate = getTeammate(player);
  if (occupant && occupant.player === teammate && !canLandOnTeammate(teammate)) {
    return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
  }

  gameState.board[player].start[marble.position].marble = null;

  marble.location = 'track';
  marble.position = entryPosition;

  if (occupant) {
    handleLanding(player, occupant.player, occupant.marbleId);
  }

  return { success: true };
}

function moveForward(player, moveData, spaces) {
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
    
    if (isHomePathBlocked(player, currentHomePos, newHomePos)) {
      return { success: false, message: 'Path blocked by your own marble in home' };
    }

    // Use marble objects as source of truth instead of board state
    if (isHomePositionOccupied(player, newHomePos)) {
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
      !isHomePathBlockedFromStart(player, spacesIntoHome - 1) &&
      !isHomePositionOccupied(player, spacesIntoHome - 1);
    
    const trackDestination = (startPos + spaces) % 72;
    const canPassHome = !isPathBlockedIncludingHomeEntry(player, startPos, trackDestination, homeEntry) &&
      !(getMarbleOnTrack(trackDestination)?.player === player);
    
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
      const occupant = getMarbleOnTrack(trackDestination);
      // Check if landing on teammate is valid
      const teammate = getTeammate(player);
      if (occupant && occupant.player === teammate && !canLandOnTeammate(teammate)) {
        return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
      }
      marble.position = trackDestination;
      if (occupant && occupant.player !== player) {
        handleLanding(player, occupant.player, occupant.marbleId);
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
      const occupant = getMarbleOnTrack(trackDestination);
      // Check if landing on teammate is valid
      const teammate = getTeammate(player);
      if (occupant && occupant.player === teammate && !canLandOnTeammate(teammate)) {
        return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
      }
      marble.position = trackDestination;
      if (occupant && occupant.player !== player) {
        handleLanding(player, occupant.player, occupant.marbleId);
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

  if (isPathBlocked(player, startPos, newPosition, 'forward')) {
    return { success: false, message: 'Path blocked by your own marble' };
  }

  const occupant = getMarbleOnTrack(newPosition);
  if (occupant && occupant.player === player) {
    return { success: false, message: 'Cannot land on your own marble' };
  }

  // Check if landing on teammate is valid (their home entry must be available)
  const teammate = getTeammate(player);
  if (occupant && occupant.player === teammate && !canLandOnTeammate(teammate)) {
    return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
  }

  marble.position = newPosition;

  if (occupant) {
    handleLanding(player, occupant.player, occupant.marbleId);
  }
  
  return { success: true };
}

function moveBackwards(player, moveData, spaces) {
  const { marbleId } = moveData;
  const marble = gameState.players[player].marbles[marbleId];

  if (marble.location !== 'track') {
    return { success: false, message: 'Marble not on track' };
  }

  let newPosition = marble.position - spaces;
  if (newPosition < 0) newPosition += 72;

  if (isPathBlocked(player, marble.position, newPosition, 'backward')) {
    return { success: false, message: 'Path blocked by your own marble' };
  }

  const occupant = getMarbleOnTrack(newPosition);
  if (occupant && occupant.player === player) {
    return { success: false, message: 'Cannot land on your own marble' };
  }

  // Check if landing on teammate is valid (their home entry must be available)
  const teammate = getTeammate(player);
  if (occupant && occupant.player === teammate && !canLandOnTeammate(teammate)) {
    return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
  }

  marble.position = newPosition;

  if (occupant) {
    handleLanding(player, occupant.player, occupant.marbleId);
  }

  return { success: true };
}

function move7(actingPlayer, moveData) {
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
    if (!canControlMarble(actingPlayer, owner)) {
      return { success: false, message: 'Cannot move that marble' };
    }
    const result = moveForward(owner, { 
      marbleId: move.marbleId, 
      enterHome: move.enterHome 
    }, move.spaces);
    if (!result.success) {
      return result;
    }
  }
  
  return { success: true };
}

function move9(actingPlayer, moveData) {
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
  
  if (!canControlMarble(actingPlayer, forwardOwner)) {
    return { success: false, message: 'Cannot move that marble' };
  }
  if (!canControlMarble(actingPlayer, backwardOwner)) {
    return { success: false, message: 'Cannot move that marble' };
  }
  
  let result = moveForward(forwardOwner, { 
    marbleId: forward.marbleId,
    enterHome: forward.enterHome
  }, forward.spaces);
  if (!result.success) return result;
  
  result = moveBackwards(backwardOwner, { marbleId: backward.marbleId }, backward.spaces);
  if (!result.success) return result;
  
  return { success: true };
}

function placeJoker(actingPlayer, marbleOwner, moveData) {
  const { sourceMarbleId, targetPlayer, targetMarbleId } = moveData;
  const sourceMarble = gameState.players[marbleOwner].marbles[sourceMarbleId];
  const targetMarble = gameState.players[targetPlayer].marbles[targetMarbleId];

  if (sourceMarble.location !== 'track' && sourceMarble.location !== 'start') {
    return { success: false, message: 'Source marble must be on track or in start' };
  }

  if (targetMarble.location !== 'track') {
    return { success: false, message: 'Target marble must be on track' };
  }

  // Bug 2 Fix: Cannot joker onto your own marble
  if (marbleOwner === targetPlayer) {
    return { success: false, message: 'Cannot joker onto your own marble' };
  }

  // Check if landing on teammate is valid (their home entry must be available)
  const teammate = getTeammate(marbleOwner);
  if (targetPlayer === teammate && !canLandOnTeammate(teammate)) {
    return { success: false, message: 'Cannot land on teammate - their home entry is blocked by their own marble' };
  }

  if (sourceMarble.location === 'start') {
    gameState.board[marbleOwner].start[sourceMarble.position].marble = null;
  }

  const targetPosition = targetMarble.position;
  sourceMarble.location = 'track';
  sourceMarble.position = targetPosition;

  handleLanding(marbleOwner, targetPlayer, targetMarbleId);

  return { success: true };
}

function handleLanding(landingPlayer, targetPlayer, targetMarbleId) {
  const targetMarble = gameState.players[targetPlayer].marbles[targetMarbleId];
  const teammate = getTeammate(landingPlayer);

  if (targetPlayer === teammate) {
    // Send teammate to home entry
    const homeEntry = gameState.board[targetPlayer].homeEntry;

    // Check if there's already a marble at the home entry (for chain reactions)
    const occupant = getMarbleOnTrack(homeEntry);

    targetMarble.position = homeEntry;
    currentMoveLandingEffects.push({ targetPlayer, type: 'teammate' });

    // If there's an occupant at the home entry, trigger chain reaction
    if (occupant) {
      handleLanding(targetPlayer, occupant.player, occupant.marbleId);
    }
  } else {
    // Send enemy back to start
    const startIndex = parseInt(targetMarbleId.replace('marble', ''));
    targetMarble.location = 'start';
    targetMarble.position = startIndex;
    gameState.board[targetPlayer].start[startIndex].marble = targetPlayer;
    currentMoveLandingEffects.push({ targetPlayer, type: 'enemy' });
  }
}

function checkWinCondition(player) {
  const teammate = getTeammate(player);
  return isPlayerFinished(player) && isPlayerFinished(teammate);
}

function getTeam(player) {
  if (gameState.teams.team1.includes(player)) return 'team1';
  return 'team2';
}

function nextTurn() {
  // Clear any pending split move when turn changes
  gameState.pendingSplitMove = null;
  const previousIndex = gameState.currentPlayerIndex;
  const previousPlayer = gameState.playerOrder[previousIndex];
  gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % 4;
  const newPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
  console.log(`[TURN] Turn changed: ${previousPlayer} (index ${previousIndex}) -> ${newPlayer} (index ${gameState.currentPlayerIndex})`);
}

function logTurnState(context) {
  const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
  const currentPlayerName = gameState.players[currentPlayer]?.name || 'Unknown';
  console.log(`[DEBUG ${context}] Current turn: ${currentPlayer} (${currentPlayerName}), index: ${gameState.currentPlayerIndex}, playerOrder: ${gameState.playerOrder.join(', ')}`);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
