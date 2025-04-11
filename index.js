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

// Carrega os níveis (5 níveis desafiadores)
let levels;
try {
  levels = JSON.parse(fs.readFileSync('levels.json', 'utf8')).levels;
} catch (err) {
  console.error("Erro ao carregar levels.json:", err);
  process.exit(1);
}

// Estado global do jogo
let currentLevelIndex = 0;
let currentLevel = levels[currentLevelIndex];
let currentCode = ""; // código colaborativo atual
let levelStartTime = Date.now();

// Se o nível usa inputs para a função init, escolhe um par aleatório
if (currentLevel.inputs) {
  const idx = Math.floor(Math.random() * currentLevel.inputs.length);
  currentLevel.chosenInput = currentLevel.inputs[idx];
  currentLevel.chosenExpectedOutput = currentLevel.expectedOutputs[idx];
}

// ----- Lógica de Turnos (servidor controla o cronômetro do turno) -----
const TURN_TIME = 60; // segundos por turno
let players = []; // Array de socket.id dos jogadores conectados
let currentTurnIndex = 0;
let turnStartTime = Date.now();
let turnInterval = null;

// Função que envia o tempo restante do turno a cada segundo
function broadcastTurnTimer() {
  const elapsed = Math.floor((Date.now() - turnStartTime) / 1000);
  const remaining = Math.max(0, TURN_TIME - elapsed);
  io.emit('turnTimerUpdate', remaining);
  if (remaining <= 0) nextTurn();
}

// Inicia o turno do jogador atual
function startTurn() {
  if (players.length === 0) return;
  currentTurnIndex = currentTurnIndex % players.length;
  const currentTurnID = players[currentTurnIndex];
  turnStartTime = Date.now();
  io.emit('turnUpdate', currentTurnID);
  // Inicia o intervalo do cronômetro de turno
  if (turnInterval) clearInterval(turnInterval);
  turnInterval = setInterval(broadcastTurnTimer, 1000);
}

// Passa a vez para o próximo jogador
function nextTurn() {
  if (players.length === 0) return;
  currentTurnIndex = (currentTurnIndex + 1) % players.length;
  startTurn();
}

// Cronômetro global do nível (enviado a cada segundo)
setInterval(() => {
  const elapsed = Date.now() - levelStartTime;
  io.emit('globalTimerUpdate', elapsed);
}, 1000);

// Função para verificação rigorosa do output
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

// Socket.io: gerencia conexões, colaboração, turnos e submissões
io.on('connection', socket => {
  console.log("Cliente conectado:", socket.id);
  
  // Envia o ID do cliente para uso local
  socket.emit('yourID', socket.id);
  
  // Adiciona o jogador se ainda não estiver na lista
  if (!players.includes(socket.id)) {
    players.push(socket.id);
    if (players.length === 1) startTurn();
  }
  
  // Envia estado completo (código, nível, tempo global) ao novo cliente
  socket.emit('stateUpdate', {
    currentCode,
    currentLevel,
    globalElapsed: Date.now() - levelStartTime
  });
  
  // Atualização colaborativa: só o jogador da vez pode alterar o código
  socket.on('codeUpdate', newCode => {
    const currentTurnID = players[currentTurnIndex];
    if (socket.id === currentTurnID) {
      currentCode = newCode;
      socket.broadcast.emit('codeUpdate', currentCode);
    }
  });
  
  // Permite ao jogador da vez passar a vez manualmente
  socket.on('passTurn', () => {
    const currentTurnID = players[currentTurnIndex];
    if (socket.id === currentTurnID) nextTurn();
  });
  
  // Reset do nível: reinicia código e cronômetro global
  socket.on('resetGame', () => {
    currentCode = "";
    levelStartTime = Date.now();
    io.emit('codeUpdate', currentCode);
    io.emit('globalTimerReset');
  });
  
  // Submissão do código: o servidor executa o código e verifica a saída
  socket.on('submitCode', () => {
    let codeToRun = currentCode;
    // Se o nível usa inputs para a função init(), insere a chamada com o input escolhido
    if (currentLevel.inputs) {
      if (!currentLevel.chosenInput) {
        const idx = Math.floor(Math.random() * currentLevel.inputs.length);
        currentLevel.chosenInput = currentLevel.inputs[idx];
        currentLevel.chosenExpectedOutput = currentLevel.expectedOutputs[idx];
      }
      const args = currentLevel.chosenInput.join(", ");
      codeToRun += `\nprint(init(${args}))`;
    }
    const tempFile = `temp_${uuidv4()}.py`;
    fs.writeFileSync(tempFile, codeToRun);
    exec(`python3 ${tempFile}`, { timeout: 5000 }, (error, stdout, stderr) => {
      fs.unlinkSync(tempFile);
      if (error) {
        socket.emit('submissionResult', { success: false, message: stderr || error.message });
      } else {
        const output = stdout.trim();
        const expected = currentLevel.inputs ? currentLevel.chosenExpectedOutput : currentLevel.expectedValue;
        if (verifyOutput(output, currentLevel.expectedType, expected)) {
          const timeTaken = Date.now() - levelStartTime;
          const codeLength = currentCode.length;
          // Score: quanto mais rápido e conciso, maior o score (exemplo simples)
          const score = Math.max(0, Math.floor(10000 - timeTaken / 10 - codeLength));
          io.emit('submissionResult', { success: true, message: `Nível ${currentLevel.id} completado em ${(timeTaken/1000).toFixed(1)}s! Score: ${score}` });
          // Avança para o próximo nível ou finaliza o jogo
          if (currentLevelIndex < levels.length - 1) {
            currentLevelIndex++;
            currentLevel = levels[currentLevelIndex];
            if (currentLevel.inputs) {
              const idx = Math.floor(Math.random() * currentLevel.inputs.length);
              currentLevel.chosenInput = currentLevel.inputs[idx];
              currentLevel.chosenExpectedOutput = currentLevel.expectedOutputs[idx];
            }
            currentCode = "";
            levelStartTime = Date.now();
            io.emit('stateUpdate', {
              currentCode,
              currentLevel,
              globalElapsed: 0
            });
          } else {
            io.emit('gameComplete', "Parabéns, todos os níveis foram completados!");
          }
        } else {
          socket.emit('submissionResult', { success: false, message: `Saída incorreta. Esperado (${currentLevel.expectedType}): ${expected}, obtido: ${output}` });
        }
      }
    });
  });
  
  // Em caso de desconexão, remove o jogador e ajusta o turno
  socket.on('disconnect', () => {
    console.log("Cliente desconectado:", socket.id);
    players = players.filter(id => id !== socket.id);
    if (players.length === 0) {
      if (turnInterval) clearInterval(turnInterval);
    } else if (socket.id === players[currentTurnIndex]) {
      nextTurn();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});