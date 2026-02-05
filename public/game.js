const socket = io();

let gameState = null;
let myPosition = null;
let selectedCard = null;
let selectedMarbles = [];

// State for 7 and 9 card split moves
let splitMoveState = null;

// State for home choice on regular cards
let homeChoiceState = null;

// State for distance counting
let distanceCountState = {
    active: false,
    startPos: null,
    startType: null, // 'track' or 'home'
    startPlayer: null, // player position for home spaces
    currentPos: null,
    currentType: null,
    currentPlayer: null
};

// DOM Elements
const passwordScreen = document.getElementById('passwordScreen');
const loginScreen = document.getElementById('loginScreen');
const waitingScreen = document.getElementById('waitingScreen');
const lobbyScreen = document.getElementById('lobbyScreen');
const gameScreen = document.getElementById('gameScreen');
const winScreen = document.getElementById('winScreen');
const gamePasswordInput = document.getElementById('gamePassword');
const passwordSubmitBtn = document.getElementById('passwordSubmitBtn');
const passwordError = document.getElementById('passwordError');
const playerNameInput = document.getElementById('playerName');
const positionButtons = document.querySelectorAll('.position-btn');
const loginError = document.getElementById('loginError');
const gameBoard = document.getElementById('gameBoard');
const playerHand = document.getElementById('playerHand');
const discardBtn = document.getElementById('discardBtn');

// Lobby elements
const lobbyControls = document.getElementById('lobbyControls');
const lobbyWaiting = document.getElementById('lobbyWaiting');
const startPlayerButtons = document.querySelectorAll('.start-player-btn');
const randomizeStartBtn = document.getElementById('randomizeStartBtn');
const beginGameBtn = document.getElementById('beginGameBtn');
let selectedStartingPlayer = null;

// Moves log elements
const movesLogToggle = document.getElementById('movesLogToggle');
const movesLogPanel = document.getElementById('movesLogPanel');

// Toggle moves log panel
if (movesLogToggle && movesLogPanel) {
    movesLogToggle.addEventListener('click', () => {
        movesLogPanel.classList.toggle('visible');
    });
}

// Password submission
passwordSubmitBtn.addEventListener('click', () => {
    const password = gamePasswordInput.value.trim();
    if (!password) {
        passwordError.textContent = 'Please enter a password';
        return;
    }
    socket.emit('checkPassword', { password });
});

gamePasswordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        passwordSubmitBtn.click();
    }
});

// Socket event listeners
socket.on('passwordCorrect', () => {
    localStorage.setItem('gameAuthenticated', 'true');
    showScreen('loginScreen');
});

socket.on('passwordIncorrect', () => {
    passwordError.textContent = 'Incorrect password';
    gamePasswordInput.value = '';
});

socket.on('joinSuccess', (data) => {
    myPosition = data.position;
    gameState = data.gameState;
    showScreen('waitingScreen');
    updateWaitingRoom();
});

socket.on('joinError', (message) => {
    loginError.textContent = message;
});

socket.on('lobbyReady', (state) => {
    gameState = state;
    showScreen('lobbyScreen');
    updateLobbyDisplay();
});

socket.on('waitingRoomUpdate', (state) => {
    gameState = state;
    updateWaitingRoom();
});

socket.on('startingPlayerSelected', (data) => {
    const { startingPlayer } = data;
    selectedStartingPlayer = startingPlayer;
    updateStartingPlayerDisplay(startingPlayer);
});

socket.on('gameStarted', (state) => {
    gameState = state;
    // Clear all local state on game start
    splitMoveState = null;
    homeChoiceState = null;
    selectedCard = null;
    selectedMarbles = [];
    selectedStartingPlayer = null;
    showScreen('gameScreen');
    renderGame();
});

socket.on('gameStateUpdate', (state) => {
    const previousIndex = gameState ? gameState.currentPlayerIndex : null;
    const previousPlayer = gameState ? gameState.playerOrder[gameState.currentPlayerIndex] : null;
    gameState = state;
    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    const isMyTurn = currentPlayer === myPosition;

    console.log(`[CLIENT gameStateUpdate] Turn: ${currentPlayer} (index ${gameState.currentPlayerIndex}), myPosition: ${myPosition}, isMyTurn: ${isMyTurn}`);

    if (previousPlayer !== currentPlayer) {
        console.log(`[CLIENT] Turn changed: ${previousPlayer} (index ${previousIndex}) -> ${currentPlayer} (index ${gameState.currentPlayerIndex})`);
    }

    // If turn changed, clear all local state
    if (previousPlayer !== currentPlayer) {
        splitMoveState = null;
        homeChoiceState = null;
        selectedCard = null;
        selectedMarbles = [];
        const instructionEl = document.getElementById('cardInstruction');
        if (instructionEl) {
            instructionEl.textContent = '';
        }
    }

    renderGame();
});

socket.on('partialMoveSuccess', (data) => {
    const { remainingSpaces, cardType, playerFinished } = data;
    
    splitMoveState = {
        ...splitMoveState,
        awaitingDestination: false,
        awaitingSecondMarble: true,
        remainingSpaces: remainingSpaces,
        playerFinished: playerFinished
    };
    
    const direction = cardType === 7 ? 'forward' : 'BACKWARD';
    document.getElementById('cardInstruction').textContent = 
        `${cardType}: Now click a DIFFERENT marble to move ${remainingSpaces} spaces ${direction}`;
    
    renderGame();
});

socket.on('splitMoveComplete', () => {
    // Split move completed with full spaces (e.g., 7 card with 7 spaces)
    splitMoveState = null;
    selectedCard = null;
    const instructionEl = document.getElementById('cardInstruction');
    if (instructionEl) {
        instructionEl.textContent = '';
    }
});

socket.on('gameWon', (data) => {
    document.getElementById('winnerText').textContent = 
        `${data.winner} wins! ${data.team === 'team1' ? 'Team 1 (Seats 1 & 3)' : 'Team 2 (Seats 2 & 4)'} is victorious!`;
    showScreen('winScreen');
});

socket.on('error', (message) => {
    alert(message);
    // Don't clear split state on error - let user try again
    renderGame();
});

socket.on('playerDisconnected', (data) => {
    const { position, playerName } = data;
    showNotification(`${playerName} (${position}) disconnected. Waiting for reconnection...`, 'warning');
});

socket.on('playerReconnected', (data) => {
    const { position, playerName } = data;
    showNotification(`${playerName} (${position}) reconnected!`, 'success');
});

socket.on('playerRemoved', (data) => {
    const { position, playerName } = data;
    showNotification(`${playerName} (${position}) did not reconnect and was removed from the game.`, 'error');
});

// Position selection
positionButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const position = btn.dataset.position;
        const name = playerNameInput.value.trim();
        
        if (!name) {
            loginError.textContent = 'Please enter your name';
            return;
        }
        
        socket.emit('joinGame', { playerName: name, position });
    });
});

// Discard button
discardBtn.addEventListener('click', () => {
    if (selectedCard !== null) {
        socket.emit('discardCard', { position: myPosition, cardIndex: selectedCard });
        selectedCard = null;
        splitMoveState = null;
        homeChoiceState = null;

        const instructionEl = document.getElementById('cardInstruction');
        if (instructionEl) {
            instructionEl.textContent = '';
        }
    }
});

// Lobby: Starting player selection buttons
startPlayerButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const position = btn.dataset.position;
        selectStartingPlayer(position);
    });
});

// Lobby: Randomize button
randomizeStartBtn.addEventListener('click', () => {
    const positions = ['Seat1', 'Seat2', 'Seat3', 'Seat4'];
    const randomPosition = positions[Math.floor(Math.random() * positions.length)];
    selectStartingPlayer(randomPosition);
});

// Lobby: Begin game button
beginGameBtn.addEventListener('click', () => {
    if (selectedStartingPlayer) {
        socket.emit('startGame', { startingPlayer: selectedStartingPlayer });
    }
});

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function updateSeatIndicator() {
    const seatIndicator = document.getElementById('seatIndicator');
    if (seatIndicator && myPosition) {
        seatIndicator.textContent = `You are ${myPosition.replace('Seat', 'Seat ')}`;
    }
}

function updateLobbyDisplay() {
    if (!gameState) return;

    // Update player names in lobby
    for (let i = 1; i <= 4; i++) {
        const position = `Seat${i}`;
        const playerEl = document.getElementById(`lobbyPlayer${i}`);
        if (playerEl) {
            playerEl.textContent = gameState.players[position]?.name || 'Waiting...';
        }
    }

    // Show controls only for Seat 1, waiting message for others
    if (myPosition === 'Seat1') {
        lobbyControls.style.display = 'block';
        lobbyWaiting.style.display = 'none';
    } else {
        lobbyControls.style.display = 'none';
        lobbyWaiting.style.display = 'block';
    }
}

function updateWaitingRoom() {
    if (!gameState) return;

    let playerCount = 0;
    const playerColors = {
        Seat1: '#2196F3',
        Seat2: '#F44336',
        Seat3: '#9C27B0',
        Seat4: '#FF9800'
    };

    // Update player names in waiting room
    for (let i = 1; i <= 4; i++) {
        const position = `Seat${i}`;
        const playerEl = document.getElementById(`waitingPlayer${i}`);
        if (playerEl) {
            const playerName = gameState.players[position]?.name;
            if (playerName) {
                playerEl.textContent = playerName;
                playerEl.style.color = playerColors[position];
                playerEl.style.fontWeight = 'bold';
                playerCount++;
            } else {
                playerEl.textContent = 'Empty';
                playerEl.style.color = '#888';
                playerEl.style.fontWeight = 'normal';
            }
        }
    }

    // Update status text
    const statusEl = document.getElementById('waitingStatus');
    if (statusEl) {
        statusEl.textContent = `${playerCount} of 4 players joined`;
    }
}

function selectStartingPlayer(position) {
    selectedStartingPlayer = position;

    // Update button styles
    startPlayerButtons.forEach(btn => {
        if (btn.dataset.position === position) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });

    // Update selected player display
    document.getElementById('selectedStartPlayer').textContent =
        `${position.replace('Seat', 'Seat ')} (${gameState.players[position]?.name || 'Unknown'})`;

    // Enable start button
    beginGameBtn.disabled = false;

    // Notify other players
    socket.emit('selectStartingPlayer', { startingPlayer: position });
}

function updateStartingPlayerDisplay(startingPlayer) {
    const displayText = `${startingPlayer.replace('Seat', 'Seat ')} (${gameState.players[startingPlayer]?.name || 'Unknown'})`;

    // Update for Seat 1 (in controls)
    const selectedStartEl = document.getElementById('selectedStartPlayer');
    if (selectedStartEl) {
        selectedStartEl.textContent = displayText;
    }

    // Update for other players (in waiting area)
    const waitingStartEl = document.getElementById('waitingStartPlayer');
    if (waitingStartEl) {
        waitingStartEl.textContent = displayText;
    }

    // Update button styles for all players
    startPlayerButtons.forEach(btn => {
        if (btn.dataset.position === startingPlayer) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });
}

function renderGame() {
    if (!gameState || !gameState.gameStarted) return;

    renderBoard();
    renderHand();
    renderGameInfo();
    renderMovesLog();
    renderDebugPanel();
}

function renderDebugPanel() {
    const debugContent = document.getElementById('debugContent');
    if (!debugContent || !gameState) return;

    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    const currentPlayerName = gameState.players[currentPlayer]?.name || currentPlayer;
    const isMyTurn = currentPlayer === myPosition;
    const myName = gameState.players[myPosition]?.name || myPosition;

    const turnClass = isMyTurn ? 'debug-my-turn' : 'debug-not-my-turn';

    debugContent.innerHTML = `
        <div>My Position: <strong>${myPosition}</strong> (${myName})</div>
        <div>Current Turn: <strong>${currentPlayer}</strong> (${currentPlayerName})</div>
        <div>Turn Index: <strong>${gameState.currentPlayerIndex}</strong></div>
        <div class="${turnClass}">Is My Turn: <strong>${isMyTurn ? 'YES' : 'NO'}</strong></div>
        <div>Order: ${gameState.playerOrder.join(' → ')}</div>
        <div>Split State: ${splitMoveState ? JSON.stringify({
            awaiting: splitMoveState.awaitingDestination ? 'dest' : (splitMoveState.awaitingSecondMarble ? '2nd marble' : 'none'),
            cardType: splitMoveState.cardType
        }) : 'null'}</div>
    `;
}

function isPlayerFinished(player) {
    if (!gameState.players[player]) return false;
    let inHome = 0;
    for (let marbleId in gameState.players[player].marbles) {
        if (gameState.players[player].marbles[marbleId].location === 'home') {
            inHome++;
        }
    }
    return inHome === 5;
}

function getTeammate(player) {
    if (gameState.teams.team1.includes(player)) {
        return gameState.teams.team1.find(p => p !== player);
    } else {
        return gameState.teams.team2.find(p => p !== player);
    }
}

function canControlMarble(marbleOwner) {
    if (myPosition === marbleOwner) return true;
    if (splitMoveState && splitMoveState.playerFinished && getTeammate(myPosition) === marbleOwner) {
        return true;
    }
    if (isPlayerFinished(myPosition) && getTeammate(myPosition) === marbleOwner) return true;
    return false;
}

// Count marbles that can be moved (on track or in home with room)
function countMoveableMarbles() {
    let count = 0;
    let marbles = [];
    
    // Check own marbles
    for (let marbleId in gameState.players[myPosition].marbles) {
        const marble = gameState.players[myPosition].marbles[marbleId];
        if (marble.location === 'track' || (marble.location === 'home' && marble.position < 4)) {
            count++;
            marbles.push({ owner: myPosition, marbleId, location: marble.location });
        }
    }
    
    // Check teammate's marbles if finished
    if (isPlayerFinished(myPosition)) {
        const teammate = getTeammate(myPosition);
        for (let marbleId in gameState.players[teammate].marbles) {
            const marble = gameState.players[teammate].marbles[marbleId];
            if (marble.location === 'track' || (marble.location === 'home' && marble.position < 4)) {
                count++;
                marbles.push({ owner: teammate, marbleId, location: marble.location });
            }
        }
    }
    
    return { count, marbles };
}

// Count marbles on track only (for backward moves)
function countMarblesOnTrack() {
    let count = 0;
    
    for (let marbleId in gameState.players[myPosition].marbles) {
        const marble = gameState.players[myPosition].marbles[marbleId];
        if (marble.location === 'track') {
            count++;
        }
    }
    
    if (isPlayerFinished(myPosition)) {
        const teammate = getTeammate(myPosition);
        for (let marbleId in gameState.players[teammate].marbles) {
            const marble = gameState.players[teammate].marbles[marbleId];
            if (marble.location === 'track') {
                count++;
            }
        }
    }
    
    return count;
}

// Check if player has enough marbles for a 9 card
// Need at least 1 marble that can move forward and 1 different marble on track for backward
function canPlay9Card() {
    const { marbles } = countMoveableMarbles();
    const trackMarbles = marbles.filter(m => m.location === 'track');

    // Check if player has 4 marbles in home (could finish with first move and use teammate's marble)
    let inHome = 0;
    for (let marbleId in gameState.players[myPosition].marbles) {
        if (gameState.players[myPosition].marbles[marbleId].location === 'home') {
            inHome++;
        }
    }

    // If player has 4 in home and 1 marble that could move forward, AND teammate has track marbles
    if (inHome === 4 && marbles.length >= 1) {
        const teammate = getTeammate(myPosition);
        let teammateTrackMarbles = 0;
        for (let marbleId in gameState.players[teammate].marbles) {
            if (gameState.players[teammate].marbles[marbleId].location === 'track') {
                teammateTrackMarbles++;
            }
        }
        if (teammateTrackMarbles > 0) {
            return true; // Can finish with first move, then use teammate's marble for backward
        }
    }

    // Need at least 2 marbles total, and at least 1 on track for backward move
    if (marbles.length < 2 || trackMarbles.length < 1) {
        return false;
    }

    // We need at least 1 for forward and 1 different for backward
    if (marbles.length >= 2) {
        return true;
    }

    return false;
}

function getRotationOffset() {
    if (!myPosition) return 0;
    
    const seatRotations = {
        'Seat1': 0,
        'Seat2': -90,
        'Seat3': 180,
        'Seat4': 90
    };
    
    return seatRotations[myPosition] || 0;
}

function getSquarePosition(trackPos, centerX, centerY, squareSize, rotationDeg) {
    const halfSize = squareSize / 2;
    const spacing = squareSize / 18;
    
    let x, y;
    let normalizedPos = (trackPos - 64 + 72) % 72;
    
    if (normalizedPos < 18) {
        x = halfSize - (normalizedPos * spacing);
        y = halfSize;
    } else if (normalizedPos < 36) {
        const edgePos = normalizedPos - 18;
        x = -halfSize;
        y = halfSize - (edgePos * spacing);
    } else if (normalizedPos < 54) {
        const edgePos = normalizedPos - 36;
        x = -halfSize + (edgePos * spacing);
        y = -halfSize;
    } else {
        const edgePos = normalizedPos - 54;
        x = halfSize;
        y = -halfSize + (edgePos * spacing);
    }
    
    const rotationRad = (rotationDeg * Math.PI) / 180;
    const rotatedX = x * Math.cos(rotationRad) - y * Math.sin(rotationRad);
    const rotatedY = x * Math.sin(rotationRad) + y * Math.cos(rotationRad);
    
    return {
        x: centerX + rotatedX,
        y: centerY + rotatedY
    };
}

function getPerpendicularInward(trackPos, rotationDeg) {
    let normalizedPos = (trackPos - 64 + 72) % 72;
    
    let baseDir;
    if (normalizedPos < 18) {
        baseDir = { x: 0, y: -1 };
    } else if (normalizedPos < 36) {
        baseDir = { x: 1, y: 0 };
    } else if (normalizedPos < 54) {
        baseDir = { x: 0, y: 1 };
    } else {
        baseDir = { x: -1, y: 0 };
    }
    
    const rotationRad = (rotationDeg * Math.PI) / 180;
    return {
        x: baseDir.x * Math.cos(rotationRad) - baseDir.y * Math.sin(rotationRad),
        y: baseDir.x * Math.sin(rotationRad) + baseDir.y * Math.cos(rotationRad)
    };
}

function getLeftDirection(inwardDir) {
    return { x: inwardDir.y, y: -inwardDir.x };
}

function getMarbleIdAtHomePosition(player, homeIndex) {
    const marbles = gameState.players[player].marbles;
    for (let marbleId in marbles) {
        if (marbles[marbleId].location === 'home' && marbles[marbleId].position === homeIndex) {
            return marbleId;
        }
    }
    return null;
}

function getSpacesToPosition(start, target) {
    let spaces = 0;
    let current = start;
    while (current !== target && spaces < 72) {
        spaces++;
        current = (current + 1) % 72;
    }
    return spaces;
}

function getMarbleOnTrack(trackPosition) {
    for (let player of gameState.playerOrder) {
        const marbles = gameState.players[player].marbles;
        for (let marbleId in marbles) {
            if (marbles[marbleId].location === 'track' && marbles[marbleId].position === trackPosition) {
                return { player, marbleId };
            }
        }
    }
    return null;
}

function isPathBlocked(marbleOwner, startPos, endPos, direction = 'forward') {
    if (direction === 'forward') {
        let current = (startPos + 1) % 72;
        while (current !== endPos) {
            const occupant = getMarbleOnTrack(current);
            if (occupant && occupant.player === marbleOwner) {
                return true;
            }
            current = (current + 1) % 72;
        }
    } else {
        let current = startPos - 1;
        if (current < 0) current += 72;
        while (current !== endPos) {
            const occupant = getMarbleOnTrack(current);
            if (occupant && occupant.player === marbleOwner) {
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

function getValidDestinations(marbleOwner, marbleId, maxSpaces, direction = 'forward') {
    const marble = gameState.players[marbleOwner].marbles[marbleId];
    if (!marble) return [];
    
    const validPositions = [];
    const homeEntry = gameState.board[marbleOwner].homeEntry;
    
    if (marble.location === 'home') {
        const currentHomePos = marble.position;
        for (let spaces = 1; spaces <= maxSpaces; spaces++) {
            const newHomePos = currentHomePos + spaces;
            if (newHomePos > 4) continue;
            
            let blocked = false;
            for (let i = currentHomePos + 1; i < newHomePos; i++) {
                if (gameState.board[marbleOwner].home[i].marble !== null) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) continue;
            
            if (gameState.board[marbleOwner].home[newHomePos].marble !== null) continue;
            
            validPositions.push({ 
                type: 'home', 
                spaces: spaces, 
                homeIndex: newHomePos,
                enterHome: true,
                marbleOwner: marbleOwner
            });
        }
        return validPositions;
    }
    
    if (marble.location !== 'track') return [];
    
    const startPos = marble.position;
    
    for (let spaces = 1; spaces <= maxSpaces; spaces++) {
        if (direction === 'forward') {
            const trackDest = (startPos + spaces) % 72;
            
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
                
                if (spacesIntoHome > 0 && spacesIntoHome <= 5) {
                    const homeIndex = spacesIntoHome - 1;
                    if (!isHomePathBlockedFromStart(marbleOwner, homeIndex) && 
                        gameState.board[marbleOwner].home[homeIndex].marble === null) {
                        validPositions.push({ 
                            type: 'home', 
                            spaces: spaces, 
                            homeIndex: homeIndex,
                            enterHome: true,
                            marbleOwner: marbleOwner
                        });
                    }
                }
                
                let pathBlocked = false;
                let current = (startPos + 1) % 72;
                while (current !== trackDest) {
                    if (current !== homeEntry) {
                        const occupant = getMarbleOnTrack(current);
                        if (occupant && occupant.player === marbleOwner) {
                            pathBlocked = true;
                            break;
                        }
                    }
                    current = (current + 1) % 72;
                }
                
                if (!pathBlocked) {
                    const destOccupant = getMarbleOnTrack(trackDest);
                    if (!destOccupant || destOccupant.player !== marbleOwner) {
                        validPositions.push({ 
                            type: 'track', 
                            spaces: spaces, 
                            position: trackDest,
                            enterHome: false,
                            marbleOwner: marbleOwner
                        });
                    }
                }
            } else {
                if (!isPathBlocked(marbleOwner, startPos, trackDest, 'forward')) {
                    const destOccupant = getMarbleOnTrack(trackDest);
                    if (!destOccupant || destOccupant.player !== marbleOwner) {
                        validPositions.push({ 
                            type: 'track', 
                            spaces: spaces, 
                            position: trackDest,
                            enterHome: false,
                            marbleOwner: marbleOwner
                        });
                    }
                }
            }
        } else {
            let targetPos = startPos - spaces;
            if (targetPos < 0) targetPos += 72;
            
            if (!isPathBlocked(marbleOwner, startPos, targetPos, 'backward')) {
                const destOccupant = getMarbleOnTrack(targetPos);
                if (!destOccupant || destOccupant.player !== marbleOwner) {
                    validPositions.push({ 
                        type: 'track', 
                        spaces: spaces, 
                        position: targetPos,
                        enterHome: false,
                        marbleOwner: marbleOwner
                    });
                }
            }
        }
    }
    
    return validPositions;
}

// Bug 4 Fix: Check if a 9-card split can be completed
function canComplete9CardSplit(firstMarbleOwner, firstMarbleId, firstSpaces) {
    const remainingSpaces = 9 - firstSpaces;
    const firstMarble = gameState.players[firstMarbleOwner].marbles[firstMarbleId];

    // Calculate where the first marble will be after moving
    let firstMarbleNewPosition;
    let firstMarbleNewLocation;

    // Check if first marble would enter home using getValidDestinations
    const firstMarbleDestinations = getValidDestinations(firstMarbleOwner, firstMarbleId, firstSpaces, 'forward');
    const firstMarbleDest = firstMarbleDestinations.find(d => d.spaces === firstSpaces);

    if (!firstMarbleDest) {
        return false; // First move isn't even valid
    }

    if (firstMarbleDest.type === 'home') {
        // First marble enters home, so it won't block track
        firstMarbleNewLocation = 'home';
        firstMarbleNewPosition = null;
    } else if (firstMarble.location === 'track') {
        firstMarbleNewLocation = 'track';
        firstMarbleNewPosition = firstMarbleDest.position;
    } else if (firstMarble.location === 'home') {
        // If moving within home, it won't block backward track moves
        firstMarbleNewLocation = 'home';
        firstMarbleNewPosition = null;
    } else {
        return false;
    }

    // Check all controllable marbles ON TRACK (backward move requires track)
    const marblesToCheck = [];

    // Own marbles on track
    for (let marbleId in gameState.players[myPosition].marbles) {
        const marble = gameState.players[myPosition].marbles[marbleId];
        if (marble.location === 'track') {
            marblesToCheck.push({ owner: myPosition, id: marbleId });
        }
    }

    // Teammate's marbles on track if finished or will finish after this move
    // We need to simulate: after first marble moves, will the player be finished?
    let willFinishAfterMove = false;
    if (firstMarbleNewLocation === 'home') {
        // Count how many marbles will be in home after this move
        let homeCount = 0;
        for (let marbleId in gameState.players[firstMarbleOwner].marbles) {
            const marble = gameState.players[firstMarbleOwner].marbles[marbleId];
            if (marble.location === 'home') {
                homeCount++;
            } else if (marbleId === firstMarbleId && firstMarbleNewLocation === 'home') {
                homeCount++; // This marble will move into home
            }
        }
        willFinishAfterMove = (homeCount === 5);
    }

    if (isPlayerFinished(myPosition) || willFinishAfterMove) {
        const teammate = getTeammate(myPosition);
        for (let marbleId in gameState.players[teammate].marbles) {
            const marble = gameState.players[teammate].marbles[marbleId];
            if (marble.location === 'track') {
                marblesToCheck.push({ owner: teammate, id: marbleId });
            }
        }
    }

    // Check if ANY marble (other than first) can move backward remaining spaces
    for (let marble of marblesToCheck) {
        // Skip the first marble
        if (marble.owner === firstMarbleOwner && marble.id === firstMarbleId) {
            continue;
        }

        const secondMarble = gameState.players[marble.owner].marbles[marble.id];
        const startPos = secondMarble.position;
        let targetPos = startPos - remainingSpaces;
        if (targetPos < 0) targetPos += 72;

        // Check if the backward path would be blocked by the first marble's NEW position
        let pathBlocked = false;
        let current = startPos - 1;
        if (current < 0) current += 72;

        while (current !== targetPos) {
            // Check if this position would be blocked
            const occupant = getMarbleOnTrack(current);

            // If first marble will be at this position, it's blocked
            if (current === firstMarbleNewPosition) {
                pathBlocked = true;
                break;
            }

            // If another marble is here (and it's not the first marble's current position), it's blocked
            if (occupant && !(occupant.player === firstMarbleOwner && occupant.marbleId === firstMarbleId)) {
                if (occupant.player === marble.owner) {
                    pathBlocked = true;
                    break;
                }
            }

            current = current - 1;
            if (current < 0) current += 72;
        }

        if (pathBlocked) {
            continue;
        }

        // Check destination isn't blocked (excluding first marble's current position)
        const destOccupant = getMarbleOnTrack(targetPos);
        if (destOccupant && !(destOccupant.player === firstMarbleOwner && destOccupant.marbleId === firstMarbleId)) {
            if (destOccupant.player === marble.owner) {
                continue;
            }
        }

        // Also check if destination would be the first marble's new position
        if (targetPos === firstMarbleNewPosition) {
            continue;
        }

        // This marble can complete the backward move!
        return true;
    }

    return false;
}

// Bug 3 Fix: Check if a 7-card split can be completed (with future state simulation)
function canComplete7CardSplit(firstMarbleOwner, firstMarbleId, firstSpaces) {
    const remainingSpaces = 7 - firstSpaces;
    if (remainingSpaces === 0) return true; // Used all 7 on first marble

    // Calculate where the first marble will be after moving
    let firstMarbleNewLocation;
    let firstMarbleNewPosition;

    // Need to determine if first move lands on track or in home
    // This is complex, so we'll check based on the getValidDestinations result
    const firstMarbleDestinations = getValidDestinations(firstMarbleOwner, firstMarbleId, firstSpaces, 'forward');
    const firstMarbleDest = firstMarbleDestinations.find(d => d.spaces === firstSpaces);

    if (!firstMarbleDest) {
        return false; // First move isn't even valid
    }

    if (firstMarbleDest.type === 'home') {
        firstMarbleNewLocation = 'home';
        firstMarbleNewPosition = firstMarbleDest.homeIndex;
    } else {
        firstMarbleNewLocation = 'track';
        firstMarbleNewPosition = firstMarbleDest.position;
    }

    // Check all controllable marbles
    const marblesToCheck = [];

    // Own marbles
    for (let marbleId in gameState.players[myPosition].marbles) {
        const marble = gameState.players[myPosition].marbles[marbleId];
        if (marble.location === 'track' || marble.location === 'home') {
            marblesToCheck.push({ owner: myPosition, id: marbleId });
        }
    }

    // Teammate's marbles if finished
    if (isPlayerFinished(myPosition)) {
        const teammate = getTeammate(myPosition);
        for (let marbleId in gameState.players[teammate].marbles) {
            const marble = gameState.players[teammate].marbles[marbleId];
            if (marble.location === 'track' || marble.location === 'home') {
                marblesToCheck.push({ owner: teammate, id: marbleId });
            }
        }
    }

    // Check if ANY marble (other than first) can move remaining spaces
    for (let marble of marblesToCheck) {
        // Skip the first marble
        if (marble.owner === firstMarbleOwner && marble.id === firstMarbleId) {
            continue;
        }

        const secondMarble = gameState.players[marble.owner].marbles[marble.id];

        // If second marble is in home, check if it can move remaining spaces
        if (secondMarble.location === 'home') {
            const currentHomePos = secondMarble.position;
            const newHomePos = currentHomePos + remainingSpaces;

            if (newHomePos <= 4) {
                // Check if path is clear
                let blocked = false;
                for (let i = currentHomePos + 1; i <= newHomePos; i++) {
                    // Check if first marble will be at this home position
                    if (firstMarbleNewLocation === 'home' &&
                        firstMarbleNewPosition === i &&
                        marble.owner === firstMarbleOwner) {
                        blocked = true;
                        break;
                    }
                    // Check if another marble is here
                    if (gameState.board[marble.owner].home[i].marble !== null) {
                        blocked = true;
                        break;
                    }
                }

                if (!blocked) {
                    // Check if destination is clear
                    const destOccupied = gameState.board[marble.owner].home[newHomePos].marble !== null;
                    const firstMarbleAtDest = firstMarbleNewLocation === 'home' &&
                        firstMarbleNewPosition === newHomePos &&
                        marble.owner === firstMarbleOwner;

                    if (!destOccupied && !firstMarbleAtDest) {
                        return true;
                    }
                }
            }
        } else if (secondMarble.location === 'track') {
            // Manually check if second marble on track can move remaining spaces
            // We can't use getValidDestinations because it doesn't account for the first marble having moved
            const startPos = secondMarble.position;
            const homeEntry = gameState.board[marble.owner].homeEntry;
            const firstMarbleOriginalPos = gameState.players[firstMarbleOwner].marbles[firstMarbleId].position;
            const firstMarbleOriginalLocation = gameState.players[firstMarbleOwner].marbles[firstMarbleId].location;

            // Check if the second marble crosses or lands on home entry
            let crossesHome = false;
            let spacesToHomeEntry = 0;
            const onHomeEntry = startPos === homeEntry;

            if (!onHomeEntry) {
                for (let i = 1; i <= remainingSpaces; i++) {
                    if ((startPos + i) % 72 === homeEntry) {
                        crossesHome = true;
                        spacesToHomeEntry = i;
                        break;
                    }
                }
            }

            // Option 1: Move on track (possibly passing home)
            const trackDest = (startPos + remainingSpaces) % 72;
            let canMoveOnTrack = true;

            // Check if destination conflicts with first marble's new position
            if (firstMarbleNewLocation === 'track' && trackDest === firstMarbleNewPosition) {
                canMoveOnTrack = false;
            }

            // Check path to destination
            if (canMoveOnTrack) {
                let current = (startPos + 1) % 72;
                while (current !== trackDest) {
                    // Check if first marble's new position blocks the path
                    if (firstMarbleNewLocation === 'track' && current === firstMarbleNewPosition) {
                        canMoveOnTrack = false;
                        break;
                    }

                    // Check if another marble blocks (excluding first marble's original position)
                    if (current !== homeEntry) {
                        const occupant = getMarbleOnTrack(current);
                        if (occupant) {
                            // Ignore the first marble's current position (it will move away)
                            if (firstMarbleOriginalLocation === 'track' &&
                                occupant.player === firstMarbleOwner &&
                                occupant.marbleId === firstMarbleId &&
                                current === firstMarbleOriginalPos) {
                                // This is the first marble's old position, treat as empty
                            } else if (occupant.player === marble.owner) {
                                canMoveOnTrack = false;
                                break;
                            }
                        }
                    }
                    current = (current + 1) % 72;
                }

                // Check if destination has a marble (excluding first marble's original position)
                if (canMoveOnTrack) {
                    const destOccupant = getMarbleOnTrack(trackDest);
                    if (destOccupant) {
                        if (firstMarbleOriginalLocation === 'track' &&
                            destOccupant.player === firstMarbleOwner &&
                            destOccupant.marbleId === firstMarbleId &&
                            trackDest === firstMarbleOriginalPos) {
                            // Destination is first marble's old position, OK
                        } else if (destOccupant.player === marble.owner) {
                            canMoveOnTrack = false;
                        }
                    }
                }
            }

            if (canMoveOnTrack) {
                return true;
            }

            // Option 2: Enter home (if crossing or on home entry)
            if (onHomeEntry || crossesHome) {
                const spacesIntoHome = onHomeEntry ? remainingSpaces : remainingSpaces - spacesToHomeEntry;

                if (spacesIntoHome > 0 && spacesIntoHome <= 5) {
                    const homeIndex = spacesIntoHome - 1;

                    // Check if first marble would be at this home position
                    if (firstMarbleNewLocation === 'home' &&
                        firstMarbleNewPosition === homeIndex &&
                        marble.owner === firstMarbleOwner) {
                        // First marble will be here, can't enter
                    } else if (!isHomePathBlockedFromStart(marble.owner, homeIndex) &&
                               gameState.board[marble.owner].home[homeIndex].marble === null) {
                        return true;
                    }
                }
            }
        }
    }

    return false;
}

function getHomeChoiceOptions(marbleOwner, marbleId, spaces) {
    const marble = gameState.players[marbleOwner].marbles[marbleId];
    if (!marble || marble.location !== 'track') return null;
    
    const startPos = marble.position;
    const homeEntry = gameState.board[marbleOwner].homeEntry;
    
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
    
    if (!onHomeEntry && !crossesHome) return null;
    
    const spacesIntoHome = onHomeEntry ? spaces : spaces - spacesToHomeEntry;
    const trackDest = (startPos + spaces) % 72;
    
    let canEnterHome = false;
    let homeIndex = -1;
    if (spacesIntoHome > 0 && spacesIntoHome <= 5) {
        homeIndex = spacesIntoHome - 1;
        if (!isHomePathBlockedFromStart(marbleOwner, homeIndex) && 
            gameState.board[marbleOwner].home[homeIndex].marble === null) {
            canEnterHome = true;
        }
    }
    
    let canPassHome = false;
    let pathBlocked = false;
    let current = (startPos + 1) % 72;
    while (current !== trackDest) {
        if (current !== homeEntry) {
            const occupant = getMarbleOnTrack(current);
            if (occupant && occupant.player === marbleOwner) {
                pathBlocked = true;
                break;
            }
        }
        current = (current + 1) % 72;
    }
    if (!pathBlocked) {
        const destOccupant = getMarbleOnTrack(trackDest);
        if (!destOccupant || destOccupant.player !== marbleOwner) {
            canPassHome = true;
        }
    }
    
    return {
        canEnterHome,
        canPassHome,
        homeIndex,
        trackDest,
        spaces,
        marbleOwner
    };
}

function renderBoard() {
    const svg = gameBoard;
    svg.innerHTML = '';
    
    const defs = createSVGElement('defs', {});
    const filter = createSVGElement('filter', { id: 'goldGlow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
    const feGaussianBlur = createSVGElement('feGaussianBlur', { stdDeviation: '3', result: 'coloredBlur' });
    const feFlood = createSVGElement('feFlood', { 'flood-color': '#FFD700', 'flood-opacity': '0.8' });
    const feComposite = createSVGElement('feComposite', { in2: 'coloredBlur', operator: 'in' });
    const feMerge = createSVGElement('feMerge', {});
    const feMergeNode1 = createSVGElement('feMergeNode', {});
    const feMergeNode2 = createSVGElement('feMergeNode', { in: 'SourceGraphic' });
    feMerge.appendChild(feMergeNode1);
    feMerge.appendChild(feMergeNode2);
    filter.appendChild(feGaussianBlur);
    filter.appendChild(feFlood);
    filter.appendChild(feComposite);
    filter.appendChild(feMerge);
    defs.appendChild(filter);
    svg.appendChild(defs);
    
    const centerX = 400;
    const centerY = 400;
    const squareSize = 680;
    const marbleRadius = 12;
    
    const rotationOffset = getRotationOffset();

    let validDestinations = [];
    if (splitMoveState && splitMoveState.awaitingDestination && splitMoveState.firstMarbleId) {
        const maxSpaces = splitMoveState.cardType === 7 ? 7 : 8;
        validDestinations = getValidDestinations(
            splitMoveState.firstMarbleOwner || myPosition,
            splitMoveState.firstMarbleId,
            maxSpaces,
            'forward'
        );

        // Bug 1 Fix: If only 1 moveable marble for 7 card, must use all 7 spaces
        if (splitMoveState.cardType === 7) {
            const moveableCount = countMoveableMarbles().count;
            if (moveableCount === 1) {
                validDestinations = validDestinations.filter(d => d.spaces === 7);
            } else {
                // Bug 3 Fix: Filter destinations where split can be completed
                validDestinations = validDestinations.filter(d =>
                    canComplete7CardSplit(
                        splitMoveState.firstMarbleOwner || myPosition,
                        splitMoveState.firstMarbleId,
                        d.spaces
                    )
                );
            }
        } else if (splitMoveState.cardType === 9) {
            // Bug 4 Fix: Filter destinations where backward move can be completed
            validDestinations = validDestinations.filter(d =>
                canComplete9CardSplit(
                    splitMoveState.firstMarbleOwner || myPosition,
                    splitMoveState.firstMarbleId,
                    d.spaces
                )
            );
        }
    } else if (splitMoveState && splitMoveState.awaitingSecondDestination && splitMoveState.secondMarbleValidDests) {
        // Show valid destinations for second marble in 7 card split
        validDestinations = splitMoveState.secondMarbleValidDests;
    }
    
    let homeChoiceHighlights = null;
    if (homeChoiceState) {
        homeChoiceHighlights = homeChoiceState;
    }
    
    for (let i = 0; i < 72; i++) {
        const pos = getSquarePosition(i, centerX, centerY, squareSize, rotationOffset);
        
        const isValidDest = validDestinations.some(d => d.type === 'track' && d.position === i);
        const isHomeChoiceDest = homeChoiceHighlights && homeChoiceHighlights.canPassHome && 
            homeChoiceHighlights.trackDest === i;
        
        let fillColor = '#e0e0e0';
        if (isValidDest || isHomeChoiceDest) {
            fillColor = '#90EE90';
        }
        
        const circle = createSVGElement('circle', {
            cx: pos.x,
            cy: pos.y,
            r: 15,
            fill: fillColor,
            stroke: '#333',
            'stroke-width': 2,
            'data-track-position': i
        });
        
        if (isValidDest) {
            circle.style.cursor = 'pointer';
            const destData = validDestinations.find(d => d.type === 'track' && d.position === i);
            circle.addEventListener('click', () => onDestinationClick(destData));
        } else if (isHomeChoiceDest) {
            circle.style.cursor = 'pointer';
            circle.addEventListener('click', () => onHomeChoiceClick(false));
        }
        
        svg.appendChild(circle);

        const marbleData = getMarbleAtTrackPosition(i);
        if (marbleData) {
            const hitArea = createSVGElement('circle', {
                cx: pos.x,
                cy: pos.y,
                r: marbleRadius + 8,
                fill: 'transparent',
                class: 'marble-hit-area',
                style: 'cursor: pointer;'
            });
            hitArea.addEventListener('click', (e) => {
                e.stopPropagation();
                onMarbleClick(marbleData.player, marbleData.marbleId);
            });
            svg.appendChild(hitArea);
            
            const marble = createSVGElement('circle', {
                cx: pos.x,
                cy: pos.y,
                r: marbleRadius,
                fill: getPlayerColor(marbleData.player),
                stroke: '#000',
                'stroke-width': 2,
                class: 'marble',
                'pointer-events': 'none'
            });
            svg.appendChild(marble);
        }
    }
    
    const positions = ['Seat1', 'Seat2', 'Seat3', 'Seat4'];
    positions.forEach((pos) => {
        if (!gameState.players[pos]) return;
        
        const trackEntry = gameState.board[pos].trackEntry;
        const homeEntry = gameState.board[pos].homeEntry;
        const playerFinished = isPlayerFinished(pos);
        
        const entryPos = getSquarePosition(trackEntry, centerX, centerY, squareSize, rotationOffset);
        const homeEntryPos = getSquarePosition(homeEntry, centerX, centerY, squareSize, rotationOffset);
        
        const homeInward = getPerpendicularInward(homeEntry, rotationOffset);
        const homeLeft = getLeftDirection(homeInward);
        
        const entryInward = getPerpendicularInward(trackEntry, rotationOffset);
        const entryLeft = getLeftDirection(entryInward);

        const startCenterX = entryPos.x + entryInward.x * 65;
        const startCenterY = entryPos.y + entryInward.y * 65;

        const crossSpacing = 30;
        const crossOffsets = [
            { inward: 0, left: 0 },
            { inward: crossSpacing, left: 0 },
            { inward: 0, left: crossSpacing },
            { inward: 0, left: -crossSpacing },
            { inward: -crossSpacing, left: 0 }
        ];
        
        const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
        const isCurrentPlayer = pos === currentPlayer;

        for (let i = 0; i < 5; i++) {
            const offset = crossOffsets[i];
            const startX = startCenterX + entryInward.x * offset.inward + entryLeft.x * offset.left;
            const startY = startCenterY + entryInward.y * offset.inward + entryLeft.y * offset.left;

            const startCircle = createSVGElement('circle', {
                cx: startX,
                cy: startY,
                r: 15,
                fill: 'transparent',
                stroke: isCurrentPlayer ? '#FFD700' : getPlayerColor(pos),
                'stroke-width': isCurrentPlayer ? 4 : 2,
                filter: isCurrentPlayer ? 'url(#goldGlow)' : ''
            });
            svg.appendChild(startCircle);
            
            if (gameState.board[pos].start[i].marble) {
                const hitArea = createSVGElement('circle', {
                    cx: startX,
                    cy: startY,
                    r: marbleRadius + 8,
                    fill: 'transparent',
                    class: 'marble-hit-area',
                    style: 'cursor: pointer;'
                });
                hitArea.addEventListener('click', () => onMarbleClick(pos, `marble${i}`));
                svg.appendChild(hitArea);
                
                const marble = createSVGElement('circle', {
                    cx: startX,
                    cy: startY,
                    r: marbleRadius,
                    fill: getPlayerColor(pos),
                    stroke: '#000',
                    'stroke-width': 2,
                    class: 'marble',
                    'pointer-events': 'none'
                });
                svg.appendChild(marble);
            }
        }
        
        const homeSpacing = squareSize / 18; // Match track spacing
        const homeStartOffset = homeSpacing;

        const homeOffsets = [
            { inward: homeStartOffset, left: 0 },
            { inward: homeStartOffset + homeSpacing, left: 0 },
            { inward: homeStartOffset + homeSpacing * 2, left: 0 },
            { inward: homeStartOffset + homeSpacing * 2, left: homeSpacing },
            { inward: homeStartOffset + homeSpacing * 3, left: homeSpacing }
        ];
        
        for (let i = 0; i < 5; i++) {
            const offset = homeOffsets[i];
            const homeX = homeEntryPos.x + homeInward.x * offset.inward + homeLeft.x * offset.left;
            const homeY = homeEntryPos.y + homeInward.y * offset.inward + homeLeft.y * offset.left;
            
            const isValidHomeDest = validDestinations.some(d => d.type === 'home' && d.homeIndex === i && d.marbleOwner === pos);
            const isHomeChoiceHome = homeChoiceHighlights && 
                homeChoiceHighlights.canEnterHome && 
                homeChoiceHighlights.homeIndex === i &&
                homeChoiceHighlights.marbleOwner === pos;
            
            const homeCircle = createSVGElement('circle', {
                cx: homeX,
                cy: homeY,
                r: 15,
                fill: (isValidHomeDest || isHomeChoiceHome) ? '#90EE90' : 'transparent',
                stroke: playerFinished ? '#FFD700' : getPlayerColor(pos),
                'stroke-width': playerFinished ? 4 : 3,
                filter: playerFinished ? 'url(#goldGlow)' : '',
                'data-home-position': i,
                'data-home-player': pos
            });
            
            if (isValidHomeDest) {
                homeCircle.style.cursor = 'pointer';
                const destData = validDestinations.find(d => d.type === 'home' && d.homeIndex === i && d.marbleOwner === pos);
                homeCircle.addEventListener('click', () => onDestinationClick(destData));
            } else if (isHomeChoiceHome) {
                homeCircle.style.cursor = 'pointer';
                homeCircle.addEventListener('click', () => onHomeChoiceClick(true));
            }
            
            svg.appendChild(homeCircle);
            
            if (gameState.board[pos].home[i].marble) {
                const marbleId = getMarbleIdAtHomePosition(pos, i);
                
                if (marbleId) {
                    const hitArea = createSVGElement('circle', {
                        cx: homeX,
                        cy: homeY,
                        r: marbleRadius + 8,
                        fill: 'transparent',
                        class: 'marble-hit-area',
                        style: 'cursor: pointer;'
                    });
                    hitArea.addEventListener('click', () => onMarbleClick(pos, marbleId));
                    svg.appendChild(hitArea);
                    
                    const marble = createSVGElement('circle', {
                        cx: homeX,
                        cy: homeY,
                        r: marbleRadius,
                        fill: getPlayerColor(pos),
                        stroke: '#000',
                        'stroke-width': 2,
                        class: 'marble',
                        'pointer-events': 'none'
                    });
                    svg.appendChild(marble);
                }
            }
        }
        
        // Display player name at viewport edge for maximum board space
        if (gameState.players[pos]) {
            // Determine rotation and position based on relative seat
            const seatIndex = gameState.playerOrder.indexOf(pos);
            const mySeatIndex = gameState.playerOrder.indexOf(myPosition);
            const relativeSeatDiff = (seatIndex - mySeatIndex + 4) % 4;

            let labelX, labelY, textRotation = 0;

            if (relativeSeatDiff === 0) {
                // Bottom player (me) - position near bottom edge
                labelX = 400;
                labelY = 785;
            } else if (relativeSeatDiff === 2) {
                // Top player (across) - position near top edge
                labelX = 400;
                labelY = 15;
            } else if (relativeSeatDiff === 1) {
                // Left player - rotate 90° counter-clockwise, position near left edge
                labelX = 15;
                labelY = 400;
                textRotation = -90;
            } else {
                // Right player - rotate 90° clockwise, position near right edge
                labelX = 785;
                labelY = 400;
                textRotation = 90;
            }

            const nameLabel = createSVGElement('text', {
                x: labelX,
                y: labelY,
                'text-anchor': 'middle',
                'dominant-baseline': 'middle',
                fill: playerFinished ? '#FFD700' : getPlayerColor(pos),
                'font-size': '20',
                'font-weight': 'bold',
                transform: textRotation !== 0 ? `rotate(${textRotation}, ${labelX}, ${labelY})` : ''
            });
            nameLabel.textContent = gameState.players[pos].name + (playerFinished ? ' ✓' : '');
            svg.appendChild(nameLabel);
        }
    });

    // Deck counter in center of board
    const deckCount = gameState.deck ? gameState.deck.length : 0;

    // Draw deck background rectangle
    const deckRect = createSVGElement('rect', {
        x: centerX - 40,
        y: centerY - 50,
        width: 80,
        height: 100,
        rx: 8,
        fill: '#c0392b',
        stroke: '#922b21',
        'stroke-width': 3
    });
    svg.appendChild(deckRect);

    // Draw card back pattern (simple design)
    const pattern1 = createSVGElement('rect', {
        x: centerX - 30,
        y: centerY - 40,
        width: 60,
        height: 80,
        rx: 5,
        fill: 'none',
        stroke: '#ecf0f1',
        'stroke-width': 2
    });
    svg.appendChild(pattern1);

    const pattern2 = createSVGElement('rect', {
        x: centerX - 20,
        y: centerY - 30,
        width: 40,
        height: 60,
        rx: 3,
        fill: 'none',
        stroke: '#ecf0f1',
        'stroke-width': 2
    });
    svg.appendChild(pattern2);

    // Draw deck count text
    const deckCountText = createSVGElement('text', {
        x: centerX,
        y: centerY + 70,
        'text-anchor': 'middle',
        'font-size': '18',
        'font-weight': 'bold',
        fill: '#ffffff',
        stroke: '#000000',
        'stroke-width': '1'
    });
    deckCountText.textContent = `${deckCount} cards`;
    svg.appendChild(deckCountText);

    // Draw distance counting line if active
    drawDistanceLine();
}

function renderHand() {
    if (!myPosition || !gameState.players[myPosition]) return;

    const hand = gameState.players[myPosition].hand;
    playerHand.innerHTML = '';

    hand.forEach((card, index) => {
        const cardEl = document.createElement('div');
        cardEl.className = 'card' + (selectedCard === index ? ' selected' : '');
        cardEl.dataset.index = index;
        
        const isRed = card.suit === 'hearts' || card.suit === 'diamonds' || card.suit === 'red';
        cardEl.innerHTML = `
            <div class="card-value ${isRed ? 'red' : 'black'}">${card.value}</div>
            <div class="card-suit ${isRed ? 'red' : 'black'}">${getSuitSymbol(card.suit)}</div>
        `;
        
        cardEl.addEventListener('click', () => onCardClick(index));
        playerHand.appendChild(cardEl);
    });
    
    const isMyTurn = gameState.playerOrder[gameState.currentPlayerIndex] === myPosition;
    discardBtn.disabled = selectedCard === null || !isMyTurn;
}

function renderGameInfo() {
    // These elements were removed when UI was simplified
    // Keeping function for potential future use
    return;
}

function renderMovesLog() {
    const movesLogContent = document.getElementById('movesLogContent');
    if (!movesLogContent) {
        console.log('movesLogContent element not found');
        return;
    }

    if (!gameState.movesLog) {
        console.log('gameState.movesLog is undefined');
        return;
    }

    console.log(`Rendering moves log with ${gameState.movesLog.length} entries`);
    movesLogContent.innerHTML = '';

    if (gameState.movesLog.length === 0) {
        movesLogContent.innerHTML = '<div class="move-entry" style="text-align: center; color: #888;">No moves yet</div>';
        return;
    }

    gameState.movesLog.forEach(entry => {
        const moveEntry = document.createElement('div');
        moveEntry.className = 'move-entry';
        moveEntry.innerHTML = `<span class="move-entry-player">${entry.player}:</span> played ${entry.card}`;
        movesLogContent.appendChild(moveEntry);
    });
}

function onCardClick(cardIndex) {
    const currentPlayer = gameState.playerOrder[gameState.currentPlayerIndex];
    const isMyTurn = currentPlayer === myPosition;

    console.log(`[CLIENT onCardClick] myPosition: ${myPosition}, currentPlayer: ${currentPlayer}, index: ${gameState.currentPlayerIndex}, isMyTurn: ${isMyTurn}`);

    if (!isMyTurn) {
        console.log(`[CLIENT onCardClick] REJECTED - Not my turn. I am ${myPosition}, but current is ${currentPlayer}`);
        alert("It's not your turn!");
        return;
    }

    if (splitMoveState && splitMoveState.awaitingSecondMarble) {
        alert("Complete your current move first!");
        return;
    }
    
    const card = gameState.players[myPosition].hand[cardIndex];
    const cardValue = getCardValue(card);

    selectedCard = cardIndex;
    splitMoveState = null;
    homeChoiceState = null;
    renderHand();

    const instructionEl = document.getElementById('cardInstruction');

    const canMoveTeammate = isPlayerFinished(myPosition);
    const extra = canMoveTeammate ? " (can move teammate's marbles)" : "";

    if (cardValue === 'face') {
        instructionEl.textContent = `${card.value}: Click a marble in START to enter, or on TRACK to move 10 spaces${extra}`;
    } else if (cardValue === 1) {
        instructionEl.textContent = `Ace: Click a marble in START to enter, or on TRACK to move 1 space${extra}`;
    } else if (cardValue === 'joker') {
        instructionEl.textContent = `Joker: Click YOUR marble first, then click ANY other marble to jump on it${extra}`;
    } else if (cardValue === 7) {
        instructionEl.textContent = `7: Click a marble to move forward (can split between 2 marbles, total 7)${extra}`;
    } else if (cardValue === 8) {
        instructionEl.textContent = `8: Click a marble to move it BACKWARDS 8 spaces${extra}`;
    } else if (cardValue === 9) {
        // Check if 9 card can be played
        if (!canPlay9Card()) {
            instructionEl.textContent = `9: Cannot play - need at least 2 moveable marbles (1 must be on track). Discard to continue.`;
        } else {
            instructionEl.textContent = `9: Click first marble to move FORWARD (1-8), then a DIFFERENT marble moves BACKWARD${extra}`;
        }
    } else {
        instructionEl.textContent = `${card.value}: Click a marble to move it ${cardValue} spaces forward${extra}`;
    }
    
    renderBoard();
}

function onMarbleClick(marbleOwner, marbleId) {
    if (selectedCard === null && !splitMoveState?.awaitingSecondMarble) {
        alert('Select a card first!');
        return;
    }

    const isMyTurn = gameState.playerOrder[gameState.currentPlayerIndex] === myPosition;
    if (!isMyTurn) return;

    // If awaiting destination selection for 7/9 card, check if marble is at a valid destination
    // If so, treat it as clicking that destination space
    if (splitMoveState && splitMoveState.awaitingDestination) {
        const marble = gameState.players[marbleOwner].marbles[marbleId];
        if (marble.location === 'track') {
            // Check if this track position is a valid destination
            const validDestinations = getValidDestinations(
                splitMoveState.firstMarbleOwner,
                splitMoveState.firstMarbleId,
                splitMoveState.cardType === 7 ? 7 : 8
            );
            const destData = validDestinations.find(d => d.type === 'track' && d.position === marble.position);
            if (destData) {
                onDestinationClick(destData);
                return;
            }
        }
        // If not a valid destination, ignore the click
        return;
    }

    if (splitMoveState && splitMoveState.awaitingSecondMarble) {
        handleSplitSecondMarble(marbleOwner, marbleId);
        return;
    }

    const card = gameState.players[myPosition].hand[selectedCard];
    const cardValue = getCardValue(card);
    
    if (cardValue === 7) {
        handle7CardMarbleClick(marbleOwner, marbleId);
        return;
    }
    
    if (cardValue === 9) {
        handle9CardMarbleClick(marbleOwner, marbleId);
        return;
    }

    if (cardValue === 'joker') {
        if (selectedMarbles.length === 0) {
            // Selecting source marble - must be able to control it
            if (!canControlMarble(marbleOwner)) {
                alert('You cannot move that marble');
                return;
            }
            selectedMarbles.push({ player: marbleOwner, marbleId });
            document.getElementById('cardInstruction').textContent =
                `Joker: Now click the TARGET marble (any player) to jump on it`;
            return;
        } else {
            // Bug 2 Fix: Selecting target marble - can be ANY other player's marble
            const source = selectedMarbles[0];
            if (marbleOwner === source.player) {
                alert('Cannot joker onto your own marble');
                return;
            }
            const targetMarble = gameState.players[marbleOwner].marbles[marbleId];
            if (targetMarble.location !== 'track') {
                alert('Target marble must be on the track');
                return;
            }
            playCard({
                marbleOwner: source.player,
                sourceMarbleId: source.marbleId,
                targetPlayer: marbleOwner,
                targetMarbleId: marbleId
            });
            return;
        }
    }

    if (!canControlMarble(marbleOwner)) {
        alert('You cannot move that marble');
        return;
    }
    
    if (cardValue === 'face' || cardValue === 1) {
        const marble = gameState.players[marbleOwner].marbles[marbleId];
        let moveData = { marbleId, marbleOwner };
        
        if (marble.location === 'start') {
            moveData.action = 'enter';
            playCard(moveData);
            return;
        } else if (marble.location === 'track' || marble.location === 'home') {
            moveData.action = 'move';
            const spaces = cardValue === 'face' ? 10 : 1;
            
            if (marble.location === 'track') {
                const homeChoice = getHomeChoiceOptions(marbleOwner, marbleId, spaces);
                if (homeChoice && homeChoice.canEnterHome && homeChoice.canPassHome) {
                    homeChoiceState = { ...homeChoice, marbleId, marbleOwner, action: 'move' };
                    document.getElementById('cardInstruction').textContent = 
                        `Choose: Click HOME space to enter, or TRACK space to pass home`;
                    renderBoard();
                    return;
                }
            }
            
            playCard(moveData);
            return;
        }
        return;
    }
    
    const marble = gameState.players[marbleOwner].marbles[marbleId];
    
    if (marble.location === 'track') {
        const homeChoice = getHomeChoiceOptions(marbleOwner, marbleId, cardValue);
        if (homeChoice && homeChoice.canEnterHome && homeChoice.canPassHome) {
            homeChoiceState = { ...homeChoice, marbleId, marbleOwner };
            document.getElementById('cardInstruction').textContent = 
                `Choose: Click HOME space to enter, or TRACK space to pass home`;
            renderBoard();
            return;
        }
    }
    
    playCard({ marbleId, marbleOwner });
}

function handle7CardMarbleClick(marbleOwner, marbleId) {
    if (!canControlMarble(marbleOwner)) {
        alert('You cannot move that marble');
        return;
    }
    
    const marble = gameState.players[marbleOwner].marbles[marbleId];
    
    if (marble.location !== 'track' && marble.location !== 'home') {
        alert('Marble must be on track or in home to move');
        return;
    }
    
    splitMoveState = {
        cardType: 7,
        firstMarbleId: marbleId,
        firstMarbleOwner: marbleOwner,
        firstSpaces: 0,
        firstEnterHome: false,
        awaitingDestination: true,
        awaitingSecondMarble: false
    };
    
    document.getElementById('cardInstruction').textContent = 
        `7: Click a highlighted space (1-7 ahead) to move there`;
    
    renderBoard();
}

function handle9CardMarbleClick(marbleOwner, marbleId) {
    if (!canControlMarble(marbleOwner)) {
        alert('You cannot move that marble');
        return;
    }
    
    const marble = gameState.players[marbleOwner].marbles[marbleId];
    
    if (marble.location !== 'track' && marble.location !== 'home') {
        alert('First marble must be on track or in home to move forward');
        return;
    }
    
    splitMoveState = {
        cardType: 9,
        firstMarbleId: marbleId,
        firstMarbleOwner: marbleOwner,
        firstSpaces: 0,
        firstEnterHome: false,
        awaitingDestination: true,
        awaitingSecondMarble: false
    };
    
    document.getElementById('cardInstruction').textContent = 
        `9: Click a highlighted space (1-8 ahead) to move forward`;
    
    renderBoard();
}

function handleSplitSecondMarble(marbleOwner, marbleId) {
    if (!canControlMarble(marbleOwner)) {
        alert('You cannot move that marble');
        return;
    }
    
    // Can't use the same marble
    if (marbleOwner === splitMoveState.firstMarbleOwner && marbleId === splitMoveState.firstMarbleId) {
        alert('Must use a DIFFERENT marble');
        return;
    }
    
    const marble = gameState.players[marbleOwner].marbles[marbleId];
    
    if (splitMoveState.cardType === 7) {
        if (marble.location !== 'track' && marble.location !== 'home') {
            alert('Marble must be on track or in home');
            return;
        }
        
        const validDests = getValidDestinations(marbleOwner, marbleId, splitMoveState.remainingSpaces, 'forward');
        const exactDest = validDests.find(d => d.spaces === splitMoveState.remainingSpaces);
        
        if (!exactDest) {
            alert(`Cannot move this marble ${splitMoveState.remainingSpaces} spaces forward`);
            return;
        }
        
        const destsAtDistance = validDests.filter(d => d.spaces === splitMoveState.remainingSpaces);
        if (destsAtDistance.length > 1) {
            splitMoveState.secondMarbleId = marbleId;
            splitMoveState.secondMarbleOwner = marbleOwner;
            splitMoveState.awaitingSecondDestination = true;
            splitMoveState.awaitingSecondMarble = false;
            splitMoveState.secondMarbleValidDests = destsAtDistance;
            
            document.getElementById('cardInstruction').textContent = 
                `7: Click where to move second marble (${splitMoveState.remainingSpaces} spaces)`;
            renderBoard();
            return;
        }
        
        socket.emit('completeSplitMove', {
            position: myPosition,
            moveData: {
                marbleId: marbleId,
                marbleOwner: marbleOwner,
                enterHome: exactDest.enterHome
            }
        });
    } else {
        if (marble.location !== 'track') {
            alert('Second marble must be on track to move backward');
            return;
        }
        
        socket.emit('completeSplitMove', {
            position: myPosition,
            moveData: {
                marbleId: marbleId,
                marbleOwner: marbleOwner
            }
        });
    }
}

function onDestinationClick(destData) {
    if (!splitMoveState) return;
    
    if (splitMoveState.awaitingSecondDestination) {
        socket.emit('completeSplitMove', {
            position: myPosition,
            moveData: {
                marbleId: splitMoveState.secondMarbleId,
                marbleOwner: splitMoveState.secondMarbleOwner,
                enterHome: destData.enterHome
            }
        });
        return;
    }
    
    if (!splitMoveState.awaitingDestination) return;
    
    const spaces = destData.spaces;
    
    socket.emit('partialMove', {
        position: myPosition,
        cardIndex: selectedCard,
        cardType: splitMoveState.cardType,
        moveData: {
            marbleId: splitMoveState.firstMarbleId,
            marbleOwner: splitMoveState.firstMarbleOwner,
            spaces: spaces,
            enterHome: destData.enterHome
        }
    });
    
    splitMoveState.firstSpaces = spaces;
    splitMoveState.firstEnterHome = destData.enterHome;
    splitMoveState.awaitingDestination = false;
}

function onHomeChoiceClick(enterHome) {
    if (!homeChoiceState) return;
    
    const moveData = { 
        marbleId: homeChoiceState.marbleId,
        marbleOwner: homeChoiceState.marbleOwner,
        enterHome: enterHome
    };
    
    if (homeChoiceState.action) {
        moveData.action = homeChoiceState.action;
    }
    
    playCard(moveData);
}

function playCard(moveData) {
    socket.emit('playCard', {
        position: myPosition,
        cardIndex: selectedCard,
        moveData: moveData
    });
    
    selectedCard = null;
    selectedMarbles = [];
    splitMoveState = null;
    homeChoiceState = null;
    
    const instructionEl = document.getElementById('cardInstruction');
    if (instructionEl) {
        instructionEl.textContent = '';
    }
    
    renderHand();
}

function getMarbleAtTrackPosition(position) {
    for (let player of gameState.playerOrder) {
        const marbles = gameState.players[player].marbles;
        for (let marbleId in marbles) {
            if (marbles[marbleId].location === 'track' && marbles[marbleId].position === position) {
                return { player, marbleId };
            }
        }
    }
    return null;
}

function createSVGElement(type, attributes) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', type);
    for (let key in attributes) {
        el.setAttribute(key, attributes[key]);
    }
    return el;
}

function getPlayerColor(position) {
    const colors = {
        Seat1: '#2196F3',
        Seat2: '#F44336',
        Seat3: '#9C27B0',
        Seat4: '#FF9800'
    };
    return colors[position] || '#999';
}

function getSuitSymbol(suit) {
    const symbols = {
        hearts: '♥',
        diamonds: '♦',
        clubs: '♣',
        spades: '♠',
        red: '🃏',
        black: '🃏'
    };
    return symbols[suit] || '';
}

function getCardValue(card) {
    if (card.value === 'Joker') return 'joker';
    if (card.value === 'A') return 1;
    if (card.value === 'J' || card.value === 'Q' || card.value === 'K') return 'face';
    return parseInt(card.value);
}

// Distance Counter Functions
function initializeDistanceCounter() {
    const svg = gameBoard;

    // Only enable distance counter on desktop (mouse events only)
    // Touch devices don't support this feature due to drag interaction conflicts
    svg.addEventListener('mousedown', handleDistanceStart);
    svg.addEventListener('mousemove', handleDistanceMove);
    svg.addEventListener('mouseup', handleDistanceEnd);
    svg.addEventListener('mouseleave', handleDistanceEnd);
}

function handleDistanceStart(e) {
    // Don't activate distance counter if waiting for destination selection (7/9 cards)
    if (splitMoveState && (splitMoveState.awaitingDestination || splitMoveState.awaitingSecondDestination)) {
        return;
    }

    // Don't activate if waiting for home choice
    if (homeChoiceState) {
        return;
    }

    const trackPos = e.target.getAttribute('data-track-position');
    const homePos = e.target.getAttribute('data-home-position');
    const homePlayer = e.target.getAttribute('data-home-player');

    if (trackPos !== null) {
        distanceCountState.active = true;
        distanceCountState.startPos = parseInt(trackPos);
        distanceCountState.startType = 'track';
        distanceCountState.startPlayer = null;
        distanceCountState.currentPos = distanceCountState.startPos;
        distanceCountState.currentType = 'track';
        distanceCountState.currentPlayer = null;
    } else if (homePos !== null && homePlayer !== null) {
        distanceCountState.active = true;
        distanceCountState.startPos = parseInt(homePos);
        distanceCountState.startType = 'home';
        distanceCountState.startPlayer = homePlayer;
        distanceCountState.currentPos = distanceCountState.startPos;
        distanceCountState.currentType = 'home';
        distanceCountState.currentPlayer = homePlayer;
    }
}

function handleDistanceMove(e) {
    if (!distanceCountState.active) return;

    const svg = gameBoard;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Convert to SVG coordinates
    const svgX = (x / rect.width) * 800;
    const svgY = (y / rect.height) * 800;

    // Find nearest position (track or home)
    const nearestPos = findNearestPosition(svgX, svgY);
    if (nearestPos !== null) {
        const changed = nearestPos.pos !== distanceCountState.currentPos ||
            nearestPos.type !== distanceCountState.currentType ||
            nearestPos.player !== distanceCountState.currentPlayer;

        if (changed) {
            distanceCountState.currentPos = nearestPos.pos;
            distanceCountState.currentType = nearestPos.type;
            distanceCountState.currentPlayer = nearestPos.player;
            renderBoard(); // Re-render to show distance line
        }
    }
}

function handleDistanceEnd() {
    if (distanceCountState.active) {
        distanceCountState.active = false;
        distanceCountState.startPos = null;
        distanceCountState.startType = null;
        distanceCountState.startPlayer = null;
        distanceCountState.currentPos = null;
        distanceCountState.currentType = null;
        distanceCountState.currentPlayer = null;
        renderBoard(); // Clear the distance line
    }
}

function findNearestPosition(svgX, svgY) {
    const centerX = 400;
    const centerY = 400;
    const squareSize = 680;
    const rotationOffset = getRotationOffset();

    let nearest = null;
    let minDist = Infinity;

    // Check all track positions
    for (let i = 0; i < 72; i++) {
        const pos = getSquarePosition(i, centerX, centerY, squareSize, rotationOffset);
        const dist = Math.sqrt((pos.x - svgX) ** 2 + (pos.y - svgY) ** 2);
        if (dist < minDist && dist < 30) { // Within 30 units
            minDist = dist;
            nearest = { pos: i, type: 'track', player: null };
        }
    }

    // Check all home positions for each player
    const positions = ['Seat1', 'Seat2', 'Seat3', 'Seat4'];
    positions.forEach((player) => {
        if (!gameState || !gameState.players[player]) return;

        const homeEntry = gameState.board[player].homeEntry;
        const homeEntryPos = getSquarePosition(homeEntry, centerX, centerY, squareSize, rotationOffset);
        const homeInward = getPerpendicularInward(homeEntry, rotationOffset);
        const homeLeft = getLeftDirection(homeInward);

        const homeSpacing = squareSize / 18;
        const homeStartOffset = homeSpacing;

        const homeOffsets = [
            { inward: homeStartOffset, left: 0 },
            { inward: homeStartOffset + homeSpacing, left: 0 },
            { inward: homeStartOffset + homeSpacing * 2, left: 0 },
            { inward: homeStartOffset + homeSpacing * 2, left: homeSpacing },
            { inward: homeStartOffset + homeSpacing * 3, left: homeSpacing }
        ];

        for (let i = 0; i < 5; i++) {
            const offset = homeOffsets[i];
            const homeX = homeEntryPos.x + homeInward.x * offset.inward + homeLeft.x * offset.left;
            const homeY = homeEntryPos.y + homeInward.y * offset.inward + homeLeft.y * offset.left;

            const dist = Math.sqrt((homeX - svgX) ** 2 + (homeY - svgY) ** 2);
            if (dist < minDist && dist < 30) { // Within 30 units
                minDist = dist;
                nearest = { pos: i, type: 'home', player: player };
            }
        }
    });

    return nearest;
}

function calculateDistance(startPos, startType, startPlayer, endPos, endType, endPlayer) {
    // Both positions on track
    if (startType === 'track' && endType === 'track') {
        if (startPos === endPos) return 0;

        // Calculate forward distance
        let forward = 0;
        let current = startPos;
        while (current !== endPos && forward < 72) {
            forward++;
            current = (current + 1) % 72;
        }

        // Calculate backward distance
        let backward = 0;
        current = startPos;
        while (current !== endPos && backward < 72) {
            backward++;
            current = (current - 1 + 72) % 72;
        }

        // Return the shorter distance
        return Math.min(forward, backward);
    }

    // Start on track, end in home
    if (startType === 'track' && endType === 'home') {
        if (!endPlayer) {
            return null;
        }

        const homeEntry = gameState.board[endPlayer].homeEntry;

        // Calculate distance to home entry
        let distToHome = 0;
        let current = startPos;
        while (current !== homeEntry && distToHome < 72) {
            distToHome++;
            current = (current + 1) % 72;
        }

        // Add distance into home (endPos is 0-4, representing home index)
        return distToHome + endPos + 1;
    }

    // Start in home, end on track (marbles don't move out of home backwards)
    if (startType === 'home' && endType === 'track') {
        return null;
    }

    // Both in home
    if (startType === 'home' && endType === 'home') {
        if (startPlayer !== endPlayer) {
            return null; // Different players
        }

        if (startPos === endPos) return 0;

        // Can only move forward in home
        if (endPos > startPos) {
            return endPos - startPos;
        } else {
            return null; // Can't move backward in home
        }
    }

    return null;
}

function drawDistanceLine() {
    if (!distanceCountState.active || distanceCountState.startPos === null || distanceCountState.currentPos === null) {
        return;
    }

    const centerX = 400;
    const centerY = 400;
    const squareSize = 680;
    const rotationOffset = getRotationOffset();

    // Get visual positions for start and end
    let startVisualPos, endVisualPos;

    if (distanceCountState.startType === 'track') {
        startVisualPos = getSquarePosition(distanceCountState.startPos, centerX, centerY, squareSize, rotationOffset);
    } else {
        // Home position - need to calculate visual position
        const homeEntry = gameState.board[distanceCountState.startPlayer].homeEntry;
        const homeEntryPos = getSquarePosition(homeEntry, centerX, centerY, squareSize, rotationOffset);
        const homeInward = getPerpendicularInward(homeEntry, rotationOffset);
        const homeLeft = getLeftDirection(homeInward);
        const homeSpacing = squareSize / 18;
        const homeStartOffset = homeSpacing;
        const homeOffsets = [
            { inward: homeStartOffset, left: 0 },
            { inward: homeStartOffset + homeSpacing, left: 0 },
            { inward: homeStartOffset + homeSpacing * 2, left: 0 },
            { inward: homeStartOffset + homeSpacing * 2, left: homeSpacing },
            { inward: homeStartOffset + homeSpacing * 3, left: homeSpacing }
        ];
        const offset = homeOffsets[distanceCountState.startPos];
        startVisualPos = {
            x: homeEntryPos.x + homeInward.x * offset.inward + homeLeft.x * offset.left,
            y: homeEntryPos.y + homeInward.y * offset.inward + homeLeft.y * offset.left
        };
    }

    if (distanceCountState.currentType === 'track') {
        endVisualPos = getSquarePosition(distanceCountState.currentPos, centerX, centerY, squareSize, rotationOffset);
    } else {
        // Home position
        const homeEntry = gameState.board[distanceCountState.currentPlayer].homeEntry;
        const homeEntryPos = getSquarePosition(homeEntry, centerX, centerY, squareSize, rotationOffset);
        const homeInward = getPerpendicularInward(homeEntry, rotationOffset);
        const homeLeft = getLeftDirection(homeInward);
        const homeSpacing = squareSize / 18;
        const homeStartOffset = homeSpacing;
        const homeOffsets = [
            { inward: homeStartOffset, left: 0 },
            { inward: homeStartOffset + homeSpacing, left: 0 },
            { inward: homeStartOffset + homeSpacing * 2, left: 0 },
            { inward: homeStartOffset + homeSpacing * 2, left: homeSpacing },
            { inward: homeStartOffset + homeSpacing * 3, left: homeSpacing }
        ];
        const offset = homeOffsets[distanceCountState.currentPos];
        endVisualPos = {
            x: homeEntryPos.x + homeInward.x * offset.inward + homeLeft.x * offset.left,
            y: homeEntryPos.y + homeInward.y * offset.inward + homeLeft.y * offset.left
        };
    }

    const svg = gameBoard;

    // Draw line
    const line = createSVGElement('line', {
        x1: startVisualPos.x,
        y1: startVisualPos.y,
        x2: endVisualPos.x,
        y2: endVisualPos.y,
        stroke: '#FFD700',
        'stroke-width': 3,
        'stroke-dasharray': '5,5',
        'pointer-events': 'none'
    });
    svg.appendChild(line);

    // Calculate distance
    const distance = calculateDistance(
        distanceCountState.startPos,
        distanceCountState.startType,
        distanceCountState.startPlayer,
        distanceCountState.currentPos,
        distanceCountState.currentType,
        distanceCountState.currentPlayer
    );

    const midX = (startVisualPos.x + endVisualPos.x) / 2;
    const midY = (startVisualPos.y + endVisualPos.y) / 2;

    // Determine what to display
    const displayText = distance !== null ? distance.toString() : 'N/A';

    // Background for text
    const bgWidth = 50;
    const textBg = createSVGElement('rect', {
        x: midX - bgWidth / 2,
        y: midY - 18,
        width: bgWidth,
        height: 36,
        rx: 5,
        fill: '#FFD700',
        stroke: '#000',
        'stroke-width': 2,
        'pointer-events': 'none'
    });
    svg.appendChild(textBg);

    // Distance text
    const text = createSVGElement('text', {
        x: midX,
        y: midY + 6,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        fill: '#000',
        'font-size': '18',
        'font-weight': 'bold',
        'pointer-events': 'none'
    });
    text.textContent = displayText;
    svg.appendChild(text);
}

// Initialize distance counter when page loads
setTimeout(() => {
    if (gameBoard) {
        initializeDistanceCounter();
    }
}, 100);

// Check if already authenticated on page load
window.addEventListener('load', () => {
    if (localStorage.getItem('gameAuthenticated') === 'true') {
        showScreen('loginScreen');
    }
});

// Notification System
function showNotification(message, type = 'info') {
    // Remove existing notification if any
    const existing = document.querySelector('.game-notification');
    if (existing) {
        existing.remove();
    }

    const notification = document.createElement('div');
    notification.className = `game-notification notification-${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    // Auto-remove after 5 seconds
    setTimeout(() => {
        notification.classList.add('fade-out');
        setTimeout(() => notification.remove(), 500);
    }, 5000);
}
