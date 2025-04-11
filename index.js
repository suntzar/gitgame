const express = require('express');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Carrega os níveis – observe que nos níveis a função a ser implementada é test()
let levels;
try {
  levels = JSON.parse(fs.readFileSync('levels.json', 'utf8')).levels;
} catch (err) {
  console.error("Erro ao carregar levels.json:", err);
  process.exit(1);
}

// Estrutura para gerenciar salas: cada chave é o nome da sala
let rooms = {};

/* Função para criar uma nova sala.
   data = { roomName, password (opcional), hostName, turnTime }
*/
function createRoom(data, socket) {
  const { roomName, password, hostName, turnTime } = data;
  if (rooms[roomName]) {
    socket.emit('roomError', { message: "Nome de sala já existe." });
    return;
  }
  // Cria o objeto sala com propriedades iniciais
  rooms[roomName] = {
    roomName,
    password: password || null,
    hostName,
    turnTime: parseInt(turnTime) || 60,
    players: [], // cada jogador: { id, name }
    currentTurnIndex: 0,
    currentLevelIndex: 0,
    currentLevel: levels[0],
    currentCode: "",
    levelStartTime: Date.now(),
    turnStartTime: Date.now(),
    turnInterval: null
  };
  // O host entra na sala
  joinRoom({ roomName, playerName: hostName, password }, socket);
}

/* Função para que um jogador entre em uma sala.
   data = { roomName, playerName, password (se necessário) }
*/
function joinRoom(data, socket) {
  const { roomName, playerName, password } = data;
  const room = rooms[roomName];
  if (!room) {
    socket.emit('roomError', { message: "Sala não encontrada." });
    return;
  }
  if (room.password && room.password !== password) {
    socket.emit('roomError', { message: "Senha incorreta." });
    return;
  }
  // Adiciona o jogador à sala, se ainda não estiver
  if (!room.players.find(p => p.id === socket.id)) {
    room.players.push({ id: socket.id, name: playerName });
    socket.join(roomName);
    // Informa a todos na sala que um novo jogador entrou
    io.to(roomName).emit('roomUpdate', { room, players: room.players });
  }
  // Envia o estado do jogo para este jogador
  socket.emit('stateUpdate', {
    currentCode: room.currentCode,
    currentLevel: room.currentLevel,
    globalElapsed: Date.now() - room.levelStartTime,
    roomName: room.roomName,
    turnTime: room.turnTime
  });
}

/* Lógica de turnos por sala */
function startTurn(room) {
  if (room.players.length === 0) return;
  room.currentTurnIndex = room.currentTurnIndex % room.players.length;
  const currentTurnID = room.players[room.currentTurnIndex].id;
  room.turnStartTime = Date.now();
  io.to(room.roomName).emit('turnUpdate', currentTurnID);
  if (room.turnInterval) clearInterval(room.turnInterval);
  room.turnInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - room.turnStartTime) / 1000);
    const remaining = Math.max(0, room.turnTime - elapsed);
    io.to(room.roomName).emit('turnTimerUpdate', remaining);
    if (remaining <= 0) nextTurn(room);
  }, 1000);
}

function nextTurn(room) {
  if (room.players.length === 0) return;
  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
  startTurn(room);
}

// Cronômetro global do nível (para cada sala, enviado a cada segundo)
function startGlobalTimer(room) {
  setInterval(() => {
    const elapsed = Date.now() - room.levelStartTime;
    io.to(room.roomName).emit('globalTimerUpdate', elapsed);
  }, 1000);
}

// Função para verificação do output (tipo e valor)
function verifyOutput(output, expectedType, expectedValue) {
  if (expectedType === "number") {
    const num = Number(output);
    if (isNaN(num)) return false;
    return num === expectedValue;
  } else if (expectedType === "boolean") {
    const boolVal = output.trim().toLowerCase();
    return (expectedValue === true && boolVal === "true") ||
           (expectedValue === false && boolVal === "false");
  } else if (expectedType === "string") {
    return output === expectedValue;
  } else {
    return output === expectedValue;
  }
}

// Socket.io: eventos para criação de sala, entrada e ações do jogo
io.on('connection', socket => {
  console.log("Cliente conectado:", socket.id);
  
  // O cliente pode criar uma sala:
  // Dados: { roomName, password, hostName, turnTime }
  socket.on('createRoom', data => {
    createRoom(data, socket);
  });
  
  // O cliente pode entrar em uma sala:
  // Dados: { roomName, playerName, password }
  socket.on('joinRoom', data => {
    joinRoom(data, socket);
  });
  
  // Evento para atualização colaborativa do código dentro da sala.
  // Dados: { roomName, newCode }
  socket.on('codeUpdate', data => {
    const { roomName, newCode } = data;
    const room = rooms[roomName];
    if (!room) return;
    // Apenas o jogador da vez pode enviar alterações.
    const currentTurnID = room.players[room.currentTurnIndex].id;
    if (socket.id === currentTurnID) {
      room.currentCode = newCode;
      socket.broadcast.to(roomName).emit('codeUpdate', newCode);
    }
  });
  
  // Evento para passar a vez
  // Dados: { roomName }
  socket.on('passTurn', data => {
    const { roomName } = data;
    const room = rooms[roomName];
    if (!room) return;
    const currentTurnID = room.players[room.currentTurnIndex].id;
    if (socket.id === currentTurnID) nextTurn(room);
  });
  
  // Reset do nível (código e cronômetro) para a sala
  // Dados: { roomName }
  socket.on('resetGame', data => {
    const { roomName } = data;
    const room = rooms[roomName];
    if (!room) return;
    room.currentCode = "";
    room.levelStartTime = Date.now();
    io.to(roomName).emit('codeUpdate', room.currentCode);
    io.to(roomName).emit('globalTimerReset');
  });
  
  // Submissão do código para validação.
  // Dados: { roomName }
  socket.on('submitCode', data => {
    const { roomName } = data;
    const room = rooms[roomName];
    if (!room) return;
    let codeToRun = room.currentCode;
    // Se o nível usa inputs (para a função test), insere a chamada com o input escolhido.
    if (room.currentLevel.inputs) {
      if (!room.currentLevel.chosenInput) {
        const idx = Math.floor(Math.random() * room.currentLevel.inputs.length);
        room.currentLevel.chosenInput = room.currentLevel.inputs[idx];
        room.currentLevel.chosenExpectedOutput = room.currentLevel.expectedOutputs[idx];
      }
      const args = room.currentLevel.chosenInput.join(", ");
      codeToRun += `\nprint(test(${args}))`;
    }
    const tempFile = `temp_${uuidv4()}.py`;
    fs.writeFileSync(tempFile, codeToRun);
    exec(`python3 ${tempFile}`, { timeout: 5000 }, (error, stdout, stderr) => {
      fs.unlinkSync(tempFile);
      if (error) {
        socket.emit('submissionResult', { success: false, message: stderr || error.message });
      } else {
        const output = stdout.trim();
        const expected = room.currentLevel.inputs ? room.currentLevel.chosenExpectedOutput : room.currentLevel.expectedValue;
        if (verifyOutput(output, room.currentLevel.expectedType, expected)) {
          const timeTaken = Date.now() - room.levelStartTime;
          const codeLength = room.currentCode.length;
          const score = Math.max(0, Math.floor(10000 - timeTaken / 10 - codeLength));
          io.to(roomName).emit('submissionResult', { success: true, message: `Nível ${room.currentLevel.id} completado em ${(timeTaken/1000).toFixed(1)}s! Score: ${score}` });
          // Avança para o próximo nível ou finaliza se for o último
          if (room.currentLevelIndex < levels.length - 1) {
            room.currentLevelIndex++;
            room.currentLevel = levels[room.currentLevelIndex];
            if (room.currentLevel.inputs) {
              const idx = Math.floor(Math.random() * room.currentLevel.inputs.length);
              room.currentLevel.chosenInput = room.currentLevel.inputs[idx];
              room.currentLevel.chosenExpectedOutput = room.currentLevel.expectedOutputs[idx];
            }
            room.currentCode = "";
            room.levelStartTime = Date.now();
            io.to(roomName).emit('stateUpdate', {
              currentCode: room.currentCode,
              currentLevel: room.currentLevel,
              globalElapsed: 0,
              roomName,
              turnTime: room.turnTime
            });
          } else {
            io.to(roomName).emit('gameComplete', "Parabéns, todos os níveis foram completados!");
          }
        } else {
          socket.emit('submissionResult', { success: false, message: `Saída incorreta. Esperado (${room.currentLevel.expectedType}): ${expected}, obtido: ${output}` });
        }
      }
    });
  });
  
  // Trata a desconexão: remove o jogador da sala e, se necessário, passa a vez
  socket.on('disconnect', () => {
    console.log("Cliente desconectado:", socket.id);
    for (const roomName in rooms) {
      const room = rooms[roomName];
      room.players = room.players.filter(p => p.id !== socket.id);
      io.to(roomName).emit('roomUpdate', { room, players: room.players });
      if (room.players.length === 0) {
        // Se a sala ficar vazia, pode ser removida
        if (room.turnInterval) clearInterval(room.turnInterval);
        delete rooms[roomName];
      } else if (socket.id === room.players[room.currentTurnIndex]?.id) {
        nextTurn(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});