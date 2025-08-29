const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const questions = require('./questions.json');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Game state
let waitingPlayers = [];
let activeGames = {};
let lobbyTimers = {};

// Lobby timer system
const LOBBY_TIME = 140; // 2 min 20 sec
let globalLobbyTimer = LOBBY_TIME;

// Start global lobby countdown
setInterval(() => {
  globalLobbyTimer--;
  if (globalLobbyTimer <= 0) {
    // Find players and start matching
    if (waitingPlayers.length >= 2) {
      startPlayerMatching();
    }
    globalLobbyTimer = LOBBY_TIME; // Reset timer
  }
  
  // Broadcast timer to all waiting players
  io.emit('lobbyTimer', { time: globalLobbyTimer });
}, 1000);

// Get random questions
function getRandomQuestions(count = 50) {
  const shuffled = [...questions].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

// Start player matching
function startPlayerMatching() {
  while (waitingPlayers.length >= 2) {
    const player1 = waitingPlayers.shift();
    const player2 = waitingPlayers.shift();
    
    const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create game room
    activeGames[gameId] = {
      players: [player1, player2],
      questions: getRandomQuestions(),
      currentQuestion: 0,
      scores: { [player1.id]: 0, [player2.id]: 0 },
      gameTime: 30,
      isActive: false
    };
    
    // Join socket rooms
    player1.socket.join(gameId);
    player2.socket.join(gameId);
    
    // Notify players
    io.to(gameId).emit('playersMatched', {
      gameId: gameId,
      players: [player1.username, player2.username]
    });
    
    // Start countdown
    startGameCountdown(gameId);
  }
}

// Game countdown before start
function startGameCountdown(gameId) {
  let countdown = 5;
  
  const countdownInterval = setInterval(() => {
    io.to(gameId).emit('gameCountdown', { count: countdown });
    countdown--;
    
    if (countdown < 0) {
      clearInterval(countdownInterval);
      startGame(gameId);
    }
  }, 1000);
}

// Start the actual game
function startGame(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  
  game.isActive = true;
  game.startTime = Date.now();
  
  // Send first question
  sendQuestion(gameId);
  
  // Start game timer (30 seconds)
  setTimeout(() => {
    endGame(gameId);
  }, 30000);
  
  // Game timer countdown
  let timeLeft = 30;
  const timerInterval = setInterval(() => {
    timeLeft--;
    io.to(gameId).emit('gameTimer', { timeLeft });
    
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
    }
  }, 1000);
}

// Send question to players
function sendQuestion(gameId) {
  const game = activeGames[gameId];
  if (!game || !game.isActive) return;
  
  const question = game.questions[game.currentQuestion];
  if (!question) return;
  
  io.to(gameId).emit('newQuestion', {
    question: question.question,
    options: question.options,
    questionNumber: game.currentQuestion + 1
  });
}

// End game and calculate results
function endGame(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  
  game.isActive = false;
  
  const scores = game.scores;
  const playerIds = Object.keys(scores);
  const winner = scores[playerIds[0]] > scores[playerIds[1]] ? 
    playerIds[0] : scores[playerIds[1]] > scores[playerIds[0]] ? 
    playerIds[1] : null;
  
  io.to(gameId).emit('gameEnd', {
    scores: scores,
    winner: winner,
    isDraw: winner === null
  });
  
  // Cleanup
  setTimeout(() => {
    delete activeGames[gameId];
  }, 5000);
}

// Socket connections
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  
  // Send current lobby timer
  socket.emit('lobbyTimer', { time: globalLobbyTimer });
  
  // Player joins match
  socket.on('joinMatch', (data) => {
    const player = {
      id: socket.id,
      socket: socket,
      username: data.username || `Player${Date.now().toString().slice(-4)}`
    };
    
    waitingPlayers.push(player);
    socket.emit('joinedLobby', { message: 'Waiting for match to start...' });
  });
  
  // Player answers question
  socket.on('submitAnswer', (data) => {
    const { gameId, answer } = data;
    const game = activeGames[gameId];
    
    if (!game || !game.isActive) return;
    
    const question = game.questions[game.currentQuestion];
    const isCorrect = answer === question.correct;
    
    if (isCorrect) {
      game.scores[socket.id]++;
    }
    
    // Send feedback to player
    socket.emit('answerFeedback', {
      isCorrect: isCorrect,
      correctAnswer: question.correct,
      score: game.scores[socket.id]
    });
    
    // Send next question immediately
    game.currentQuestion++;
    setTimeout(() => {
      sendQuestion(gameId);
    }, 1000);
  });
  
  // Get current stats
  socket.on('getStats', () => {
    socket.emit('stats', {
      waitingPlayers: waitingPlayers.length,
      activeGames: Object.keys(activeGames).length
    });
  });
  
  // Disconnect handler
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    
    // Remove from waiting players
    waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
    
    // Handle active games
    for (const gameId in activeGames) {
      const game = activeGames[gameId];
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        // End game if player disconnects
        io.to(gameId).emit('playerDisconnected', {
          message: 'Opponent disconnected. You win!'
        });
        delete activeGames[gameId];
      }
    }
  });
});

// API Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Quiz Battle Server Running!',
    status: 'active',
    waitingPlayers: waitingPlayers.length,
    activeGames: Object.keys(activeGames).length
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Quiz Battle Server running on port ${PORT}`);
});
