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

// Carrega os níveis (apenas 5 níveis desafiadores)
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
let currentCode = ""; // Código colaborativo compartilhado
let levelStartTime = Date.now();

// Se o nível requer inputs para a função init(), escolhe aleatoriamente um par input/output
if (currentLevel.inputs) {
  const idx = Math.floor(Math.random() * currentLevel.inputs.length);
  currentLevel.chosenInput = currentLevel.inputs[idx];
  currentLevel.chosenExpectedOutput = currentLevel.expectedOutputs[idx];
}

// --- Lógica de Turnos ---
const TURN_TIME = 60; // 60 segundos por turno
let players = []; // IDs dos jogadores conectados
let currentTurnIndex = 0;
let turnTimer = null;

function startTurn() {
  if (players.length > 0) {
    currentTurnIndex = currentTurnIndex % players.length;
    const currentTurnID = players[currentTurnIndex];
    io.emit('turnUpdate', currentTurnID);
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      nextTurn();
    }, TURN_TIME * 1000);
  }
}

function nextTurn() {
  currentTurnIndex = (currentTurnIndex + 1) % players.length;
  startTurn();
}

// --- Cronômetro Global do Nível ---
setInterval(() => {
  const elapsed = Date.now() - levelStartTime;
  io.emit('timerUpdate', elapsed);
}, 1000);

// Função de verificação do output (compara tipo e valor)
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

// Socket.io: gerencia conexão, turnos, colaboração e submissões
io.on('connection', socket => {
  console.log("Cliente conectado:", socket.id);
  // Envia o seu ID para o cliente
  socket.emit('yourID', socket.id);
  
  // Adiciona o jogador à lista (caso não esteja)
  if (!players.includes(socket.id)) {
    players.push(socket.id);
    if (players.length === 1) startTurn(); // Se for o primeiro, inicia o turno
  }
  
  // Envia o estado atual (código, nível, tempo) para o novo cliente
  socket.emit('stateUpdate', {
    currentCode,
    currentLevel,
    elapsedTime: Date.now() - levelStartTime
  });
  
  // Recebe atualizações do código (somente se for a vez do jogador)
  socket.on('codeUpdate', newCode => {
    const currentTurnID = players[currentTurnIndex];
    if (socket.id === currentTurnID) {
      currentCode = newCode;
      socket.broadcast.emit('codeUpdate', currentCode);
    }
  });
  
  // Evento para passar a vez manualmente
  socket.on('passTurn', () => {
    const currentTurnID = players[currentTurnIndex];
    if (socket.id === currentTurnID) {
      nextTurn();
    }
  });
  
  // Evento para reset: reinicia o código e o cronômetro do nível
  socket.on('resetGame', () => {
    currentCode = "";
    levelStartTime = Date.now();
    io.emit('codeUpdate', currentCode);
    io.emit('timerReset');
  });
  
  // Submissão do código para validação
  socket.on('submitCode', () => {
    let codeToRun = currentCode;
    // Se o nível utiliza a função init com inputs, insere a chamada com o input escolhido
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
          // Exemplo de score: pontuação baseada em tempo e tamanho do código
          const score = Math.max(0, Math.floor(10000 - timeTaken/10 - currentCode.length));
          io.emit('submissionResult', { success: true, message: `Nível ${currentLevel.id} completado em ${(timeTaken/1000).toFixed(1)}s! Score: ${score}` });
          // Avança para o próximo nível se houver
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
              elapsedTime: 0
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
  
  socket.on('disconnect', () => {
    console.log("Cliente desconectado:", socket.id);
    players = players.filter(id => id !== socket.id);
    if (players.length === 0 && turnTimer) clearTimeout(turnTimer);
    else if (socket.id === players[currentTurnIndex]) nextTurn();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});