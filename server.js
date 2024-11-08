const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const logger = require('./utils/logger');
const { ValidationError, GameStateError } = require('./utils/errors');

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = 3000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const users = new Map();
const games = new Map();
const waitingPlayers = new Set();

// Rate limiter: 100 connections per IP per minute
const rateLimiter = new RateLimiterMemory({
  points: 100,
  duration: 60
});

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', async (ws, req) => {
    try {
      const ip = req.socket.remoteAddress;
      await rateLimiter.consume(ip);

      const userId = uuidv4();
      logger.info('Client connected', { userId, ip });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          handleMessage(ws, userId, message);
        } catch (err) {
          logger.error('Error handling message:', err);
        }
      });

      ws.on('close', () => handleDisconnect(userId));

      // Send initial connection success and start finding opponent
      ws.send(JSON.stringify({
        type: 'connected',
        userId: userId
      }));

      // Automatically start finding opponent after connection
      setTimeout(() => {
        findGame(userId);
      }, 1000); // Give a second for registration to complete
    } catch (err) {
      if (err instanceof Error) {
        logger.error('Connection error', { error: err.message });
      }
      ws.close();
    }
  });

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});

function handleMessage(ws, userId, message) {
  try {
    switch (message.type) {
      case 'register':
        if (!message.username) {
          throw new Error('Username is required');
        }
        registerUser(ws, userId, message.username);
        findGame(userId);
        break;

      case 'findGame':
        findGame(userId);
        break;

      case 'move':
        validateMove(message.row, message.col);
        handleMove(userId, message.row, message.col);
        break;

      default:
        throw new Error('Unknown message type');
    }
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'error',
      message: error.message
    }));
  }
}

function registerUser(ws, userId, username) {
  users.set(userId, { ws, username, status: 'online' });
  broadcastUserCount();
}

function handleDisconnect(userId) {
  if (users.has(userId)) {
    users.delete(userId);
    waitingPlayers.delete(userId);
    broadcastUserCount();
  }
}

function broadcastUserCount() {
  const count = users.size;
  for (const user of users.values()) {
    user.ws.send(JSON.stringify({
      type: 'userCount',
      count
    }));
  }
}

function logWaitingPlayers() {
  const waitingList = Array.from(waitingPlayers).map(id => {
    const user = users.get(id);
    return {
      userId: id,
      username: user ? user.username : 'Unknown'
    };
  });

  logger.info('Current waiting players:', { waitingList });
  console.log('\nWaiting Players:', waitingList);
}

function findGame(userId) {
  const user = users.get(userId);
  if (!user) return;

  // Send initial searching message
  user.ws.send(JSON.stringify({
    type: 'searching',
    message: 'Finding opponent...'
  }));

  if (waitingPlayers.size > 0) {
    // Match with first waiting player
    const opponentId = Array.from(waitingPlayers)[0];
    waitingPlayers.delete(opponentId);

    const opponent = users.get(opponentId);
    if (!opponent) return;

    const gameId = uuidv4();

    // Create new game session
    games.set(gameId, {
      id: gameId,
      players: [userId, opponentId],
      currentTurn: userId,
      board: Array(3).fill(null).map(() => Array(3).fill(null))
    });

    // Notify both players about game start
    user.ws.send(JSON.stringify({
      type: 'gameStart',
      gameId,
      opponent: opponent.username,
      symbol: 'X'
    }));

    opponent.ws.send(JSON.stringify({
      type: 'gameStart',
      gameId,
      opponent: user.username,
      symbol: 'O'
    }));
  } else {
    // Add to waiting queue
    waitingPlayers.add(userId);
    logger.info('Player added to waiting list', { userId });
    logWaitingPlayers(); // Log updated state

    // Set timeout to check if opponent found
    setTimeout(() => {
      if (waitingPlayers.has(userId)) {
        user.ws.send(JSON.stringify({
          type: 'searchTimeout',
          message: 'No opponents available at the moment. Please try again later.'
        }));
        waitingPlayers.delete(userId);
        logger.info('Player removed from waiting list (timeout)', { userId });
        logWaitingPlayers(); // Log final state
      }
    }, 10000);
  }
}

function handleMove(userId, row, col) {
  // Find user's active game
  const game = Array.from(games.values()).find(g => g.players.includes(userId));
  if (!game || game.currentTurn !== userId) return;

  const symbol = game.players[0] === userId ? 'X' : 'O';
  game.board[row][col] = symbol;

  // Switch turns
  game.currentTurn = game.players.find(id => id !== userId);

  // Broadcast move to both players
  game.players.forEach(playerId => {
    const player = users.get(playerId);
    player.ws.send(JSON.stringify({
      type: 'move',
      row,
      col,
      symbol,
      nextTurn: game.currentTurn === playerId
    }));
  });
}

// Input validation
function validateUsername(username) {
  if (!username || username.length < 3 || username.length > 20) {
    throw new ValidationError('Username must be between 3 and 20 characters');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    throw new ValidationError('Username can only contain letters, numbers and underscores');
  }
}

function validateMove(row, col) {
  if (typeof row !== 'number' || typeof col !== 'number' ||
      row < 0 || row > 2 || col < 0 || col > 2) {
    throw new ValidationError('Invalid move coordinates');
  }
}