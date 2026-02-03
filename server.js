const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

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
  pendingSplitMove: null
};

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
function countMoveableMarbles(actingPlayer) {
  let count = 0;
  
  // Check own marbles
  for (let marbleId in gameState.players[actingPlayer].marbles) {
    const marble = gameState.players[actingPlayer].marbles[marbleId];
    if (marble.location === 'track' || marble.location === 'home') {
      count++;
    }
  }
  
  // Check teammate's marbles if finished
  if (isPlayerFinished(actingPlayer)) {
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

function isHomePathBlocked(player, startHomePos, endHomePos) {
  for (let i = startHomePos + 1; i < endHomePos; i++) {
    if (gameState.board[player].home[i].marble !== null) {
      return true;
    }
  }
  return false;
}

function isHomePathBlockedFromStart(player, targetHomeIndex) {
  for (let i = 0; i < targetHomeIndex; i++) {
    if (gameState.board[player].home[i].marble !== null) {
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

  socket.on('joinGame', (data) => {
    const { playerName, position } = data;
    
    if (gameState.players[position]) {
      socket.emit('joinError', 'Position already taken');
      return;
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
      discardPile: [] // Per-player discard pile
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
    if (position !== currentPlayer) {
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
    if (cardType === 7) {
      const moveableCount = countMoveableMarbles(position);
      if (moveableCount === 1 && moveData.spaces !== 7) {
        socket.emit('error', 'Only 1 marble can move - must use all 7 spaces');
        return;
      }
    }

    const result = moveForward(marbleOwner, moveData, moveData.spaces);
    
    if (result.success) {
      const totalSpaces = cardType === 7 ? 7 : 9;
      const remainingSpaces = totalSpaces - moveData.spaces;
      
      // If used all spaces (for 7 card), complete immediately
      if (remainingSpaces === 0) {
        // Remove card from hand and add to player's discard pile
        const card = player.hand.splice(cardIndex, 1)[0];
        player.discardPile.push(card);
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
    if (position !== currentPlayer) {
      socket.emit('error', 'Not your turn');
      return;
    }

    if (!gameState.pendingSplitMove || gameState.pendingSplitMove.player !== position) {
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

    let result;
    if (pending.cardType === 7) {
      result = moveForward(marbleOwner, moveData, pending.remainingSpaces);
    } else {
      result = moveBackwards(marbleOwner, moveData, pending.remainingSpaces);
    }

    if (result.success) {
      const card = player.hand.splice(pending.cardIndex, 1)[0];
      player.discardPile.push(card);
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
    if (position !== currentPlayer) {
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
    const result = processCardPlay(position, card, moveData);

    if (result.success) {
      player.hand.splice(cardIndex, 1);
      player.discardPile.push(card);
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
      io.emit('gameStateUpdate', gameState);
    } else {
      socket.emit('error', result.message);
    }
  });

  socket.on('discardCard', (data) => {
    const { position, cardIndex } = data;
    
    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    if (position !== currentPlayer) {
      socket.emit('error', 'Not your turn');
      return;
    }

    const player = gameState.players[position];
    if (!player || cardIndex < 0 || cardIndex >= player.hand.length) {
      socket.emit('error', 'Invalid card');
      return;
    }

    const card = player.hand.splice(cardIndex, 1)[0];
    player.discardPile.push(card);
    dealCards(position, 1);
    
    gameState.pendingSplitMove = null;
    
    nextTurn();
    io.emit('gameStateUpdate', gameState);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (let pos in gameState.players) {
      if (gameState.players[pos].socketId === socket.id) {
        delete gameState.players[pos];
        gameState.playerOrder = gameState.playerOrder.filter(p => p !== pos);
        break;
      }
    }
    io.emit('gameStateUpdate', gameState);
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
    
    if (gameState.board[player].home[newHomePos].marble !== null) {
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
      gameState.board[player].home[spacesIntoHome - 1].marble === null;
    
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
      marble.position = trackDestination;
      const occupant = getMarbleOnTrack(trackDestination);
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
      marble.position = trackDestination;
      const occupant = getMarbleOnTrack(trackDestination);
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
    const homeEntry = gameState.board[targetPlayer].homeEntry;
    targetMarble.position = homeEntry;
  } else {
    const startIndex = parseInt(targetMarbleId.replace('marble', ''));
    targetMarble.location = 'start';
    targetMarble.position = startIndex;
    gameState.board[targetPlayer].start[startIndex].marble = targetPlayer;
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
  gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % 4;
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
